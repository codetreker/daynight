package session

import (
	"context"
	"encoding/json"
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

type archiveUploadV2Operation interface {
	PutArchiveFileV2(context.Context, string, string, int64, int64, string, string, []byte) (sp.ArchiveFileReceipt, error)
	PutArchiveResourceV2(context.Context, string, int64, int64, string, string, []byte, sp.Resource) (sp.ArchiveFileReceipt, error)
	CompleteArchiveFile(context.Context, string, string) (sp.ArchiveFileReceipt, error)
	RestartArchiveFile(context.Context, string, string, string) (sp.ArchiveFileReceipt, error)
}

const archiveUploadVersionHeader = "Daynight-Archive-Upload-Version"

func (h *Routes) registerUnifiedArchiveRoutes(mux httpx.RouteRegistrar, base string, observe func(ProducerRoute)) {
	for route, handler := range map[string]httpx.AuthenticatedHandler{
		"GET " + base + "/prepare":                            h.archivePreparation,
		"POST " + base + "/prepare":                           h.prepareArchive,
		"POST " + base + "/source-tail":                       h.archiveSourceTail,
		"POST " + base + "/seal":                              h.sealArchive,
		"PUT " + base + "/content":                            h.putArchiveManifest,
		"PUT " + base + "/prepare/history/{fileId}":           h.putArchiveHistory,
		"GET " + base + "/prepare/history/{fileId}/status":    h.archiveBundleFileStatus,
		"POST " + base + "/prepare/history/{fileId}/complete": h.completeArchiveFile,
		"POST " + base + "/prepare/history/{fileId}/restart":  h.restartArchiveFile,
		"PUT " + base + "/files/{fileId}":                     h.putArchiveTimeline,
		"GET " + base + "/files/{fileId}/status":              h.archiveBundleFileStatus,
		"POST " + base + "/files/{fileId}/complete":           h.completeArchiveFile,
		"POST " + base + "/files/{fileId}/restart":            h.restartArchiveFile,
		"GET " + base + "/files/{fileId}":                     h.archiveTimelineContent,
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
	if err == nil {
		w.Header().Set(archiveUploadVersionHeader, "2")
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
	w.Header().Set(archiveUploadVersionHeader, "2")
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
	values, err := httpx.QueryValues(r, "offset", "purpose", "migrationOnly")
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	offset, e1 := strconv.ParseInt(values.Get("offset"), 10, 64)
	length, e2 := strconv.ParseInt(r.Header.Get("Daynight-File-Byte-Length"), 10, 64)
	legacyResource := values.Get("purpose") == "resource" && values.Get("migrationOnly") == "true" && purpose == "timeline"
	version, versionErr := archiveUploadVersion(r)
	if versionErr != nil {
		h.Failure(w, r, versionErr)
		return
	}
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
		if version == 2 {
			v2, ok := op.(archiveUploadV2Operation)
			if !ok {
				err = httpx.InvalidInput("Archive upload version is unavailable.")
			} else {
				out, err = v2.PutArchiveResourceV2(r.Context(), r.PathValue("fileId"), offset, length, r.Header.Get("Daynight-File-SHA256"), r.Header.Get("Daynight-Chunk-SHA256"), data, resource)
			}
		} else {
			out, err = op.PutArchiveResource(r.Context(), r.PathValue("fileId"), offset, length, r.Header.Get("Daynight-File-SHA256"), r.Header.Get("Daynight-Chunk-SHA256"), data, resource)
		}
	} else if values.Get("purpose") != "" || values.Get("migrationOnly") != "" {
		err = httpx.InvalidInput("Invalid archive migration profile.")
	} else {
		if version == 2 {
			v2, ok := op.(archiveUploadV2Operation)
			if !ok {
				err = httpx.InvalidInput("Archive upload version is unavailable.")
			} else {
				out, err = v2.PutArchiveFileV2(r.Context(), purpose, r.PathValue("fileId"), offset, length, r.Header.Get("Daynight-File-SHA256"), r.Header.Get("Daynight-Chunk-SHA256"), data)
			}
		} else {
			out, err = op.PutArchiveFile(r.Context(), purpose, r.PathValue("fileId"), offset, length, r.Header.Get("Daynight-File-SHA256"), r.Header.Get("Daynight-Chunk-SHA256"), data)
		}
	}
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	if version == 2 {
		w.Header().Set(archiveUploadVersionHeader, "2")
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
	out := map[string]any{"syncId": file.FileID, "state": file.State, "acceptedOffset": file.AcceptedOffset, "byteLength": file.ByteLength, "sha256": file.SHA256, "timelineRevision": revision, "error": file.Error}
	if file.SuccessorFileID != nil {
		out["successorFileId"] = *file.SuccessorFileID
	}
	return out
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
	if out.UploadVersion == 2 {
		w.Header().Set(archiveUploadVersionHeader, "2")
	} else {
		w.Header().Set(archiveUploadVersionHeader, "1")
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

func archiveUploadVersion(r *http.Request) (int, error) {
	values := r.Header.Values(archiveUploadVersionHeader)
	if len(values) == 0 {
		return 1, nil
	}
	if len(values) == 1 && (values[0] == "1" || values[0] == "2") {
		return int(values[0][0] - '0'), nil
	}
	return 0, httpx.InvalidInput("Invalid archive upload version.")
}

func archiveFilePurpose(r *http.Request) string {
	if containsHistoryPath(r.Pattern) {
		return "history"
	}
	return "timeline"
}

func (h *Routes) completeArchiveFile(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.archiveV2Action(w, r, p, false)
}

func (h *Routes) restartArchiveFile(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.archiveV2Action(w, r, p, true)
}

func (h *Routes) archiveV2Action(w http.ResponseWriter, r *http.Request, p model.Principal, restart bool) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	version, err := archiveUploadVersion(r)
	if err != nil || version != 2 {
		h.Failure(w, r, httpx.InvalidInput("Archive upload version 2 is required."))
		return
	}
	op, err := h.beginUnifiedArchive(w, r, p)
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	v2, ok := op.(archiveUploadV2Operation)
	if !ok {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, archiveCleanupError(httpx.InvalidInput("Archive upload version is unavailable."), op.Close()))
		return
	}
	readRequest, finishRead := archiveReadRequest(r, op)
	var replacement string
	if restart {
		var body []byte
		body, err = readUnifiedArchiveBody(w, readRequest, "application/json", 1024, false)
		if err == nil {
			replacement, err = archiveReplacementFileID(body)
		}
	} else {
		stream := httpx.NewDeadlineBody(w, readRequest, 15*time.Second)
		var body []byte
		body, err = io.ReadAll(io.LimitReader(stream, 1))
		err = archiveCleanupError(err, stream.Close())
		if err == nil && len(body) != 0 {
			httpx.CloseUnreadBody(w, r)
			err = httpx.InvalidInput("Archive completion does not accept a body.")
		}
	}
	finishRead()
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	var out sp.ArchiveFileReceipt
	if restart {
		out, err = v2.RestartArchiveFile(r.Context(), archiveFilePurpose(r), r.PathValue("fileId"), replacement)
	} else {
		out, err = v2.CompleteArchiveFile(r.Context(), archiveFilePurpose(r), r.PathValue("fileId"))
	}
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	w.Header().Set(archiveUploadVersionHeader, "2")
	if archiveFilePurpose(r) == "history" {
		h.archiveResult(w, r, historyFileResponse(out), op)
	} else {
		h.archiveResult(w, r, out, op)
	}
}

func archiveReplacementFileID(body []byte) (string, error) {
	invalid := func() (string, error) { return "", httpx.InvalidInput("Invalid archive replacement identity.") }
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') || !decoder.More() {
		return invalid()
	}
	key, err := decoder.Token()
	if err != nil || key != "replacementFileId" {
		return invalid()
	}
	var raw string
	if decoder.Decode(&raw) != nil || decoder.More() {
		return invalid()
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') {
		return invalid()
	}
	if _, err = decoder.Token(); err != io.EOF {
		return invalid()
	}
	id, err := model.CanonicalID(raw)
	if err != nil || id != raw {
		return invalid()
	}
	return id, nil
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
