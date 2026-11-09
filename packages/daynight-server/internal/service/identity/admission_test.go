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
)

func TestDirectAdmissionStopsBeforeTransaction(t *testing.T) {
	for _, operation := range []string{"validate-login", "callback", "authenticate", "logout", "create", "list", "revoke", "expiry", "start-device", "redeem", "logout-device"} {
		t.Run(operation, func(t *testing.T) {
			f := newIdentityFixture(t)
			s := f.identity
			p := model.Principal{Kind: model.PATCredential, UserID: "account", CredentialID: "credential"}
			refusal := &model.Fault{Code: "invalid_input"}
			f.plan = []string{"admission"}
			var err error
			switch operation {
			case "validate-login":
				s.ops.validateLogin = func(provider, path string) error {
					f.hit("admission")
					f.equal([]any{provider, path}, []any{"raw-provider", "/raw?view#fragment"})
					return refusal
				}
				err = s.ValidateLogin("raw-provider", "/raw?view#fragment")
			case "callback":
				q := url.Values{"state": {"!", "duplicate"}, "code": {"raw"}}
				s.ops.validateCallback = func(query url.Values, binding string) error {
					f.hit("admission")
					f.equal(query, q)
					f.equal(binding, "raw-binding")
					return refusal
				}
				_, err = s.CompleteLogin(f.ctx, q, "raw-binding")
			case "authenticate":
				s.ops.validateCredential = func(kind model.CredentialKind, value string) error {
					f.hit("admission")
					f.equal([]any{kind, value}, []any{model.PATCredential, "raw"})
					return refusal
				}
				_, err = s.Authenticate(f.ctx, model.PATCredential, "raw")
			case "logout", "list":
				s.ops.validateSession = func(got model.Principal) error { f.hit("admission"); f.equal(got, p); return refusal }
				if operation == "logout" {
					err = s.Logout(f.ctx, p)
				} else {
					_, err = s.ListPATs(f.ctx, p)
				}
			case "create":
				input := core.CreatePAT{Name: "bad\x00name", ExpiresAt: &f.now}
				s.ops.validateCreatePAT = func(got model.Principal, in core.CreatePAT, now time.Time) (*time.Time, error) {
					f.hit("admission")
					f.equal([]any{got, in, now}, []any{p, input, f.now})
					return nil, refusal
				}
				_, err = s.CreatePAT(f.ctx, p, input)
			case "revoke":
				s.ops.validateRevokePAT = func(got model.Principal, id string) (string, error) {
					f.hit("admission")
					f.equal([]any{got, id}, []any{p, "invalid-id"})
					return "", refusal
				}
				err = s.RevokePAT(f.ctx, p, "invalid-id")
			case "expiry":
				input := core.UpdatePATExpiry{ExpectedUserID: "other", ExpiresAt: &f.now}
				s.ops.validateUpdatePATExpiry = func(got model.Principal, id string, in core.UpdatePATExpiry, now time.Time) (string, *time.Time, error) {
					f.hit("admission")
					f.equal([]any{got, id, in, now}, []any{p, "invalid-id", input, f.now})
					return "", nil, refusal
				}
				_, err = s.UpdatePATExpiry(f.ctx, p, "invalid-id", input)
			case "start-device":
				s.ops.validateDeviceClient = func(client string) error { f.hit("admission"); f.equal(client, "other"); return refusal }
				_, err = s.StartDevice(f.ctx, "other", "raw-source")
			case "redeem":
				s.ops.validateDeviceRedemption = func(client, grant, code, name string) error {
					f.hit("admission")
					f.equal([]any{client, grant, code, name}, []any{"client", "grant", "raw-code", "bad\x00name"})
					return refusal
				}
				_, err = s.RedeemDevice(f.ctx, "client", "grant", "raw-code", "bad\x00name")
			case "logout-device":
				s.ops.validateDeviceLogout = func(got model.Principal) error { f.hit("admission"); f.equal(got, p); return refusal }
				err = s.LogoutDevice(f.ctx, p)
			}
			if err != refusal || f.calls.Load() != 0 {
				t.Fatalf("refusal=%v HTTP=%d", err, f.calls.Load())
			}
		})
	}
}

func TestPersonalOwnershipValidationIsCoordinatedWithinScope(t *testing.T) {
	for _, operation := range []string{"user", "personal"} {
		t.Run(operation, func(t *testing.T) {
			f := newIdentityFixture(t)
			p := model.Principal{UserID: "account"}
			facts := store.PersonalTeamFacts{ID: "personal-team", MemberCount: 0, OwnerAdminCount: 0}
			failure := errors.New("ownership integrity")
			f.plan = []string{"write", "lookup", "validate", "finish"}
			f.transaction()
			f.identity.ops.user = func(ctx context.Context, dao store.IdentityDAO, got model.Principal) (model.User, store.PersonalTeamFacts, error) {
				f.hit("lookup")
				f.bound(ctx, dao)
				f.equal(got, p)
				return model.User{ID: p.UserID, UniAuthID: "subject"}, facts, nil
			}
			f.identity.ops.personalTeam = func(ctx context.Context, dao store.IdentityDAO, got model.Principal) (store.PersonalTeamFacts, error) {
				f.hit("lookup")
				f.bound(ctx, dao)
				f.equal(got, p)
				return facts, nil
			}
			f.identity.ops.validatePersonalTeam = func(got store.PersonalTeamFacts) error { f.hit("validate"); f.equal(got, facts); return failure }
			// The service deliberately converts the rule's error into its existing operational message.
			f.transactions[0].callbackErr = nil
			f.identity.writer = &personalFailureWriter{fixture: f}
			var err error
			if operation == "user" {
				var got model.User
				got, err = f.identity.User(f.ctx, p)
				f.equal(got, model.User{})
			} else {
				var id string
				id, err = f.identity.PersonalTeamID(f.ctx, p)
				f.equal(id, "")
			}
			if err == nil || err.Error() != "user Personal Team is missing or invalid" || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("ownership error=%v", err)
			}
		})
	}
}

type personalFailureWriter struct{ fixture *identityFixture }

func (w *personalFailureWriter) WriteIdentity(ctx context.Context, operation func(store.IdentityScope) error) (store.Completion, error) {
	f := w.fixture
	f.hit("write")
	if ctx != f.ctx || len(f.transactions) != 1 {
		f.t.Fatal("unexpected personal scope")
	}
	f.scope = f.transactions[0].scope
	f.transactions = nil
	err := operation(f.scope)
	f.hit("finish")
	if err == nil || err.Error() != "user Personal Team is missing or invalid" {
		f.t.Fatalf("unexpected callback error=%v", err)
	}
	return store.Completion{Outcome: store.TransactionNotCommitted}, err
}
