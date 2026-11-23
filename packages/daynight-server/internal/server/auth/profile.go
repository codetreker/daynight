package auth

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
)

// ScopedAuthentication supplies an authenticated current credential policy.
type ScopedAuthentication interface {
	RequireScoped(func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc
}

// ScopedProfile admits the account mutation with a transaction-bound policy recheck.
type ScopedProfile interface {
	PatchUserAuthorized(context.Context, model.CredentialAuthorization, model.UserProfilePatch, identityservice.ProfileScopeRecheck) (model.User, error)
}

func (h *Authentication) patchMe(w http.ResponseWriter, request *http.Request, p model.Principal) {
	h.patchMeWith(w, request, p, func(ctx context.Context, patch model.UserProfilePatch) (model.User, error) {
		return h.identity.PatchUser(ctx, p, patch)
	})
}

func (h *Authentication) patchMeAuthorized(w http.ResponseWriter, request *http.Request, auth model.CredentialAuthorization, profile ScopedProfile, recheck identityservice.ProfileScopeRecheck) {
	h.patchMeWith(w, request, auth.Principal, func(ctx context.Context, patch model.UserProfilePatch) (model.User, error) {
		return profile.PatchUserAuthorized(ctx, auth, patch, recheck)
	})
}

func (h *Authentication) patchMeWith(w http.ResponseWriter, request *http.Request, p model.Principal, patchUser func(context.Context, model.UserProfilePatch) (model.User, error)) {
	if _, err := httpx.QueryValues(request); err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "patch_me", err)
		return
	}
	fields, err := httpx.DecodeObject(w, request, "name", "avatarUrl")
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "patch_me", err)
		return
	}
	patch, err := decodeProfilePatch(fields, true)
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "patch_me", err)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 15*time.Second)
	defer cancel()
	user, err := patchUser(ctx, patch)
	if err != nil {
		writeProfileError(w, request, h.logger.With("user_id", p.UserID), err)
		return
	}
	httpx.WriteMutationJSON(w, request, h.logger, "auth", http.StatusOK, userResponse(user))
}

func writeProfileError(w http.ResponseWriter, request *http.Request, logger *slog.Logger, err error) {
	facts := operation.CompletionFacts(err)
	if facts.CleanupFailed || facts.Outcome == store.TransactionUnknown || facts.Outcome == store.TransactionCommitted || facts.Phase != "" && facts.Phase != "operation" {
		status, code, message, phase := http.StatusInternalServerError, "internal_error", "The request could not be completed.", "completion"
		if !facts.CleanupFailed && facts.Outcome == store.TransactionUnknown {
			status, code, message, phase = http.StatusServiceUnavailable, "write_outcome_unknown", "The write outcome is unknown. Read the current resource before deciding on another operation.", "commit"
			logger = logger.With("write_outcome", "unknown")
		}
		logger = logger.With("auth_error_code", code)
		httpx.LogFailure(logger, request.Context(), "auth", phase, &model.Fault{Code: code, Message: message, Cause: err})
		httpx.WriteJSON(w, request, logger, status, api.ErrorResponse{Error: api.Error{Code: code, Message: message, RequestID: httpx.RequestID(request.Context())}})
		return
	}
	httpx.WriteError(w, request, logger, "auth", "patch_me", err)
}
