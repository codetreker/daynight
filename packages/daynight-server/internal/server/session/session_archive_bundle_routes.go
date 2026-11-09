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
	PutArchiveFile(context.Context, string, string, int64, int64, string, string, []byte) (sp.ArchiveFileReceipt, error)
	PutArchiveResource(context.Context, string, int64, int64, string, string, []byte, sp.Resource) (sp.ArchiveFileReceipt, error)
	SealArchive(context.Context) (sp.ArchivePrepareReceipt, error)
	PutArchiveManifest(context.Context, []byte) (sp.ArchiveStatus, error)
}

func (h *Routes) registerUnifiedArchiveRoutes(mux *http.ServeMux, base string) {
	for route, handler := range map[string]httpx.AuthenticatedHandler{
		"GET " + base + "/prepare":                         h.archivePreparation,
		"POST " + base + "/prepare":                        h.prepareArchive,
		"POST " + base + "/source-tail":                    h.archiveSourceTail,
		"POST " + base + "/seal":                           h.sealArchive,
		"PUT " + base + "/content":                         h.putArchiveManifest,
		"PUT " + base + "/prepare/history/{fileId}":        h.putArchiveHistory,
		"GET " + base + "/prepare/history/{fileId}/status": h.archiveBundleFileStatus,
		"PUT " + base + "/files/{fileId}":                  h.putArchiveTimeline,
		"GET " + base + "/files/{fileId}/status":           h.archiveBundleFileStatus,
		"GET " + base + "/files/{fileId}":                  h.archiveTimelineContent,
	} {
		next := h.auth.Require(h.unifiedArchiveParameters(handler))
		if route[:3] != "GET" || route == "GET "+base+"/files/{fileId}" {
			next = h.archivePreflight(next)
		}
		mux.HandleFunc(route, next)
	}
}
func (h *Routes) unifiedArchiveParameters(next httpx.AuthenticatedHandler) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
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
		h.Parameters(next)(w, r, p)
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
func readUnifiedArchiveBody(w http.ResponseWriter, r *http.Request, kind string, limit int64) (body []byte, result error) {
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
	if len(body) == 0 {
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
	body, err := readUnifiedArchiveBody(w, r, "application/json", 32768)
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
	body, err := readUnifiedArchiveBody(w, r, "application/json", sp.MaxArchiveManifestBytes)
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
	values, err := httpx.QueryValues(r, "offset", "purpose", "migrationOnly")
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	offset, e1 := strconv.ParseInt(values.Get("offset"), 10, 64)
	length, e2 := strconv.ParseInt(r.Header.Get("Daynight-File-Byte-Length"), 10, 64)
	if e1 != nil || e2 != nil || offset < 0 || length < 1 || len(r.Header.Values("Daynight-File-Byte-Length")) != 1 || len(r.Header.Values("Daynight-File-SHA256")) != 1 || len(r.Header.Values("Daynight-Chunk-SHA256")) != 1 || strconv.FormatInt(offset, 10) != values.Get("offset") || strconv.FormatInt(length, 10) != r.Header.Get("Daynight-File-Byte-Length") {
		h.Failure(w, r, httpx.InvalidInput("Invalid archive offset or length."))
		return
	}
	op, err := h.beginUnifiedArchive(w, r, p)
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	data, err := readUnifiedArchiveBody(w, r, "application/octet-stream", 1048576)
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	var out sp.ArchiveFileReceipt
	if values.Get("purpose") == "resource" && values.Get("migrationOnly") == "true" && purpose == "timeline" {
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
	return map[string]any{"syncId": file.FileID, "state": file.State, "acceptedOffset": file.AcceptedOffset, "byteLength": file.ByteLength, "sha256": file.SHA256, "timelineRevision": revision, "error": file.Error}
}
func (h *Routes) archiveBundleFileStatus(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	out, err := h.service.ArchiveFileStatus(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("fileId"))
	if err != nil {
		h.Failure(w, r, err)
		return
	}
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
	body, err := readUnifiedArchiveBody(w, r, "application/json", sp.MaxArchiveSourceTailBytes)
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
