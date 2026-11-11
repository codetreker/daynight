package identity

import (
	"context"
	"errors"
	"net/url"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestCompleteLoginCanonicalizesMicrosoftIdentityBeforePersistence(t *testing.T) {
	for _, input := range []string{"microsoft:tenant:object", "msft:object@tenant"} {
		t.Run(input, func(t *testing.T) {
			f := newIdentityHTTPFixture(t)
			query := url.Values{"state": {secret.Random("")}, "code": {"profile"}}
			binding := secret.Random("")
			pending := model.LoginTransaction{ID: "consumed", Provider: "microsoft", ReturnPath: "/projects"}
			f.consume(query, binding, pending, nil)
			f.replies["profile"] = identityReply{200, identityProfile(input)}
			f.transaction()
			f.transaction()
			f.plan = []string{"validate-callback", "write", "consume", "finish", "write", "upsert", "bootstrap", "session", "finish"}
			f.identity.ops.validateProvider = core.ValidateProvider
			f.identity.ops.admitProfileFields = core.AdmitProfileFields
			f.identity.ops.newSession = core.NewIdentity(f.identity.CallbackURL()).NewSession
			f.identity.ops.completeLogin = func(ctx context.Context, dao store.IdentityDAO, user model.User, now time.Time) (model.User, error) {
				f.hit("upsert")
				f.bound(ctx, dao)
				if user.UniAuthID != "msft:object@tenant" || user.Email == nil || *user.Email != "shared@example.com" || user.Name == nil || *user.Name != "Display name" || user.EmailVerified == nil || *user.EmailVerified {
					t.Fatalf("canonical user profile = %+v", user)
				}
				user.ID = "existing-user"
				return user, nil
			}
			f.identity.ops.bootstrapPersonalTeam = func(ctx context.Context, dao store.PersonalTeamDAO, id string, now time.Time) (model.TeamRef, error) {
				f.hit("bootstrap")
				if ctx != f.ctx || dao != f.scope.personal || id != "existing-user" {
					t.Fatal("personal ownership changed")
				}
				return model.TeamRef{ID: "existing-team", Kind: "personal"}, nil
			}
			f.identity.ops.createSession = func(ctx context.Context, dao store.IdentityDAO, session model.Session) error {
				f.hit("session")
				f.bound(ctx, dao)
				if session.UserID != "existing-user" {
					t.Fatalf("session owner = %q", session.UserID)
				}
				return nil
			}
			result, err := f.identity.CompleteLogin(f.ctx, query, binding)
			if err != nil || result.User.ID != "existing-user" || result.User.UniAuthID != "msft:object@tenant" || result.User.PersonalTeam.ID != "existing-team" || result.Session.UserID != "existing-user" {
				t.Fatalf("login result = %+v, %v", result, err)
			}
		})
	}
}

func TestCompleteLoginRejectsMalformedMicrosoftIdentityBeforeUserTransaction(t *testing.T) {
	for _, input := range []string{"microsoft:tenant", "msft:object@tenant@extra"} {
		t.Run(input, func(t *testing.T) {
			f := newIdentityHTTPFixture(t)
			query := url.Values{"state": {secret.Random("")}, "code": {"profile"}}
			binding := secret.Random("")
			pending := model.LoginTransaction{ID: "consumed", Provider: "microsoft", ReturnPath: "/retry"}
			f.consume(query, binding, pending, nil)
			f.replies["profile"] = identityReply{200, identityProfile(input)}
			f.transaction()
			f.plan = []string{"validate-callback", "write", "consume", "finish"}
			f.identity.ops.validateProvider = core.ValidateProvider
			f.identity.ops.admitProfileFields = core.AdmitProfileFields
			result, err := f.identity.CompleteLogin(f.ctx, query, binding)
			var cause *model.IdentityProviderError
			if !errors.As(err, &cause) || cause.Code != "identity_unavailable" || cause.Cause == nil {
				t.Fatalf("malformed upstream identity error = %v", err)
			}
			f.equal(result, core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath})
		})
	}
}
