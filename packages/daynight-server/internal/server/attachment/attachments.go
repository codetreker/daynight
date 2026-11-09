package attachment

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"strconv"
	"time"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	attachmentprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
)

type attachmentHandler struct {
	attachments     *attachmentservice.Attachments
	logger          *slog.Logger
	bodyReadTimeout time.Duration
}

func RegisterRoutes(mux *http.ServeMux, attachments *attachmentservice.Attachments, auth *authhttp.Authentication, logger *slog.Logger) {
	handler := newAttachmentHandler(attachments, logger)
	handler.registerRoutes(mux, auth)
}

func newAttachmentHandler(attachments *attachmentservice.Attachments, logger *slog.Logger) *attachmentHandler {
	return &attachmentHandler{attachments: attachments, logger: logger, bodyReadTimeout: transport.AttachmentBodyReadTimeout}
}

func (handler *attachmentHandler) registerRoutes(mux *http.ServeMux, auth *authhttp.Authentication) {
	const base = "/api/v1/projects/{projectId}/tasks/{taskId}"
	mux.HandleFunc("GET "+base+"/attachments", auth.Require(handler.list))
	mux.HandleFunc("PUT "+base+"/attachments/files/{path...}", auth.Require(handler.put))
	mux.HandleFunc("GET "+base+"/attachments/files/{path...}", auth.Require(handler.download))
	mux.HandleFunc("DELETE "+base+"/attachments/files/{path...}", auth.Require(handler.delete))
	mux.HandleFunc("GET "+base+"/preview/{path...}", auth.Require(handler.preview))
	mux.HandleFunc(base+"/attachments", auth.Require(httpx.ResourceMethodNotAllowed(handler.logger, "GET, HEAD")))
	mux.HandleFunc(base+"/attachments/files/{path...}", auth.Require(httpx.ResourceMethodNotAllowed(handler.logger, "GET, HEAD, PUT, DELETE")))
	mux.HandleFunc(base+"/preview/{path...}", auth.Require(httpx.ResourceMethodNotAllowed(handler.logger, "GET, HEAD")))
}

func attachmentResponse(attachment model.Attachment) api.Attachment {
	return attachmentprotocol.REST(attachment)
}

func (h *attachmentHandler) resource(request *http.Request, principal model.Principal) (string, string, *slog.Logger, error) {
	projectID, taskID, logger, err := taskhttp.TaskResource(request, principal, h.logger)
	if err == nil && request.PathValue("path") != "" {
		logger = logger.With("path", request.PathValue("path"))
	}
	return projectID, taskID, logger, err
}

func (h *attachmentHandler) list(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, taskID, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "attachment", "list", err)
		return
	}
	input, err := httpx.PageRequest(request)
	if err != nil {
		httpx.WriteError(w, request, logger, "attachment", "list", err)
		return
	}
	page, err := h.attachments.ListREST(request.Context(), principal, projectID, taskID, input)
	if err != nil {
		httpx.WriteError(w, request, logger, "attachment", "list", err)
		return
	}
	response := api.AttachmentPage{Items: make([]api.Attachment, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, attachment := range page.Items {
		response.Items = append(response.Items, attachmentResponse(attachment))
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *attachmentHandler) put(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, taskID, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.CloseUnreadBody(w, request)
		httpx.WriteError(w, request, logger, "attachment", "put", err)
		return
	}
	contentType := request.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if _, _, err := mime.ParseMediaType(contentType); err != nil || len(request.Header.Values("Content-Type")) > 1 {
		httpx.CloseUnreadBody(w, request)
		httpx.WriteError(w, request, logger, "attachment", "put", httpx.InvalidInput("Content-Type must be a valid media type"))
		return
	}
	body := httpx.NewDeadlineBody(w, request, h.bodyReadTimeout)
	attachment, created, lease, err := h.attachments.PutRetained(request.Context(), principal, projectID, taskID,
		request.PathValue("path"), contentType, body)
	if lease != nil {
		defer func() {
			if closeErr := lease.Close(); closeErr != nil {
				httpx.LogFailure(logger, request.Context(), "attachment", "put", closeErr)
			}
		}()
	}
	if closeErr := body.Close(); closeErr != nil {
		httpx.LogFailure(logger, request.Context(), "attachment", "put", closeErr)
	}
	if err != nil {
		httpx.WriteBodyError(w, request, logger, "attachment", "put", err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	logger.InfoContext(request.Context(), "attachment saved", "type", "resource", "component", "attachment", "phase", "put", "request_id", httpx.RequestID(request.Context()))
	httpx.WriteJSON(w, request, logger, status, attachmentResponse(attachment))
}

func (h *attachmentHandler) delete(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, taskID, logger, err := h.resource(request, principal)
	if err == nil {
		err = h.attachments.Delete(request.Context(), principal, projectID, taskID, request.PathValue("path"))
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "attachment", "delete", err)
		return
	}
	logger.InfoContext(request.Context(), "attachment deleted", "type", "resource", "component", "attachment", "phase", "delete", "request_id", httpx.RequestID(request.Context()))
	if request.Context().Err() == nil {
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h *attachmentHandler) download(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	h.content(w, request, principal, "attachment", "download")
}

func (h *attachmentHandler) preview(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	h.content(w, request, principal, "inline", "preview")
}

func (h *attachmentHandler) content(w http.ResponseWriter, request *http.Request, principal model.Principal, disposition, phase string) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, taskID, logger, err := h.resource(request, principal)
	if err != nil {
		httpx.WriteError(w, request, logger, "attachment", phase, err)
		return
	}
	attachment, object, err := h.attachments.Open(request.Context(), principal, projectID, taskID, request.PathValue("path"))
	if err != nil {
		httpx.WriteError(w, request, logger, "attachment", phase, err)
		return
	}
	w.Header().Set("Content-Type", attachment.ContentType)
	w.Header().Set("Content-Length", strconv.FormatInt(object.Info.Size, 10))
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": path.Base(attachment.Path)}))
	writer := &attachmentWriter{ResponseWriter: w, ctx: request.Context()}
	var copied int64
	if request.Method != http.MethodHead {
		copied, err = io.Copy(writer, object.Body)
		if err == nil && copied != object.Info.Size {
			err = io.ErrUnexpectedEOF
		}
	}
	err = errors.Join(err, object.Body.Close(), request.Context().Err())
	if err != nil {
		if writer.started {
			httpx.LogFailure(logger, request.Context(), "attachment", phase, err)
			panic(http.ErrAbortHandler)
		}
		w.Header().Del("Content-Type")
		w.Header().Del("Content-Length")
		w.Header().Del("Content-Disposition")
		httpx.WriteError(w, request, logger, "attachment", phase, err)
		return
	}
	if !writer.started {
		w.WriteHeader(http.StatusOK)
	}
}

type attachmentWriter struct {
	http.ResponseWriter
	ctx     context.Context
	started bool
}

func (w *attachmentWriter) Write(data []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	w.started = true
	return w.ResponseWriter.Write(data)
}
