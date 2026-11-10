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
	handler.registerRoutes(mux, auth.Require)
}

func DefaultBodyReadTimeout() time.Duration {
	return newAttachmentHandler((*attachmentservice.Attachments)(nil), nil).bodyReadTimeout
}

type AttachmentOperationsForTest = attachmentOperations

func RegisterRoutesWithOperationsForTest(mux *http.ServeMux, operations AttachmentOperationsForTest, require func(httpx.AuthenticatedHandler) http.HandlerFunc, logger *slog.Logger, timeout time.Duration) {
	handler := &attachmentHandler{attachments: operations, logger: logger, bodyReadTimeout: timeout}
	handler.registerRoutes(mux, require)
}
