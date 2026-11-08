package attachment

import (
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"log/slog"
	"net/http"
	"time"
)

func RegisterRoutesWithBodyReadTimeout(mux *http.ServeMux, attachments *attachmentservice.Attachments, auth *authhttp.Authentication, logger *slog.Logger, timeout time.Duration) {
	handler := newAttachmentHandler(attachments, logger)
	handler.bodyReadTimeout = timeout
	handler.registerRoutes(mux, auth)
}

func DefaultBodyReadTimeout() time.Duration { return newAttachmentHandler(nil, nil).bodyReadTimeout }
