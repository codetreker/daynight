package session

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type unifiedArchiveOperation interface {
	archiveOperation
	PrepareArchive(context.Context, sp.ArchivePrepareRequest) (sp.ArchivePrepareReceipt, error)
	AppendArchiveSourceTail(context.Context, sp.ArchiveSourceTailRequest) (sp.ArchiveSourceTailReceipt, error)
	RecoverArchiveSourceTail(context.Context, sp.ArchiveSourceRecoveryRequest) (sp.ArchiveSourceRecoveryReceipt, error)
	PutArchiveFile(context.Context, string, string, int64, int64, string, string, []byte) (sp.ArchiveFileReceipt, error)
	PutArchiveResource(context.Context, string, int64, int64, string, string, []byte, sp.Resource) (sp.ArchiveFileReceipt, error)
	SealArchive(context.Context) (sp.ArchivePrepareReceipt, error)
	PutArchiveManifest(context.Context, []byte) (sp.ArchiveStatus, error)
}

func (h *Routes) registerUnifiedArchiveRoutes(mux httpx.RouteRegistrar, base string, observe func(ProducerRoute)) {
	for route, handler := range map[string]httpx.AuthenticatedHandler{
		"GET " + base + "/prepare":                            h.archivePreparation,
		"POST " + base + "/prepare":                           h.prepareArchive,
		"POST " + base + "/source-tail":                       h.archiveSourceTail,
		"POST " + base + "/source-tail/recover":               h.archiveSourceRecovery,
		"POST " + base + "/seal":                              h.sealArchive,
		"PUT " + base + "/content":                            h.putArchiveManifest,
		"PUT " + base + "/prepare/history/{fileId}":           h.putArchiveHistory,
		"GET " + base + "/prepare/history/{fileId}/status":    h.archiveBundleFileStatus,
		"PUT " + base + "/files/{fileId}":                     h.putArchiveTimeline,
		"GET " + base + "/files/{fileId}/status":              h.archiveBundleFileStatus,
		"GET " + base + "/files/{fileId}":                     h.archiveTimelineContent,
		"POST " + base + "/prepare/history/{fileId}/complete": h.completeArchiveHistory,
		"POST " + base + "/prepare/history/{fileId}/restart":  h.restartArchiveHistory,
		"POST " + base + "/files/{fileId}/complete":           h.completeArchiveTimeline,
		"POST " + base + "/files/{fileId}/restart":            h.restartArchiveTimeline,
	} {
		next := h.auth.Require(h.unifiedArchiveParameters(handler, route == "GET "+base+"/files/{fileId}"))
		if route[:3] != "GET" || route == "GET "+base+"/files/{fileId}" {
			next = h.archivePreflight(next, archiveVersionKnown)
		}
		if !strings.HasPrefix(route, "GET ") {
			registerProducerRoute(mux, route, next, producerCredential, observe)
		} else {
			mux.HandleFunc(route, next)
		}
	}
}
func (h *Routes) unifiedArchiveParameters(next httpx.AuthenticatedHandler, scopedRead bool) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		w.Header().Set("Daynight-Task-Body-History-Version", "1")
		protocol, err := selectedSessionProtocol(r)
		if err != nil || protocol != sp.Protocol {
			h.Failure(w, r, httpx.InvalidInput("Unified archives require the Session v1 protocol."))
			return
		}
		if raw := r.PathValue("fileId"); raw != "" {
			id, err := model.CanonicalID(raw)
			if err != nil || id != raw {
				h.Failure(w, r, httpx.InvalidInput("A canonical archive file identity is required."))
				return
			}
		}
		h.Parameters(next, scopedRead)(w, r, p)
	}
}
func (h *Routes) beginUnifiedArchive(w http.ResponseWriter, r *http.Request, p model.Principal) (unifiedArchiveOperation, error) {
	op, err := h.service.BeginArchiveReserved(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), sessioncore.ArchiveV1Upload, archiveReservation(r))
	if err != nil {
		return nil, err
	}
	unified, ok := op.(unifiedArchiveOperation)
	if !ok {
		_ = op.Close()
		return nil, httpx.InvalidInput("Unified archive is unavailable.")
	}
	return unified, nil
}
func readUnifiedArchiveBody(w http.ResponseWriter, r *http.Request, kind string, limit int64, allowEmpty bool) (body []byte, result error) {
	media, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || len(r.Header.Values("Content-Type")) != 1 || len(r.Header.Values("Content-Encoding")) != 0 || media != kind || len(parameters) > 1 || len(parameters) == 1 && parameters["charset"] == "" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") {
		httpx.CloseUnreadBody(w, r)
		return nil, httpx.InvalidInput("Invalid archive content type.")
	}
	stream := httpx.NewDeadlineBody(w, r, 15*time.Second)
	defer func() { result = archiveCleanupError(result, stream.Close()) }()
	body, err = io.ReadAll(http.MaxBytesReader(w, stream, limit))
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, &httpx.BodyReadError{Cause: err, Status: http.StatusRequestEntityTooLarge, Code: "payload_too_large", Message: "Archive request exceeds its byte limit."}
		}
		return nil, err
	}
	if len(body) == 0 && !allowEmpty {
		return nil, httpx.InvalidInput("Archive body is empty.")
	}
	return body, nil
}
func (h *Routes) archivePreparation(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	out, err := h.service.ArchivePreparation(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"))
	if err == nil && h.archiveUploadV2Enabled {
		w.Header().Set("Daynight-Archive-Upload-Version", "2")
	}
	h.Result(w, r, http.StatusOK, out, err)
}
func (h *Routes) prepareArchive(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	op, err := h.beginUnifiedArchive(w, r, p)
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	readRequest, finishRead := archiveReadRequest(r, op)
	body, err := readUnifiedArchiveBody(w, readRequest, "application/json", 32768, false)
	finishRead()
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	input, err := sp.DecodeArchivePrepareRequest(body)
	if err != nil {
		h.Failure(w, r, archiveCleanupError(httpx.InvalidInput("Invalid archive preparation."), op.Close()))
		return
	}
	out, err := op.PrepareArchive(r.Context(), input)
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	if h.archiveUploadV2Enabled {
		w.Header().Set("Daynight-Archive-Upload-Version", "2")
	}
	h.archiveResult(w, r, out, op)
}
func (h *Routes) sealArchive(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	if r.ContentLength != 0 {
		h.Failure(w, r, httpx.InvalidInput("Archive seal does not accept a body."))
		return
	}
	op, err := h.beginUnifiedArchive(w, r, p)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	out, err := op.SealArchive(r.Context())
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	h.archiveResult(w, r, out, op)
}
func (h *Routes) putArchiveManifest(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	op, err := h.beginUnifiedArchive(w, r, p)
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	readRequest, finishRead := archiveReadRequest(r, op)
	body, err := readUnifiedArchiveBody(w, readRequest, "application/json", sp.MaxArchiveManifestBytes, false)
	finishRead()
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	out, err := op.PutArchiveManifest(r.Context(), body)
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	h.archiveResult(w, r, map[string]any{"archive": out}, op)
}
func (h *Routes) putArchiveHistory(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.putArchiveBundleFile(w, r, p, "history")
}
func (h *Routes) putArchiveTimeline(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.putArchiveBundleFile(w, r, p, "timeline")
}
func (h *Routes) putArchiveBundleFile(w http.ResponseWriter, r *http.Request, p model.Principal, purpose string) {
	versions := r.Header.Values("Daynight-Archive-Upload-Version")
	if len(versions) > 1 || len(versions) == 1 && versions[0] != "1" && versions[0] != "2" {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, httpx.InvalidInput("Invalid archive upload version."))
		return
	}
	if len(versions) == 1 && versions[0] == "2" {
		h.putArchiveStream(w, r, p, purpose)
		return
	}
	values, err := httpx.QueryValues(r, "offset", "purpose", "migrationOnly")
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	offset, e1 := strconv.ParseInt(values.Get("offset"), 10, 64)
	length, e2 := strconv.ParseInt(r.Header.Get("Daynight-File-Byte-Length"), 10, 64)
	legacyResource := values.Get("purpose") == "resource" && values.Get("migrationOnly") == "true" && purpose == "timeline"
	if e1 != nil || e2 != nil || offset < 0 || length < 0 || length == 0 && !legacyResource || len(r.Header.Values("Daynight-File-Byte-Length")) != 1 || len(r.Header.Values("Daynight-File-SHA256")) != 1 || len(r.Header.Values("Daynight-Chunk-SHA256")) != 1 || strconv.FormatInt(offset, 10) != values.Get("offset") || strconv.FormatInt(length, 10) != r.Header.Get("Daynight-File-Byte-Length") {
		h.Failure(w, r, httpx.InvalidInput("Invalid archive offset or length."))
		return
	}
	op, err := h.beginUnifiedArchive(w, r, p)
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	readRequest, finishRead := archiveReadRequest(r, op)
	data, err := readUnifiedArchiveBody(w, readRequest, "application/octet-stream", 1048576, legacyResource && length == 0)
	finishRead()
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	var out sp.ArchiveFileReceipt
	if legacyResource {
		resource, parseErr := sp.DecodeResource([]byte(r.Header.Get("Daynight-Resource-Descriptor")))
		if parseErr != nil {
			h.Failure(w, r, archiveCleanupError(httpx.InvalidInput("Invalid legacy resource descriptor."), op.Close()))
			return
		}
		out, err = op.PutArchiveResource(r.Context(), r.PathValue("fileId"), offset, length, r.Header.Get("Daynight-File-SHA256"), r.Header.Get("Daynight-Chunk-SHA256"), data, resource)
	} else if values.Get("purpose") != "" || values.Get("migrationOnly") != "" {
		err = httpx.InvalidInput("Invalid archive migration profile.")
	} else {
		out, err = op.PutArchiveFile(r.Context(), purpose, r.PathValue("fileId"), offset, length, r.Header.Get("Daynight-File-SHA256"), r.Header.Get("Daynight-Chunk-SHA256"), data)
	}
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	if purpose == "history" {
		h.archiveResult(w, r, historyFileResponse(out), op)
	} else {
		h.archiveResult(w, r, out, op)
	}
}
func historyFileResponse(file sp.ArchiveFileReceipt) map[string]any {
	var revision *string
	if file.State == "complete" {
		revision = file.TimelineRevision
	}
	result := map[string]any{"syncId": file.FileID, "state": file.State, "acceptedOffset": file.AcceptedOffset, "byteLength": file.ByteLength, "sha256": file.SHA256, "timelineRevision": revision, "error": file.Error}
	if file.SuccessorFileID != nil {
		result["successorFileId"] = *file.SuccessorFileID
	}
	return result
}
func (h *Routes) archiveBundleFileStatus(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	out, err := h.service.ArchiveFileStatus(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("fileId"))
	if err != nil {
		// A wrapped observation may also carry an unconfirmed cleanup failure.
		// Only an unwrapped observation proves that its storage handle exited.
		if corrupt, ok := err.(*sessioncore.ArchiveStagingCorruptError); ok {
			h.archiveCorrupt(w, r, corrupt.Receipt)
			return
		}
		h.Failure(w, r, err)
		return
	}
	version := out.UploadVersion
	if version == 0 {
		version = 1
	}
	w.Header().Set("Daynight-Archive-Upload-Version", strconv.Itoa(version))
	if len(r.Pattern) > 0 && containsHistoryPath(r.Pattern) {
		h.Result(w, r, http.StatusOK, historyFileResponse(out), nil)
	} else {
		h.Result(w, r, http.StatusOK, out, nil)
	}
}
func containsHistoryPath(value string) bool {
	return strings.Contains(value, "/history/")
}
func (h *Routes) archiveTimelineContent(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	out, err := h.service.ArchiveTimelineContentReserved(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("fileId"), archiveReservation(r))
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	h.sendArchive(w, r, out.Data, 120*time.Second, out)
}

func (h *Routes) archiveSourceTail(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	op, err := h.beginUnifiedArchive(w, r, p)
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	readRequest, finishRead := archiveReadRequest(r, op)
	body, err := readUnifiedArchiveBody(w, readRequest, "application/json", sp.MaxArchiveSourceTailBytes, false)
	finishRead()
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	input, err := sp.DecodeArchiveSourceTail(body)
	if err != nil {
		h.Failure(w, r, archiveCleanupError(httpx.InvalidInput("Invalid archive source tail."), op.Close()))
		return
	}
	out, err := op.AppendArchiveSourceTail(r.Context(), input)
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	h.archiveResult(w, r, out, op)
}

func (h *Routes) archiveSourceRecovery(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	op, err := h.beginUnifiedArchive(w, r, p)
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	readRequest, finishRead := archiveReadRequest(r, op)
	body, err := readUnifiedArchiveBody(w, readRequest, "application/json", sp.MaxArchiveSourceTailBytes, false)
	finishRead()
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	input, err := sp.DecodeArchiveSourceRecovery(body)
	if err != nil {
		h.Failure(w, r, archiveCleanupError(httpx.InvalidInput("Invalid archive source recovery."), op.Close()))
		return
	}
	out, err := op.RecoverArchiveSourceTail(r.Context(), input)
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	h.archiveResult(w, r, out, op)
}
