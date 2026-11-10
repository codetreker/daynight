package oauth

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func decisionSteps() []string {
	return []string{"valid binding", "valid decision", "writer authorization", "scope authorization", "scope identity", "lock session", "read authorization", "fresh", "scope identity", "lock session", "decide", "update authorization", "callback returned", "writer returned"}
}
func configureDecision(f *oauthFixture, s *Authorizations, in DecisionInput, record, updated store.OAuthAuthorization, fresh time.Time) {
	s.operations.validBinding = func(binding string) bool { f.step("valid binding"); f.equal(binding, in.Binding); return true }
	s.operations.validDecision = func(decision string) bool { f.step("valid decision"); f.equal(decision, in.Decision); return true }
	times := []time.Time{f.now, fresh}
	f.identity.lock = func(p model.Principal, now time.Time) error {
		f.equal(p, in.Principal)
		if len(times) == 0 {
			f.t.Fatal("extra session verification")
		}
		f.equal(now, times[0])
		times = times[1:]
		return nil
	}
	f.authorization.read = func(id string, lock bool) (store.OAuthAuthorization, error) {
		f.equal(id, in.RequestID)
		f.equal(lock, true)
		return cloneAuthorization(record), nil
	}
	f.authorization.fresh = func(now time.Time) (time.Time, error) { f.equal(now, f.now); return fresh, nil }
	s.operations.decide = func(a *store.OAuthAuthorization, binding, decision, user, issuer string, now time.Time) (string, error) {
		f.step("decide")
		if !f.active {
			f.t.Fatal("Core decision outside callback")
		}
		f.equal(*a, record)
		f.equal([]string{binding, decision, user, issuer}, []string{in.Binding, in.Decision, in.Principal.UserID, s.issuer})
		f.equal(now, fresh)
		*a = cloneAuthorization(updated)
		return "https://client.example/cb?code=controlled", nil
	}
	f.authorization.update = func(a store.OAuthAuthorization) error { f.equal(a, updated); return nil }
}
func TestAuthorizationDecisionCoordinatesMutationAndCompletion(t *testing.T) {
	for _, mode := range []string{"success", "core refusal", "update error", "writer error", "unknown", "not committed"} {
		t.Run(mode, func(t *testing.T) {
			steps := decisionSteps()
			if mode == "core refusal" {
				steps = append(append([]string{}, steps[:11]...), steps[12:]...)
			}
			f := newOAuthFixture(t, steps...)
			s := f.service()
			p := fixturePrincipal()
			record := fixtureAuthorization(uuid.NewString(), f.now)
			code := core.CodePrefix + strings.Repeat("c", 43)
			fresh := f.now.Add(2 * time.Minute)
			updated := fixtureApprovedAuthorization(record, p.UserID, code, fresh)
			if mode == "core refusal" {
				record = cloneAuthorization(updated)
			}
			in := DecisionInput{RequestID: record.ID, Binding: "browser-binding", ExpectedUserID: p.UserID, Decision: "approve", Principal: p}
			configureDecision(f, s, in, record, updated, fresh)
			failure := errors.New("decision write failed")
			callbackErr, finalErr := error(nil), error(nil)
			outcome := store.TransactionCommitted
			switch mode {
			case "core refusal":
				s.operations.decide = func(a *store.OAuthAuthorization, b, d, u, i string, now time.Time) (string, error) {
					f.step("decide")
					f.equal(*a, record)
					f.equal([]string{b, d, u, i}, []string{in.Binding, in.Decision, p.UserID, s.issuer})
					f.equal(now, fresh)
					return "partial redirect", core.ErrInvalidAuthorization
				}
				callbackErr = core.ErrInvalidAuthorization
				finalErr = core.ErrInvalidAuthorization
			case "update error":
				f.authorization.update = func(a store.OAuthAuthorization) error { f.equal(a, updated); return failure }
				callbackErr = failure
				finalErr = failure
			case "writer error":
				finalErr = failure
			case "unknown":
				outcome = store.TransactionUnknown
				finalErr = model.ErrNotFound
			case "not committed":
				outcome = store.TransactionNotCommitted
			}
			f.plan("authorization", true, callbackErr, outcome, finalErr)
			got, err := s.Decide(f.ctx, in)
			if mode == "success" {
				if err != nil {
					t.Fatal(err)
				}
				f.equal(got, DecisionResult{RedirectURI: "https://client.example/cb?code=controlled"})
			} else {
				f.equal(got, DecisionResult{})
				if err == nil {
					t.Fatal("decision failure exposed result")
				}
				if mode == "unknown" {
					checkAuthorizationError(t, err, core.ErrAuthorizationUnknown)
				} else if finalErr != nil && err != finalErr {
					t.Fatal(err)
				}
			}
		})
	}
}
func TestAuthorizationDecisionRejectsAdmissionBeforeScope(t *testing.T) {
	for _, mode := range []string{"principal", "request ID", "expected user", "binding", "decision"} {
		t.Run(mode, func(t *testing.T) {
			steps := []string{}
			if mode == "binding" || mode == "decision" {
				steps = append(steps, "valid binding")
			}
			if mode == "decision" {
				steps = append(steps, "valid decision")
			}
			f := newOAuthFixture(t, steps...)
			s := f.service()
			p := fixturePrincipal()
			if mode == "expected user" {
				p = model.Principal{Kind: model.SessionCredential, UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444"}
			}
			in := DecisionInput{RequestID: uuid.NewString(), Binding: "binding", ExpectedUserID: p.UserID, Principal: p, Decision: "approve"}
			switch mode {
			case "principal":
				in.Principal = model.Principal{}
			case "request ID":
				in.RequestID = "bad"
			case "expected user":
				in.ExpectedUserID = "a1111111-1111-4111-8111-111111111111"
			case "binding":
				s.operations.validBinding = func(b string) bool { f.step("valid binding"); f.equal(b, in.Binding); return false }
			case "decision":
				s.operations.validBinding = func(b string) bool { f.step("valid binding"); f.equal(b, in.Binding); return true }
				s.operations.validDecision = func(d string) bool { f.step("valid decision"); f.equal(d, in.Decision); return false }
			}
			got, err := s.Decide(f.ctx, in)
			f.equal(got, DecisionResult{})
			if mode == "principal" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
					t.Fatal(err)
				}
			} else {
				checkAuthorizationError(t, err, core.ErrInvalidAuthorization)
			}
		})
	}
}
func TestAuthorizationDecisionRechecksSessionAfterRequestWait(t *testing.T) {
	for _, phase := range []string{"first session", "request missing", "fresh", "second session"} {
		t.Run(phase, func(t *testing.T) {
			all := decisionSteps()
			end := 10
			switch phase {
			case "first session":
				end = 6
			case "request missing":
				end = 7
			case "fresh":
				end = 8
			}
			steps := append(append([]string{}, all[:end]...), "callback returned", "writer returned")
			f := newOAuthFixture(t, steps...)
			s := f.service()
			p := fixturePrincipal()
			a := fixtureAuthorization(uuid.NewString(), f.now)
			fresh := f.now.Add(2 * time.Hour)
			in := DecisionInput{RequestID: a.ID, Binding: "binding", ExpectedUserID: p.UserID, Principal: p, Decision: "approve"}
			configureDecision(f, s, in, a, a, fresh)
			failure := errors.New("fresh time failed")
			callbackErr, finalErr, want := error(failure), error(failure), error(failure)
			switch phase {
			case "first session":
				f.identity.lock = func(got model.Principal, now time.Time) error {
					f.equal(got, p)
					f.equal(now, f.now)
					return model.ErrNotFound
				}
				callbackErr = model.Unauthenticated(nil)
				finalErr = callbackErr
				want = callbackErr
			case "request missing":
				f.authorization.read = func(id string, lock bool) (store.OAuthAuthorization, error) {
					f.equal(id, a.ID)
					f.equal(lock, true)
					return store.OAuthAuthorization{}, model.ErrNotFound
				}
				callbackErr = model.ErrNotFound
				finalErr = model.ErrNotFound
				want = core.ErrInvalidAuthorization
			case "fresh":
				f.authorization.fresh = func(now time.Time) (time.Time, error) { f.equal(now, f.now); return time.Time{}, failure }
			case "second session":
				calls := 0
				f.identity.lock = func(got model.Principal, now time.Time) error {
					f.equal(got, p)
					calls++
					if calls == 1 {
						f.equal(now, f.now)
						return nil
					}
					f.equal(now, fresh)
					return model.ErrNotFound
				}
				callbackErr = model.Unauthenticated(nil)
				finalErr = callbackErr
				want = callbackErr
			}
			f.plan("authorization", true, callbackErr, store.TransactionNotCommitted, finalErr)
			got, err := s.Decide(f.ctx, in)
			f.equal(got, DecisionResult{})
			checkAuthorizationError(t, err, want)
		})
	}
}
