package webhook

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type scopedReadFixture struct {
	store.WebhookReadScope
	auth model.CredentialAuthorization
	err  error
}

func (s scopedReadFixture) CurrentWebhookAuthorization(_ context.Context, p model.Principal, profile model.CredentialPolicyProfile) (model.CredentialAuthorization, error) {
	if p != s.auth.Principal || profile != s.auth.Profile {
		return model.CredentialAuthorization{}, errors.New("wrong principal or profile")
	}
	return s.auth, s.err
}

func webhookReadAuth(t *testing.T, p model.Principal, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
}

func scopedManagementRead(t *testing.T, scopes ...scopepolicy.ScopeID) (*mgmtFixture, model.CredentialAuthorization, *scopedReadFixture) {
	t.Helper()
	f := newMgmtFixture(t)
	f.principal.Kind = model.PATCredential
	auth := webhookReadAuth(t, f.principal, scopes...)
	sc := &scopedReadFixture{WebhookReadScope: f.pre, auth: auth}
	f.db.ReadFn = func(_ context.Context, fn func(store.WebhookReadScope) error) error { return fn(sc) }
	return f, auth, sc
}

func TestScopedWebhookReadRequiresCurrentPolicy(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(*mgmtFixture, model.CredentialAuthorization) (any, error)
	}{
		{"catalog", func(f *mgmtFixture, a model.CredentialAuthorization) (any, error) {
			return f.service.CatalogAuthorized(f.ctx, a)
		}},
		{"list", func(f *mgmtFixture, a model.CredentialAuthorization) (any, error) {
			return f.service.ListAuthorized(f.ctx, a, f.owner, ListQuery{})
		}},
		{"endpoint", func(f *mgmtFixture, a model.CredentialAuthorization) (any, error) {
			return f.service.GetAuthorized(f.ctx, a, f.owner, f.endpoint.ID)
		}},
		{"operation", func(f *mgmtFixture, a model.CredentialAuthorization) (any, error) {
			return f.service.OperationAuthorized(f.ctx, a, f.owner, f.endpoint.ID)
		}},
		{"delivery", func(f *mgmtFixture, a model.CredentialAuthorization) (any, error) {
			return f.service.GetDeliveryAuthorized(f.ctx, a, f.owner, f.endpoint.ID, "delivery")
		}},
		{"payload", func(f *mgmtFixture, a model.CredentialAuthorization) (any, error) {
			return f.service.PayloadAuthorized(f.ctx, a, f.owner, f.endpoint.ID, "delivery")
		}},
		{"deliveries", func(f *mgmtFixture, a model.CredentialAuthorization) (any, error) {
			return f.service.ListDeliveriesAuthorized(f.ctx, a, f.owner, f.endpoint.ID, DeliveryQuery{})
		}},
		{"attempts", func(f *mgmtFixture, a model.CredentialAuthorization) (any, error) {
			return f.service.ListAttemptsAuthorized(f.ctx, a, f.owner, f.endpoint.ID, "delivery", AttemptQuery{})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			f := r.mgmtFixture
			f.principal.Kind = model.PATCredential
			auth := webhookReadAuth(t, f.principal, "webhook:read")
			current := &scopedReadFixture{WebhookReadScope: f.pre, auth: auth}
			f.db.ReadFn = func(_ context.Context, fn func(store.WebhookReadScope) error) error { return fn(current) }
			f.preDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) {
				return wm.Operation{ActorID: f.principal.UserID, ExpiresAt: f.now.Add(time.Hour)}, nil
			}
			f.preDAO.HistoryDeliveryFn = func(context.Context, wm.Owner, string, string) (store.WebhookDelivery, error) { return r.delivery, nil }
			f.preDAO.HistorySourcesFn = f.writer.HistorySourcesFn
			// The policy narrowed after authentication: each path must use the snapshot's policy.
			current.auth = webhookReadAuth(t, f.principal, "webhook:write")
			value, err := tc.call(f, auth)
			if value != nil {
				t.Fatalf("disclosed result: %#v", value)
			}
			mgmtWantFault(t, err, "insufficient_scope")
		})
	}
}

func TestScopedWebhookSecretAndCapabilitiesAreIndependent(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		scopes                  []scopepolicy.ScopeID
		manage, secret, deliver bool
	}{
		{"read only", []scopepolicy.ScopeID{"webhook:read"}, false, false, false},
		{"write and read", []scopepolicy.ScopeID{"webhook:read", "webhook:write"}, true, false, false},
		{"secret and read", []scopepolicy.ScopeID{"webhook:read", "webhook:secret"}, false, true, false},
		{"deliver and read", []scopepolicy.ScopeID{"webhook:deliver", "webhook:read"}, false, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, auth, _ := scopedManagementRead(t, tc.scopes...)
			result, err := f.service.GetAuthorized(f.ctx, auth, f.owner, f.endpoint.ID)
			if err != nil {
				t.Fatal(err)
			}
			caps := result.(map[string]any)["capabilities"].(map[string]any)
			if caps["manage"] != tc.manage || caps["readSecret"] != tc.secret || caps["redeliver"] != tc.deliver {
				t.Fatalf("capabilities=%v", caps)
			}
			secret, err := f.service.SecretAuthorized(f.ctx, auth, f.owner, f.endpoint.ID)
			if !tc.secret {
				if secret != nil {
					t.Fatalf("secret disclosed: %#v", secret)
				}
				mgmtWantFault(t, err, "insufficient_scope")
			} else if err != nil || secret == nil {
				t.Fatalf("secret=%#v err=%v", secret, err)
			}
		})
	}
	// Secret is independently usable without general read.
	f, auth, _ := scopedManagementRead(t, "webhook:secret")
	if value, err := f.service.SecretAuthorized(f.ctx, auth, f.owner, f.endpoint.ID); err != nil || value == nil {
		t.Fatalf("secret=%#v err=%v", value, err)
	}
}

func TestScopedWebhookReadRejectsAuthorizationFailure(t *testing.T) {
	f, auth, current := scopedManagementRead(t, "webhook:read")
	failure := errors.New("policy source unavailable")
	current.err = failure
	if result, err := f.service.GetAuthorized(f.ctx, auth, f.owner, f.endpoint.ID); result != nil || !errors.Is(err, failure) {
		t.Fatalf("result=%#v err=%v", result, err)
	}
}

func TestScopedWebhookMissingResourcesKeepOriginalRefusal(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(*mgmtFixture, model.CredentialAuthorization) (any, error)
	}{
		{"endpoint", func(f *mgmtFixture, a model.CredentialAuthorization) (any, error) {
			return f.service.GetAuthorized(f.ctx, a, f.owner, f.endpoint.ID)
		}},
		{"secret", func(f *mgmtFixture, a model.CredentialAuthorization) (any, error) {
			return f.service.SecretAuthorized(f.ctx, a, f.owner, f.endpoint.ID)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, auth, _ := scopedManagementRead(t, "webhook:write")
			f.preDAO.EndpointFn = func(context.Context, wm.Owner, string) (wm.Endpoint, error) { return wm.Endpoint{}, model.ErrNotFound }
			_, err := tc.call(f, auth)
			mgmtWantFault(t, err, "not_found")
		})
	}
	f, auth, _ := scopedManagementRead(t, "webhook:write")
	f.preDAO.EndpointFn = func(context.Context, wm.Owner, string) (wm.Endpoint, error) {
		ep := f.endpoint
		ep.DeletedAt = &f.now
		return ep, nil
	}
	_, err := f.service.SecretAuthorized(f.ctx, auth, f.owner, f.endpoint.ID)
	mgmtWantFault(t, err, "not_found")
}
