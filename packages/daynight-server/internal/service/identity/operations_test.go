package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestCredentialOperationsPreserveInputsAndCompletion(t *testing.T) {
	for _, operation := range []string{"authenticate", "user", "personal", "logout", "create", "list", "revoke", "expiry", "redeem", "logout-device"} {
		for _, stage := range []string{"success", "lower-refusal", "lower-error", "unknown", "not-committed", "invalid-outcome", "completion-error"} {
			t.Run(operation+"/"+stage, func(t *testing.T) {
				f := newIdentityFixture(t)
				s := f.identity
				p := model.Principal{Kind: model.SessionCredential, UserID: "canonical-user", CredentialID: "browser-session"}
				fault := &model.Fault{Code: "forbidden", Cause: errors.New("original cause")}
				failure := errors.New("operation failure")
				var lower error
				if stage == "lower-refusal" {
					lower = fault
				}
				if stage == "lower-error" {
					lower = failure
				}
				f.transaction()
				f.plan = []string{"write", operation, "finish"}
				if stage == "lower-error" {
					f.transactions[0].callbackErr = lower
					f.transactions[0].err = lower
				}
				switch stage {
				case "unknown":
					f.transactions[0].completion.Outcome = store.TransactionUnknown
				case "not-committed":
					f.transactions[0].completion.Outcome = store.TransactionNotCommitted
				case "invalid-outcome":
					f.transactions[0].completion.Outcome = "invalid"
				case "completion-error":
					f.transactions[0].err = failure
				}
				user := model.User{ID: p.UserID, UniAuthID: "subject", CreatedAt: f.now.Add(-time.Hour), UpdatedAt: f.now}
				facts := store.PersonalTeamFacts{ID: "personal-team", MemberCount: 1, OwnerAdminCount: 1}
				token := model.PersonalAccessToken{ID: "token", UserID: p.UserID, Name: " Build agent ", CreatedAt: f.now.Add(-time.Minute), ExpiresAt: tokenExpiryAt(f.now.Add(time.Hour))}
				minted := core.MintedPAT{Credential: token, Secret: "opaque-PAT"}
				input := core.CreatePAT{Name: token.Name, ExpiresAt: token.ExpiresAt}
				expiry := core.UpdatePATExpiry{ExpiresAt: token.ExpiresAt, ExpectedExpiresAt: tokenExpiryAt(f.now.Add(time.Minute)), ExpectedUserID: p.UserID}
				var got, want, zero any
				var err error
				f.identity.ops.validateSession = func(got model.Principal) error { f.hit("validate"); f.equal(got, p); return nil }
				switch operation {
				case "authenticate":
					value := "raw-session"
					kind := model.SessionCredential
					f.plan = append([]string{"validate"}, f.plan...)
					s.ops.validateCredential = func(k model.CredentialKind, v string) error {
						f.hit("validate")
						f.equal([]any{k, v}, []any{kind, value})
						return nil
					}
					s.ops.authenticate = func(ctx context.Context, dao store.IdentityDAO, k model.CredentialKind, v string, now time.Time) (model.Principal, error) {
						f.hit(operation)
						f.bound(ctx, dao)
						f.equal([]any{k, v, now}, []any{kind, value, f.now})
						return p, lower
					}
					got, err = s.Authenticate(f.ctx, kind, value)
					want, zero = p, model.Principal{}
				case "user":
					if lower == nil {
						f.plan = []string{"write", operation, "validate-personal", "finish"}
					}
					s.ops.user = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal) (model.User, store.PersonalTeamFacts, error) {
						f.hit(operation)
						f.bound(ctx, dao)
						f.equal(principal, p)
						return user, facts, lower
					}
					s.ops.validatePersonalTeam = func(got store.PersonalTeamFacts) error { f.hit("validate-personal"); f.equal(got, facts); return nil }
					got, err = s.User(f.ctx, p)
					user.PersonalTeam = model.TeamRef{ID: facts.ID, Kind: "personal"}
					want, zero = user, model.User{}
				case "personal":
					if lower == nil {
						f.plan = []string{"write", operation, "validate-personal", "finish"}
					}
					s.ops.personalTeam = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal) (store.PersonalTeamFacts, error) {
						f.hit(operation)
						f.bound(ctx, dao)
						f.equal(principal, p)
						return facts, lower
					}
					s.ops.validatePersonalTeam = func(got store.PersonalTeamFacts) error { f.hit("validate-personal"); f.equal(got, facts); return nil }
					got, err = s.PersonalTeamID(f.ctx, p)
					want, zero = facts.ID, ""
					if stage != "success" && lower == nil {
						zero = facts.ID
					}
				case "logout":
					f.plan = append([]string{"validate"}, f.plan...)
					s.ops.logout = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal) error {
						f.hit(operation)
						f.bound(ctx, dao)
						f.equal(principal, p)
						return lower
					}
					err = s.Logout(f.ctx, p)
				case "create":
					f.plan = append([]string{"validate"}, f.plan...)
					s.ops.validateCreatePAT = func(principal model.Principal, in core.CreatePAT, now time.Time) (*time.Time, error) {
						f.hit("validate")
						f.equal([]any{principal, in, now}, []any{p, input, f.now})
						return nil, nil
					}
					s.ops.createPAT = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal, in core.CreatePAT, now time.Time) (core.MintedPAT, error) {
						f.hit(operation)
						f.bound(ctx, dao)
						f.equal([]any{principal, in, now}, []any{p, input, f.now})
						return minted, lower
					}
					got, err = s.CreatePAT(f.ctx, p, input)
					want, zero = minted, core.MintedPAT{}
				case "list":
					f.plan = append([]string{"validate"}, f.plan...)
					s.ops.listPATs = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal, now time.Time) ([]model.PersonalAccessToken, error) {
						f.hit(operation)
						f.bound(ctx, dao)
						f.equal([]any{principal, now}, []any{p, f.now})
						return []model.PersonalAccessToken{token}, lower
					}
					got, err = s.ListPATs(f.ctx, p)
					want, zero = []model.PersonalAccessToken{token}, []model.PersonalAccessToken(nil)
				case "revoke":
					f.plan = append([]string{"validate"}, f.plan...)
					id := "RAW-UPPER-ID"
					s.ops.validateRevokePAT = func(principal model.Principal, gotID string) (string, error) {
						f.hit("validate")
						f.equal([]any{principal, gotID}, []any{p, id})
						return "canonical-id", nil
					}
					s.ops.revokePAT = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal, gotID string, now time.Time) error {
						f.hit(operation)
						f.bound(ctx, dao)
						f.equal([]any{principal, gotID, now}, []any{p, id, f.now})
						return lower
					}
					err = s.RevokePAT(f.ctx, p, id)
				case "expiry":
					f.plan = append([]string{"validate"}, f.plan...)
					s.ops.validateUpdatePATExpiry = func(principal model.Principal, id string, in core.UpdatePATExpiry, now time.Time) (string, *time.Time, error) {
						f.hit("validate")
						f.equal([]any{principal, id, in, now}, []any{p, token.ID, expiry, f.now})
						return "canonical", nil, nil
					}
					s.ops.updatePATExpiry = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal, id string, in core.UpdatePATExpiry, now time.Time) (model.PersonalAccessToken, error) {
						f.hit(operation)
						f.bound(ctx, dao)
						f.equal([]any{principal, id, in, now}, []any{p, token.ID, expiry, f.now})
						return token, lower
					}
					got, err = s.UpdatePATExpiry(f.ctx, p, token.ID, expiry)
					want, zero = token, model.PersonalAccessToken{}
				case "redeem":
					f.plan = append([]string{"validate"}, f.plan...)
					client, grant, code, name := "raw-client", "raw-grant", "raw-code", "开发工作站"
					s.ops.validateDeviceRedemption = func(c, g, v, n string) error {
						f.hit("validate")
						f.equal([]any{c, g, v, n}, []any{client, grant, code, name})
						return nil
					}
					s.ops.redeemDevice = func(ctx context.Context, dao store.IdentityDAO, c, g, v, n string, now time.Time) (core.MintedPAT, error) {
						f.hit(operation)
						f.bound(ctx, dao)
						f.equal([]any{c, g, v, n, now}, []any{client, grant, code, name, f.now})
						return minted, lower
					}
					got, err = s.RedeemDevice(f.ctx, client, grant, code, name)
					want, zero = minted, core.MintedPAT{}
				case "logout-device":
					f.plan = append([]string{"validate"}, f.plan...)
					s.ops.validateDeviceLogout = func(principal model.Principal) error { f.hit("validate"); f.equal(principal, p); return nil }
					s.ops.logoutDevice = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal) error {
						f.hit(operation)
						f.bound(ctx, dao)
						f.equal(principal, p)
						return lower
					}
					err = s.LogoutDevice(f.ctx, p)
				}
				if stage == "success" {
					if err != nil {
						t.Fatal(err)
					}
					f.equal(got, want)
				} else {
					if err == nil {
						t.Fatal("failure returned success")
					}
					f.equal(got, zero)
					if lower != nil && err != lower {
						t.Fatalf("lower identity lost: %v", err)
					}
					if stage == "completion-error" && !errors.Is(err, failure) {
						t.Fatalf("completion cause=%v", err)
					}
				}
			})
		}
	}
}

func TestRunPreservesRefusalCompletionAndDatabasePriority(t *testing.T) {
	original := errors.New("original cause")
	fault := &model.Fault{Code: "rate_limited", Cause: original}
	grant := &core.DeviceGrantError{Code: "slow_down"}
	db := &store.Error{DatabaseFailure: true, SQLState: "23505", Cause: fault}
	for _, operation := range []error{fault, grant, db, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionUnknown, Cause: fault}, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: fault}, original} {
		for _, completionError := range []error{nil, context.Canceled} {
			t.Run(operation.Error()+"/"+fmtError(completionError), func(t *testing.T) {
				f := newIdentityFixture(t)
				f.transaction()
				f.plan = []string{"write", "operation", "finish"}
				capture := operation == fault || operation == grant
				var transaction *store.TransactionError
				if errors.As(operation, &transaction) && transaction.Phase == "operation" && transaction.Outcome == store.TransactionNotCommitted && !transaction.CleanupFailed {
					capture = true
				}
				if !capture {
					f.transactions[0].callbackErr = operation
					f.transactions[0].err = operation
				}
				if completionError != nil {
					f.transactions[0].err = completionError
				}
				err := f.identity.run(f.ctx, func(scope store.IdentityScope) error {
					f.hit("operation")
					if scope != f.scope {
						t.Fatal("scope changed")
					}
					return operation
				})
				want := operation
				if completionError != nil {
					want = completionError
				}
				if err != want {
					t.Fatalf("run error=%v want original=%v", err, want)
				}
			})
		}
	}
}
func fmtError(err error) string {
	if err == nil {
		return "committed"
	}
	return err.Error()
}

func TestNewBindsProductionOperations(t *testing.T) {
	s := New(nil, nil, "https://example.test/callback")
	if s.now == nil || s.CallbackURL() != "https://example.test/callback" || s.ValidateLogin("github", "/") != nil {
		t.Fatal("constructor dependencies missing")
	}
	value := reflect.ValueOf(s.ops)
	for i := 0; i < value.NumField(); i++ {
		if value.Field(i).IsNil() {
			t.Fatalf("unbound operation %s", value.Type().Field(i).Name)
		}
	}
	if delta := time.Since(s.now()); delta < -time.Second || delta > time.Second {
		t.Fatalf("production clock changed: %s", delta)
	}
}
