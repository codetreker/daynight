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
	"strings"
	"time"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	attachmentprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/google/uuid"
)

type attachmentHandler = handler[model.Principal]

type attachmentOperations = operations[model.Principal]

type handler[A any] struct {
	attachments     operations[A]
	principal       func(A) model.Principal
	logger          *slog.Logger
	bodyReadTimeout time.Duration
}

type operations[A any] struct {
	List        func(context.Context, A, string, string, model.PageRequest) (attachmentcore.Page, error)
	PutRetained func(context.Context, A, string, string, string, string, io.Reader) (model.Attachment, bool, io.Closer, error)
	Delete      func(context.Context, A, string, string, string) error
	Open        func(context.Context, A, string, string, string) (model.Attachment, filestorage.Object, error)
}

func RegisterRoutes(mux *http.ServeMux, attachments *attachmentservice.Attachments, auth *authhttp.Authentication, logger *slog.Logger, previewOrigin string) {
	RegisterRoutesWithScopeObserver(mux, attachments, auth, logger, previewOrigin, nil)
}

func RegisterRoutesWithScopeObserver(mux *http.ServeMux, attachments *attachmentservice.Attachments, auth *authhttp.Authentication, logger *slog.Logger, previewOrigin string, observe func(ScopeRoute)) {
	handler := newAttachmentHandler(attachments, logger)
	handler.registerRoutesWithScopeObserver(mux, func(next func(http.ResponseWriter, *http.Request, model.Principal)) http.HandlerFunc {
		return auth.Require(httpx.AuthenticatedHandler(next))
	}, previewOrigin, observe)
}

// RegisterPreviewRoutes exposes only attachment reads on a Task preview host.
func RegisterPreviewRoutes(mux *http.ServeMux, attachments *attachmentservice.Attachments, require func(httpx.AuthenticatedHandler) http.HandlerFunc, logger *slog.Logger) {
	RegisterPreviewRoutesWithScopeObserver(mux, attachments, require, logger, nil)
}

func RegisterPreviewRoutesWithScopeObserver(mux *http.ServeMux, attachments *attachmentservice.Attachments, require func(httpx.AuthenticatedHandler) http.HandlerFunc, logger *slog.Logger, observe func(ScopeRoute)) {
	handler := newAttachmentHandler(attachments, logger)
	routes := routeRegistry{mux: mux, observe: observe}
	const route = "/api/v1/projects/{projectId}/tasks/{taskId}/preview/{path...}"
	routes.handle("GET "+route, require(handler.preview), routePreviewCookie, true)
	routes.handle(route, require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")), routePreviewCookieFallback, false)
}

func newAttachmentHandler(attachments *attachmentservice.Attachments, logger *slog.Logger) *attachmentHandler {
	return &attachmentHandler{
		attachments: attachmentOperations{
			List: attachments.List, PutRetained: attachments.PutRetained,
			Delete: attachments.Delete, Open: attachments.Open,
		},
		principal: principalIdentity,
		logger:    logger, bodyReadTimeout: transport.AttachmentBodyReadTimeout,
	}
}

func principalIdentity(p model.Principal) model.Principal { return p }

func (handler *handler[A]) registerRoutes(mux *http.ServeMux, require func(func(http.ResponseWriter, *http.Request, A)) http.HandlerFunc, previewOrigin string) {
	handler.registerRoutesWithScopeObserver(mux, require, previewOrigin, nil)
}

func (handler *handler[A]) registerRoutesWithScopeObserver(mux *http.ServeMux, require func(func(http.ResponseWriter, *http.Request, A)) http.HandlerFunc, previewOrigin string, observe func(ScopeRoute)) {
	routes := routeRegistry{mux: mux, observe: observe}
	methodNotAllowed := func(allowed string) func(http.ResponseWriter, *http.Request, A) {
		return func(w http.ResponseWriter, r *http.Request, a A) {
			httpx.ResourceMethodNotAllowed(handler.logger, allowed)(w, r, handler.principal(a))
		}
	}
	const base = "/api/v1/projects/{projectId}/tasks/{taskId}"
	routes.handle("GET "+base+"/attachments", require(handler.list), routeRead, true)
	routes.handle("PUT "+base+"/attachments/files/{path...}", require(handler.put), routeUpload, false)
	routes.handle("GET "+base+"/attachments/files/{path...}", require(handler.download), routeRead, true)
	routes.handle("DELETE "+base+"/attachments/files/{path...}", require(handler.delete), routeDelete, false)
	routes.handlePreview(base+"/preview/{path...}", handler.redirectPreview(previewOrigin), require(handler.preview))
	routes.handle(base+"/attachments", require(methodNotAllowed("GET, HEAD")), routeFallback, false)
	routes.handle(base+"/attachments/files/{path...}", require(methodNotAllowed("GET, HEAD, PUT, DELETE")), routeFallback, false)
	routes.handle(base+"/preview/{path...}", require(methodNotAllowed("GET, HEAD")), routeFallback, false)
}

func (h *handler[A]) redirectPreview(origin string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		projectID, err := model.CanonicalID(r.PathValue("projectId"))
		if err == nil && projectID != "" {
			var taskID string
			taskID, err = model.CanonicalID(r.PathValue("taskId"))
			if err == nil && taskID != uuid.Nil.String() {
				parts := strings.Split(r.URL.EscapedPath(), "/")
				parts[6] = taskID
				target := strings.Replace(origin, "://", "://"+taskID+".", 1) + strings.Join(parts, "/")
				if r.URL.ForceQuery || r.URL.RawQuery != "" {
					target += "?" + r.URL.RawQuery
				}
				httpx.CloseUnreadBody(w, r)
				w.Header().Set("Location", target)
				w.WriteHeader(http.StatusFound)
				return
			}
		}
		if err == nil {
			err = httpx.InvalidInput("task ID must be a nonzero UUID")
		}
		httpx.WriteError(w, r, h.logger, "attachment", "redirect", err)
	}
}

func attachmentResponse(attachment model.Attachment) api.Attachment {
	return attachmentprotocol.REST(attachment)
}

func (h *handler[A]) resource(request *http.Request, principal A) (string, string, *slog.Logger, error) {
	projectID, taskID, logger, err := taskhttp.TaskResource(request, h.principal(principal), h.logger)
	if err == nil && request.PathValue("path") != "" {
		logger = logger.With("path", request.PathValue("path"))
	}
	return projectID, taskID, logger, err
}

func (h *handler[A]) list(w http.ResponseWriter, request *http.Request, principal A) {
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
	page, err := h.attachments.List(request.Context(), principal, projectID, taskID, input)
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

func (h *handler[A]) put(w http.ResponseWriter, request *http.Request, principal A) {
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

func (h *handler[A]) delete(w http.ResponseWriter, request *http.Request, principal A) {
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

func (h *handler[A]) download(w http.ResponseWriter, request *http.Request, principal A) {
	h.content(w, request, principal, "attachment", "download")
}

func (h *handler[A]) preview(w http.ResponseWriter, request *http.Request, principal A) {
	h.content(w, request, principal, "inline", "preview")
}

func (h *handler[A]) content(w http.ResponseWriter, request *http.Request, principal A, disposition, phase string) {
	w.Header().Set("Cache-Control", "no-store")
	if disposition == "attachment" {
		w.Header().Set("X-Content-Type-Options", "nosniff")
	}
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
