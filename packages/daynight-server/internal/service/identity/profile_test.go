package identity

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestSDKProfileFieldsReachAdmissionUnchanged(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		max         int
	}{
		{"id", "identityId", core.MaxProfileFieldBytes}, {"name", "name", core.MaxProfileFieldBytes}, {"email", "email", core.MaxProfileFieldBytes}, {"avatar_url", "avatarUrl", core.MaxAvatarURLBytes},
	} {
		for _, extra := range []int{0, 1} {
			t.Run(tc.name+"/"+string(rune('0'+extra)), func(t *testing.T) {
				f := newIdentityHTTPFixture(t)
				query := url.Values{"state": {secret.Random("")}, "code": {"profile"}}
				binding := secret.Random("")
				pending := model.LoginTransaction{ID: "consumed", ReturnPath: "/retry", Provider: "microsoft"}
				f.consume(query, binding, pending, nil)
				f.transaction()
				f.plan = []string{"validate-callback", "write", "consume", "finish", "provider", "profile"}
				value := strings.Repeat("a", tc.max+extra)
				profile := identityProfile("existing")
				profile[tc.name] = value
				f.replies["profile"] = identityReply{200, profile}
				f.identity.ops.validateProvider = func(string, string, error) error { f.hit("provider"); return nil }
				refusal := errors.New("profile admission refusal")
				f.identity.ops.admitProfileFields = func(got model.User) error {
					f.hit("profile")
					switch tc.name {
					case "id":
						f.equal(got.UniAuthID, value)
					case "name":
						f.equal(got.Name, &value)
					case "email":
						f.equal(got.Email, &value)
					case "avatar_url":
						f.equal(got.AvatarURL, &value)
					}
					if extra == 1 {
						return refusal
					}
					return nil
				}
				stop := errors.New("next phase marker")
				if extra == 0 {
					f.plan = append(f.plan, "new-session", "write")
					f.transaction()
					f.transactions[1].before = stop
					f.identity.ops.newSession = func(time.Time) (model.Session, string) { f.hit("new-session"); return model.Session{}, "opaque" }
				}
				got, err := f.identity.CompleteLogin(f.ctx, query, binding)
				f.equal(got, core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath})
				if extra == 1 {
					var provider *model.IdentityProviderError
					if !errors.As(err, &provider) || provider.Code != "identity_unavailable" || !errors.Is(err, refusal) {
						t.Fatalf("profile admission=%v", err)
					}
				} else if !errors.Is(err, stop) {
					t.Fatalf("boundary never reached next phase: %v", err)
				}
			})
		}
	}
}

func TestCompleteLoginAdmissionRequiresConfirmedRollback(t *testing.T) {
	for _, stage := range []string{"merged", "response"} {
		for _, outcome := range []string{"plain", "rolled-back", "cleanup-failed", "unknown", "commit-attempted", "database"} {
			t.Run(stage+"/"+outcome, func(t *testing.T) {
				f := newIdentityHTTPFixture(t)
				query := url.Values{"state": {secret.Random("")}, "code": {"profile"}}
				binding := secret.Random("")
				pending := model.LoginTransaction{ID: "consumed", Provider: "microsoft", ReturnPath: "/retry"}
				f.consume(query, binding, pending, nil)
				f.replies["profile"] = identityReply{200, identityProfile("identity")}
				f.transaction()
				f.transaction()
				refusal := &model.Fault{Code: "invalid_input", Message: "profile exceeds capacity"}
				returned := error(refusal)
				switch outcome {
				case "rolled-back":
					returned = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: refusal}
				case "cleanup-failed":
					returned = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: refusal}
				case "unknown":
					returned = &store.TransactionError{Phase: "operation", Outcome: store.TransactionUnknown, Cause: refusal}
				case "commit-attempted":
					returned = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CommitAttempted: true, Cause: refusal}
				case "database":
					returned = &store.Error{Phase: "rollback", DatabaseFailure: true, Cause: refusal}
				}
				f.transactions[1].callbackErr = refusal
				f.transactions[1].err = returned
				f.transactions[1].completion.Outcome = store.TransactionNotCommitted
				f.plan = []string{"validate-callback", "write", "consume", "finish", "new-session", "write", "upsert", "merged"}
				if stage == "response" {
					f.plan = append(f.plan, "bootstrap", "lookup", "validate-team", "response")
				}
				f.plan = append(f.plan, "finish")
				f.identity.ops.validateProvider = core.ValidateProvider
				f.identity.ops.admitProfileFields = core.AdmitProfileFields
				f.identity.ops.newSession = func(time.Time) (model.Session, string) {
					f.hit("new-session")
					return model.Session{ID: "new"}, "secret"
				}
				user := model.User{ID: "existing", UniAuthID: "identity"}
				f.identity.ops.completeLogin = func(ctx context.Context, dao store.IdentityDAO, _ model.User, _ time.Time) (model.User, error) {
					f.hit("upsert")
					f.bound(ctx, dao)
					return user, nil
				}
				f.identity.ops.admitCompleteUser = func(got model.User, response bool) error {
					if response {
						f.hit("response")
						if got.PersonalTeam.ID != "team" {
							t.Fatalf("team=%+v", got.PersonalTeam)
						}
						return refusal
					}
					f.hit("merged")
					f.equal(got, user)
					if stage == "merged" {
						return refusal
					}
					return nil
				}
				f.identity.ops.bootstrapPersonalTeam = func(ctx context.Context, dao store.PersonalTeamDAO, id string, _ time.Time) (model.TeamRef, error) {
					f.hit("bootstrap")
					if ctx != f.ctx || dao != f.scope.personal || id != user.ID {
						t.Fatal("incorrect team scope")
					}
					return model.TeamRef{ID: "team", Kind: "personal"}, nil
				}
				f.identity.ops.user = func(ctx context.Context, dao store.IdentityDAO, p model.Principal) (model.User, store.PersonalTeamFacts, error) {
					f.hit("lookup")
					f.bound(ctx, dao)
					if p.UserID != user.ID {
						t.Fatal("incorrect principal")
					}
					return user, store.PersonalTeamFacts{ID: "team", MemberCount: 1, OwnerAdminCount: 1}, nil
				}
				f.identity.ops.validatePersonalTeam = func(facts store.PersonalTeamFacts) error {
					f.hit("validate-team")
					if facts.ID != "team" {
						t.Fatal("incorrect team")
					}
					return nil
				}
				result, err := f.identity.CompleteLogin(f.ctx, query, binding)
				f.equal(result, core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath})
				if !errors.Is(err, refusal) {
					t.Fatalf("lost admission error: %v", err)
				}
				var provider *model.IdentityProviderError
				wrapped := errors.As(err, &provider)
				if want := outcome == "plain" || outcome == "rolled-back"; wrapped != want || (wrapped && provider.Code != "identity_unavailable") {
					t.Fatalf("outcome %s, error=%v", outcome, err)
				}
				if !wrapped && err != returned {
					t.Fatalf("transaction failure changed: %v", err)
				}
			})
		}
	}
}
