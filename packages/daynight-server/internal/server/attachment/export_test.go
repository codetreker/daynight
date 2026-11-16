package attachment

import (
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"log/slog"
	"net/http"
	"time"
)

func RegisterRoutesWithBodyReadTimeout(mux *http.ServeMux, attachments *attachmentservice.Attachments, auth *authhttp.Authentication, logger *slog.Logger, timeout time.Duration) {
	handler := newAttachmentHandler(attachments, logger)
	handler.bodyReadTimeout = timeout
	registerContentFixture(mux, handler, auth.Require)
}

func DefaultBodyReadTimeout() time.Duration { return newAttachmentHandler(nil, nil).bodyReadTimeout }

type AttachmentOperationsForTest = attachmentOperations

func RegisterRoutesWithOperationsForTest(mux *http.ServeMux, operations AttachmentOperationsForTest, require func(httpx.AuthenticatedHandler) http.HandlerFunc, logger *slog.Logger, timeout time.Duration) {
	handler := &attachmentHandler{attachments: operations, logger: logger, bodyReadTimeout: timeout}
	registerContentFixture(mux, handler, require)
}

// Exercise the common content adapter at a Task host; main-site redirect
// behavior is tested separately through its production registration.
func registerContentFixture(mux *http.ServeMux, handler *attachmentHandler, require func(httpx.AuthenticatedHandler) http.HandlerFunc) {
	const base = "/api/v1/projects/{projectId}/tasks/{taskId}"
	mux.HandleFunc("GET "+base+"/attachments", require(handler.list))
	mux.HandleFunc("PUT "+base+"/attachments/files/{path...}", require(handler.put))
	mux.HandleFunc("GET "+base+"/attachments/files/{path...}", require(handler.download))
	mux.HandleFunc("DELETE "+base+"/attachments/files/{path...}", require(handler.delete))
	mux.HandleFunc("GET "+base+"/preview/{path...}", require(handler.preview))
	mux.HandleFunc(base+"/attachments", require(httpx.ResourceMethodNotAllowed(handler.logger, "GET, HEAD")))
	mux.HandleFunc(base+"/attachments/files/{path...}", require(httpx.ResourceMethodNotAllowed(handler.logger, "GET, HEAD, PUT, DELETE")))
	mux.HandleFunc(base+"/preview/{path...}", require(httpx.ResourceMethodNotAllowed(handler.logger, "GET, HEAD")))
}
