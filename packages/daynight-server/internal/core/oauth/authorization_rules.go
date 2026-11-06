package oauth

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/url"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type AuthorizationRequest struct {
	ID, Binding, ClientID, RedirectURI, Resource, Scope, Challenge, State string
	Client                                                                json.RawMessage
	StatePresent                                                          bool
}

func NewAuthorization(request AuthorizationRequest, now time.Time) store.OAuthAuthorization {
	return store.OAuthAuthorization{ID: request.ID, BindingHash: secret.Hash(request.Binding), Client: request.Client, ClientID: request.ClientID, RedirectURI: request.RedirectURI, Resource: request.Resource, Scope: request.Scope, Challenge: request.Challenge, State: request.State, StatePresent: request.StatePresent || request.State != "", Status: "pending", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(10*time.Minute + 24*time.Hour)}
}

func ValidAuthorizationStart(responseType, scope, resource, expectedResource, challenge, method, state string) bool {
	return responseType == "code" && scope == Scope && resource == expectedResource && method == "S256" && ValidChallenge(challenge) && ValidState(state)
}

func ValidAuthorizationCodeInput(code, clientID, resource, expectedResource, verifier string) bool {
	return secret.Valid(code, CodePrefix) && clientID != "" && resource == expectedResource && ValidVerifier(verifier)
}

func ValidAuthorizationBinding(binding string) bool { return secret.Valid(binding, BindingPrefix) }

// AuthorizationBound checks the browser's opaque binding without exposing its hash.
func AuthorizationBound(a store.OAuthAuthorization, binding string) bool {
	return ValidAuthorizationBinding(binding) && subtle.ConstantTimeCompare(a.BindingHash, secret.Hash(binding)) == 1
}

func AuthorizationStatus(a store.OAuthAuthorization, now time.Time) (string, bool) {
	status := a.Status
	if status == "pending" && !a.ExpiresAt.After(now) {
		status = "expired"
	}
	return status, status == "approved" && (a.CodeExpiresAt == nil || !a.CodeExpiresAt.After(now))
}

// DecideAuthorization applies a single decision to a locked authorization.
func ValidAuthorizationDecision(decision string) bool {
	return decision == "approve" || decision == "deny"
}

func DecideAuthorization(a *store.OAuthAuthorization, binding, decision, userID, issuer string, now time.Time) (string, error) {
	if !AuthorizationBound(*a, binding) || a.Status != "pending" || !a.ExpiresAt.After(now) || !ValidAuthorizationDecision(decision) {
		return "", ErrInvalidAuthorization
	}
	fields := url.Values{"iss": {issuer}}
	if a.StatePresent {
		fields.Set("state", a.State)
	}
	a.UserID = userID
	a.State, a.StatePresent = "", false
	a.RetainUntil = now.Add(24 * time.Hour)
	if decision == "approve" {
		code := secret.Random(CodePrefix)
		a.CodeHash = secret.Hash(code)
		expiry := now.Add(5 * time.Minute)
		a.CodeExpiresAt = &expiry
		a.Status = "approved"
		fields.Set("code", code)
	} else {
		a.Status = "denied"
		fields.Set("error", "access_denied")
	}
	return CallbackURI(a.RedirectURI, fields)
}

type CodeBinding struct{ ClientID, RedirectURI, Resource, Verifier string }

// CheckAuthorizationCode validates bindings before allowing issue or replay.
// A replay must be committed with the family revocation by the caller.
func CheckAuthorizationCode(a store.OAuthAuthorization, binding CodeBinding, now time.Time) (bool, error) {
	if a.ClientID != binding.ClientID || a.RedirectURI != binding.RedirectURI || a.Resource != binding.Resource || a.Scope != Scope || !VerifyChallenge(a.Challenge, binding.Verifier) {
		return false, ErrInvalidGrant
	}
	if a.Status == "consumed" {
		return true, nil
	}
	if err := CheckAuthorizationCodeExpiry(a, now); err != nil {
		return false, err
	}
	return false, nil
}

func CheckAuthorizationCodeExpiry(a store.OAuthAuthorization, now time.Time) error {
	if a.Status != "approved" || a.CodeExpiresAt == nil || !a.CodeExpiresAt.After(now) {
		return ErrInvalidGrant
	}
	return nil
}

func ConsumeAuthorization(a *store.OAuthAuthorization, grantID string, retainUntil time.Time) {
	a.Status, a.GrantID, a.RetainUntil = "consumed", grantID, retainUntil
}

// PruneAuthorizationBatch runs under the same capacity lock and transaction as
// allocation. Candidate rows remain locked until the transitions and deletes commit.
func PruneAuthorizationBatch(ctx context.Context, dao store.AuthorizationDAO, now time.Time, limit int) (int, error) {
	if err := dao.LockAuthorizationCapacity(ctx); err != nil {
		return 0, err
	}
	candidates, err := dao.ExpiredAuthorizations(ctx, now, limit, "pending")
	if err != nil {
		return 0, err
	}
	fresh, err := dao.FreshTime(ctx, now)
	if err != nil {
		return 0, err
	}
	for _, a := range candidates {
		if a.Status == "pending" && !a.ExpiresAt.After(fresh) {
			a.Status, a.State, a.StatePresent = "expired", "", false
			if err := dao.UpdateAuthorization(ctx, a); err != nil {
				return 0, err
			}
		}
	}
	deleted, err := dao.DeleteRetainedAuthorizations(ctx, now, limit-len(candidates))
	return len(candidates) + deleted, err
}
