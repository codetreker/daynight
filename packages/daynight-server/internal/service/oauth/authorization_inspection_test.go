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

func configureInspection(f *oauthFixture, s *Authorizations, id, binding string, p model.Principal, record store.OAuthAuthorization, fresh time.Time) {
	s.operations.validBinding = func(got string) bool { f.step("valid binding"); f.equal(got, binding); return true }
	times := []time.Time{f.now, fresh}
	f.identity.lock = func(got model.Principal, now time.Time) error {
		f.equal(got, p)
		if len(times) == 0 {
			f.t.Fatal("extra session lock")
		}
		f.equal(now, times[0])
		times = times[1:]
		return nil
	}
	f.authorization.read = func(got string, lock bool) (store.OAuthAuthorization, error) {
		f.equal(got, id)
		f.equal(lock, false)
		return cloneAuthorization(record), nil
	}
	f.authorization.fresh = func(now time.Time) (time.Time, error) { f.equal(now, f.now); return fresh, nil }
	s.operations.bound = func(got store.OAuthAuthorization, gotBinding string) bool {
		f.step("bound")
		if f.active {
			f.t.Fatal("binding projected before completion")
		}
		f.equal(got, record)
		f.equal(gotBinding, binding)
		return true
	}
	s.operations.status = func(got store.OAuthAuthorization, now time.Time) (string, bool) {
		f.step("status")
		if f.active {
			f.t.Fatal("status projected before completion")
		}
		f.equal(got, record)
		f.equal(now, fresh)
		return "approved", true
	}
}
func inspectionSteps() []string {
	return []string{"valid binding", "writer authorization", "scope identity", "lock session", "scope authorization", "read authorization", "scope authorization", "fresh", "scope identity", "lock session", "callback returned", "writer returned", "bound", "status"}
}
func TestAuthorizationInspectionReturnsCompleteProjection(t *testing.T) {
	for _, status := range []string{"pending", "approved", "expired", "consumed"} {
		t.Run(status, func(t *testing.T) {
			f := newOAuthFixture(t, inspectionSteps()...)
			s := f.service()
			p := fixturePrincipal()
			record := fixtureAuthorization(uuid.NewString(), f.now)
			switch status {
			case "approved", "consumed":
				record = fixtureApprovedAuthorization(record, p.UserID, core.CodePrefix+strings.Repeat("c", 43), f.now)
				if status == "approved" {
					expiry := f.now.Add(-time.Second)
					record.CodeExpiresAt = &expiry
				} else {
					record.Status = "consumed"
					record.GrantID = uuid.NewString()
					record.RetainUntil = f.now.Add(core.GrantLifetime)
				}
			case "expired":
				record.Status = "expired"
				record.State, record.StatePresent = "", false
				record.ExpiresAt = f.now.Add(-time.Second)
			}
			fresh := f.now.Add(time.Minute)
			configureInspection(f, s, record.ID, "browser-binding", p, record, fresh)
			s.operations.status = func(got store.OAuthAuthorization, now time.Time) (string, bool) {
				f.step("status")
				f.equal(got, record)
				f.equal(now, fresh)
				return status, status == "approved"
			}
			f.plan("authorization", true, nil, store.TransactionCommitted, nil)
			got, err := s.Inspect(f.ctx, record.ID, "browser-binding", p)
			if err != nil {
				t.Fatal(err)
			}
			f.equal(got, AuthorizationView{RequestID: record.ID, Status: status, UserID: p.UserID, ClientName: "Example", ClientID: record.ClientID, ClientProvenance: "preregistered", RedirectURI: record.RedirectURI, Resource: record.Resource, Scope: record.Scope, CodeExpired: status == "approved"})
		})
	}
}
func TestAuthorizationInspectionRejectsPrincipalIDBindingAndSnapshot(t *testing.T) {
	t.Run("principal", func(t *testing.T) {
		f := newOAuthFixture(t)
		got, err := f.service().Inspect(f.ctx, uuid.NewString(), "binding", model.Principal{})
		f.equal(got, AuthorizationView{})
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
			t.Fatal(err)
		}
	})
	t.Run("noncanonical request", func(t *testing.T) {
		f := newOAuthFixture(t)
		got, err := f.service().Inspect(f.ctx, "bad", "binding", fixturePrincipal())
		f.equal(got, AuthorizationView{})
		checkAuthorizationError(t, err, core.ErrInvalidAuthorization)
	})
	t.Run("invalid binding format", func(t *testing.T) {
		f := newOAuthFixture(t, "valid binding")
		s := f.service()
		s.operations.validBinding = func(got string) bool { f.step("valid binding"); f.equal(got, "bad-binding"); return false }
		got, err := s.Inspect(f.ctx, uuid.NewString(), "bad-binding", fixturePrincipal())
		f.equal(got, AuthorizationView{})
		checkAuthorizationError(t, err, core.ErrInvalidAuthorization)
	})
	for _, mode := range []string{"wrong browser binding", "array snapshot"} {
		t.Run(mode, func(t *testing.T) {
			steps := inspectionSteps()
			steps = steps[:len(steps)-1]
			f := newOAuthFixture(t, steps...)
			s := f.service()
			p := fixturePrincipal()
			record := fixtureAuthorization(uuid.NewString(), f.now)
			if mode == "array snapshot" {
				record.Client = []byte(`[]`)
			}
			configureInspection(f, s, record.ID, "binding", p, record, f.now)
			if mode == "wrong browser binding" {
				s.operations.bound = func(got store.OAuthAuthorization, b string) bool {
					f.step("bound")
					f.equal(got, record)
					f.equal(b, "binding")
					return false
				}
			}
			f.plan("authorization", true, nil, store.TransactionCommitted, nil)
			got, err := s.Inspect(f.ctx, record.ID, "binding", p)
			f.equal(got, AuthorizationView{})
			checkAuthorizationError(t, err, core.ErrInvalidAuthorization)
		})
	}
}
func TestAuthorizationInspectionStopsAtScopeFailures(t *testing.T) {
	for _, phase := range []string{"writer", "first session", "read missing", "fresh", "second session", "unknown not found", "completion"} {
		t.Run(phase, func(t *testing.T) {
			all := inspectionSteps()
			end := len(all) - 2
			switch phase {
			case "writer":
				end = 2
			case "first session":
				end = 4
			case "read missing", "unknown not found":
				end = 6
			case "fresh":
				end = 8
			case "second session":
				end = 10
			}
			steps := append([]string{}, all[:end]...)
			if phase != "writer" {
				steps = append(steps, "callback returned")
			}
			steps = append(steps, "writer returned")
			if phase == "completion" {
				steps = append([]string{}, all[:len(all)-2]...)
			}
			f := newOAuthFixture(t, steps...)
			s := f.service()
			p := fixturePrincipal()
			record := fixtureAuthorization(uuid.NewString(), f.now)
			fresh := f.now.Add(2 * time.Hour)
			configureInspection(f, s, record.ID, "binding", p, record, fresh)
			failure := errors.New("inspection storage failed")
			callbackErr, finalErr := error(failure), error(failure)
			outcome := store.TransactionNotCommitted
			run := true
			want := error(failure)
			switch phase {
			case "writer":
				run = false
				callbackErr = nil
			case "first session":
				f.identity.lock = func(got model.Principal, now time.Time) error {
					f.equal(got, p)
					f.equal(now, f.now)
					return model.ErrNotFound
				}
				callbackErr = model.Unauthenticated(nil)
				finalErr = callbackErr
				want = callbackErr
			case "read missing", "unknown not found":
				f.authorization.read = func(id string, lock bool) (store.OAuthAuthorization, error) {
					f.equal(id, record.ID)
					f.equal(lock, false)
					return store.OAuthAuthorization{}, model.ErrNotFound
				}
				callbackErr = model.ErrNotFound
				finalErr = model.ErrNotFound
				want = core.ErrInvalidAuthorization
				if phase == "unknown not found" {
					outcome = store.TransactionUnknown
					want = core.ErrAuthorizationUnknown
				}
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
			case "completion":
				callbackErr = nil
				outcome = store.TransactionCommitted
			}
			f.plan("authorization", run, callbackErr, outcome, finalErr)
			got, err := s.Inspect(f.ctx, record.ID, "binding", p)
			f.equal(got, AuthorizationView{})
			checkAuthorizationError(t, err, want)
		})
	}
}
