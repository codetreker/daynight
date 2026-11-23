package auth

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"net/http"
)

type AuthorizationReader func(context.Context, model.Principal) (model.CredentialAuthorization, error)

type PolicyAuthentication struct {
	*Authentication
	current AuthorizationReader
}

func WithCredentialPolicy(base *Authentication, current AuthorizationReader) *PolicyAuthentication {
	return &PolicyAuthentication{base, current}
}

func (a *PolicyAuthentication) Resolve(r *http.Request, p model.Principal) (model.CredentialAuthorization, error) {
	return a.current(r.Context(), p)
}

func (a *PolicyAuthentication) RequireAuthorization(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return a.RequireScoped(next)
}

func (a *PolicyAuthentication) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return a.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		authorization, err := a.Resolve(r, p)
		if err != nil {
			httpx.WriteError(w, r, a.logger, "auth", "policy", err)
			return
		}
		next(w, r, authorization)
	})
}
