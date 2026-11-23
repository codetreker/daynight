package session

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const archiveStreamIdleTimeout = 30 * time.Second
const archiveStreamTotalTimeout = 30 * time.Minute

type archiveStreamOperation interface {
	PutArchiveFileV2(context.Context, string, string, int64, int64, string, io.Reader) (sp.ArchiveFileReceipt, error)
	PutArchiveResourceV2(context.Context, string, int64, int64, string, io.Reader, sp.Resource) (sp.ArchiveFileReceipt, error)
	CompleteArchiveFile(context.Context, string, string) (sp.ArchiveFileReceipt, error)
	RestartArchiveFile(context.Context, string, string, string) (sp.ArchiveFileReceipt, error)
}

type archiveLimitedStream struct {
	*io.LimitedReader
	body *httpx.DeadlineBody
}

func (s *archiveLimitedStream) BindReadContext(ctx context.Context) func() error {
	return s.body.BindReadContext(ctx)
}

func (h *Routes) putArchiveStream(w http.ResponseWriter, r *http.Request, p model.Principal, purpose string) {
	values, err := httpx.QueryValues(r, "offset", "purpose", "migrationOnly")
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	offset, e1 := strconv.ParseInt(values.Get("offset"), 10, 64)
	length, e2 := strconv.ParseInt(r.Header.Get("Daynight-File-Byte-Length"), 10, 64)
	resource := purpose == "timeline" && values.Get("purpose") == "resource" && values.Get("migrationOnly") == "true"
	limit := int64(sp.MaxArchiveTimelineBytes)
	if purpose == "history" {
		limit = sp.MaxArchiveHistoryBytes
	}
	if resource {
		limit = sp.MaxArchiveBlobBytes
	}
	media, parameters, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if e1 != nil || e2 != nil || offset < 0 || length < 0 || length > limit || offset > length || length == 0 && !resource ||
		strconv.FormatInt(offset, 10) != values.Get("offset") || strconv.FormatInt(length, 10) != r.Header.Get("Daynight-File-Byte-Length") ||
		len(r.Header.Values("Daynight-File-Byte-Length")) != 1 || len(r.Header.Values("Daynight-File-SHA256")) != 1 ||
		len(r.Header.Values("Daynight-Chunk-SHA256")) != 0 || r.ContentLength != length-offset ||
		len(r.TransferEncoding) != 0 || len(r.Header.Values("Content-Type")) != 1 || len(r.Header.Values("Content-Encoding")) != 0 ||
		mediaErr != nil || media != "application/octet-stream" || len(parameters) != 0 ||
		!resource && (values.Get("purpose") != "" || values.Get("migrationOnly") != "") {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, httpx.InvalidInput("Invalid streaming archive request."))
		return
	}
	var descriptor sp.Resource
	if resource {
		if len(r.Header.Values("Daynight-Resource-Descriptor")) != 1 {
			httpx.CloseUnreadBody(w, r)
			h.Failure(w, r, httpx.InvalidInput("Invalid legacy resource descriptor."))
			return
		}
		descriptor, err = sp.DecodeResource([]byte(r.Header.Get("Daynight-Resource-Descriptor")))
		if err != nil {
			httpx.CloseUnreadBody(w, r)
			h.Failure(w, r, httpx.InvalidInput("Invalid legacy resource descriptor."))
			return
		}
	}
	op, err := h.beginUnifiedArchive(w, r, p)
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	streamOp, ok := op.(archiveStreamOperation)
	if !ok {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, archiveCleanupError(httpx.InvalidInput("Streaming archive is unavailable."), op.Close()))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), archiveStreamTotalTimeout)
	timedRequest := r.WithContext(ctx)
	readRequest, finishRead := archiveReadRequest(timedRequest, op)
	stream := httpx.NewStreamingDeadlineBody(w, readRequest, archiveStreamIdleTimeout, archiveStreamTotalTimeout)
	limited := &archiveLimitedStream{LimitedReader: &io.LimitedReader{R: stream, N: length - offset}, body: stream}
	var out sp.ArchiveFileReceipt
	if resource {
		out, err = streamOp.PutArchiveResourceV2(readRequest.Context(), r.PathValue("fileId"), offset, length, r.Header.Get("Daynight-File-SHA256"), limited, descriptor)
	} else {
		out, err = streamOp.PutArchiveFileV2(readRequest.Context(), purpose, r.PathValue("fileId"), offset, length, r.Header.Get("Daynight-File-SHA256"), limited)
	}
	if err == nil && limited.N != 0 {
		err = httpx.InvalidInput("Incomplete streaming archive body.")
	}
	if err == nil {
		var extra [1]byte
		n, readErr := stream.Read(extra[:])
		if n != 0 || readErr != io.EOF {
			if readErr != nil && readErr != io.EOF {
				err = readErr
			} else {
				err = httpx.InvalidInput("Archive body exceeds its declared length.")
			}
		}
	}
	if err != nil {
		httpx.CloseUnreadBody(w, readRequest)
	}
	err = archiveCleanupError(err, stream.Close())
	finishRead()
	r.Body = timedRequest.Body
	cancel()
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		// A forced socket deadline can cancel net/http's request context while
		// the peer is still connected. Returning without a response would make
		// net/http synthesize a misleading empty 200.
		if r.Context().Err() != nil {
			panic(http.ErrAbortHandler)
		}
		return
	}
	if r.Context().Err() != nil {
		h.closeArchive(r, op)
		panic(http.ErrAbortHandler)
	}
	w.Header().Set("Daynight-Archive-Upload-Version", "2")
	if purpose == "history" {
		h.archiveResult(w, r, historyFileResponse(out), op)
	} else {
		h.archiveResult(w, r, out, op)
	}
}

func (h *Routes) completeArchiveHistory(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.archiveStreamAction(w, r, p, "history", false)
}
func (h *Routes) restartArchiveHistory(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.archiveStreamAction(w, r, p, "history", true)
}
func (h *Routes) completeArchiveTimeline(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.archiveStreamAction(w, r, p, "timeline", false)
}
func (h *Routes) restartArchiveTimeline(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.archiveStreamAction(w, r, p, "timeline", true)
}

func (h *Routes) archiveStreamAction(w http.ResponseWriter, r *http.Request, p model.Principal, purpose string, restart bool) {
	if _, err := httpx.QueryValues(r); err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	if len(r.Header.Values("Daynight-Archive-Upload-Version")) != 1 || r.Header.Get("Daynight-Archive-Upload-Version") != "2" || !restart && r.ContentLength != 0 {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, httpx.InvalidInput("Invalid archive action."))
		return
	}
	op, err := h.beginUnifiedArchive(w, r, p)
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	streamOp, ok := op.(archiveStreamOperation)
	if !ok {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, archiveCleanupError(httpx.InvalidInput("Streaming archive is unavailable."), op.Close()))
		return
	}
	var out sp.ArchiveFileReceipt
	if restart {
		request, finish := archiveReadRequest(r, op)
		body, readErr := readUnifiedArchiveBody(w, request, "application/json", 4096, false)
		finish()
		if readErr != nil {
			h.Failure(w, r, archiveCleanupError(readErr, op.Close()))
			return
		}
		var input struct {
			ReplacementFileID string `json:"replacementFileId"`
		}
		decoder := json.NewDecoder(strings.NewReader(string(body)))
		decoder.DisallowUnknownFields()
		readErr = decoder.Decode(&input)
		if readErr == nil {
			var trailing any
			if decoder.Decode(&trailing) != io.EOF {
				readErr = httpx.InvalidInput("Invalid archive restart.")
			}
		}
		id, idErr := model.CanonicalID(input.ReplacementFileID)
		if readErr != nil || idErr != nil || id != input.ReplacementFileID {
			h.Failure(w, r, archiveCleanupError(httpx.InvalidInput("Invalid archive restart."), op.Close()))
			return
		}
		out, err = streamOp.RestartArchiveFile(r.Context(), purpose, r.PathValue("fileId"), input.ReplacementFileID)
	} else {
		out, err = streamOp.CompleteArchiveFile(r.Context(), purpose, r.PathValue("fileId"))
	}
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	w.Header().Set("Daynight-Archive-Upload-Version", "2")
	if purpose == "history" {
		h.archiveResult(w, r, historyFileResponse(out), op)
	} else {
		h.archiveResult(w, r, out, op)
	}
}

func (h *Routes) archiveCorrupt(w http.ResponseWriter, r *http.Request, receipt sp.ArchiveFileReceipt) {
	w.Header().Set("Daynight-Archive-Upload-Version", "2")
	var file any = receipt
	if containsHistoryPath(r.Pattern) {
		file = historyFileResponse(receipt)
	}
	h.Result(w, r, http.StatusConflict, map[string]any{"error": map[string]any{"code": "staging_corrupt", "message": "Archive staging is corrupt."}, "file": file}, nil)
}
