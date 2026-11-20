package attachment

import (
	"context"
	"io"
	"log/slog"
	"net/http"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type ScopedOperations interface {
	List(context.Context, model.CredentialAuthorization, string, string, model.PageRequest) (attachmentcore.Page, error)
	PutRetained(context.Context, model.CredentialAuthorization, string, string, string, string, io.Reader) (model.Attachment, bool, io.Closer, error)
	Delete(context.Context, model.CredentialAuthorization, string, string, string) error
	Open(context.Context, model.CredentialAuthorization, string, string, string) (model.Attachment, filestorage.Object, error)
}

type AuthorizedHandler func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)

type ScopedAuthentication interface {
	RequireAuthorization(AuthorizedHandler) http.HandlerFunc
}

// RegisterScopedRoutes preserves main-site preview navigation while requiring
// explicit credential authorization for attachment data, including preview HEAD.
func RegisterScopedRoutes(mux *http.ServeMux, attachments ScopedOperations, auth ScopedAuthentication, logger *slog.Logger, previewOrigin string) {
	RegisterScopedRoutesWithScopeObserver(mux, attachments, auth, logger, previewOrigin, nil)
}

func RegisterScopedRoutesWithScopeObserver(mux *http.ServeMux, attachments ScopedOperations, auth ScopedAuthentication, logger *slog.Logger, previewOrigin string, observe func(ScopeRoute)) {
	h := &handler[model.CredentialAuthorization]{
		attachments: operations[model.CredentialAuthorization]{
			List: attachments.List, PutRetained: attachments.PutRetained,
			Delete: attachments.Delete, Open: attachments.Open,
		},
		principal: func(a model.CredentialAuthorization) model.Principal { return a.Principal },
		logger:    logger, bodyReadTimeout: transport.AttachmentBodyReadTimeout,
	}
	h.registerRoutesWithScopeObserver(mux, func(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
		return auth.RequireAuthorization(func(w http.ResponseWriter, r *http.Request, a model.CredentialAuthorization) {
			if err := a.Validate(); err != nil {
				httpx.CloseUnreadBody(w, r)
				httpx.WriteError(w, r, logger, "attachment", "authorization", err)
				return
			}
			next(w, r, a)
		})
	}, previewOrigin, observe)
}
