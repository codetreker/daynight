package auth

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/credential"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// RequireCredentialSession authenticates the account-management surface without
// admitting or observing bearer credentials. Authentication and the subsequent
// business operation have separate budgets.
func (h *RequestAuthentication) RequireCredentialSession(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(httpx.WithRedactedOperationDiagnostics(r.Context()))
		w.Header().Set("Cache-Control", "no-store")
		for name := range r.Header {
			if strings.EqualFold(name, "Authorization") {
				httpx.WriteError(w, r, h.logger, "credential", "authenticate", &model.Fault{Code: "forbidden", Message: "A main-site browser session is required."})
				return
			}
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		principal, err := h.AuthenticateSessionRequest(r.WithContext(ctx))
		cancel()
		if err == nil && (principal.Kind != model.SessionCredential || model.RequirePrincipal(principal) != nil) {
			err = Failure()
		}
		if err != nil {
			credential.WriteReadError(w, r, h.logger, "credential", "authenticate", err)
			return
		}
		w.Header().Set("Daynight-User-ID", principal.UserID)
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			origins := r.Header.Values("Origin")
			if len(origins) != 1 || origins[0] != h.origin {
				httpx.WriteError(w, r, h.logger, "credential", "origin", &model.Fault{Code: "forbidden", Message: "Cookie writes require the exact main-site Origin."})
				return
			}
		}
		next(w, r, principal)
	}
}
