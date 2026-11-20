package webhook

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type authorizationReadScope struct {
	store.WebhookReadScope
	read func(context.Context, model.Principal, model.CredentialPolicyProfile) (model.CredentialAuthorization, error)
}

func (s authorizationReadScope) CurrentWebhookAuthorization(ctx context.Context, principal model.Principal, profile model.CredentialPolicyProfile) (model.CredentialAuthorization, error) {
	return s.read(ctx, principal, profile)
}

func TestAuthorizedWebhookEntrypointsRejectInvalidPolicyBeforeStorage(t *testing.T) {
	ctx := t.Context()
	svc := &Service{} // A bad authorization must never reach the storage boundary.
	auth := model.CredentialAuthorization{}
	owner := Owner{Kind: "personal", ID: "owner"}
	for _, tc := range []struct {
		name string
		call func() (any, error)
	}{
		{"catalog", func() (any, error) { return svc.CatalogAuthorized(ctx, auth) }},
		{"list", func() (any, error) { return svc.ListAuthorized(ctx, auth, owner, ListQuery{}) }},
		{"get", func() (any, error) { return svc.GetAuthorized(ctx, auth, owner, "endpoint") }},
		{"operation", func() (any, error) { return svc.OperationAuthorized(ctx, auth, owner, "operation") }},
		{"secret", func() (any, error) { return svc.SecretAuthorized(ctx, auth, owner, "endpoint") }},
		{"delivery", func() (any, error) { return svc.GetDeliveryAuthorized(ctx, auth, owner, "endpoint", "delivery") }},
		{"payload", func() (any, error) { return svc.PayloadAuthorized(ctx, auth, owner, "endpoint", "delivery") }},
		{"deliveries", func() (any, error) {
			return svc.ListDeliveriesAuthorized(ctx, auth, owner, "endpoint", DeliveryQuery{})
		}},
		{"attempts", func() (any, error) {
			return svc.ListAttemptsAuthorized(ctx, auth, owner, "endpoint", "delivery", AttemptQuery{})
		}},
		{"mutate", func() (any, error) { _, err := svc.MutateAuthorized(ctx, auth, owner, Mutation{}); return nil, err }},
		{"redeliver", func() (any, error) {
			_, err := svc.RedeliverAuthorized(ctx, auth, owner, "endpoint", "delivery", Redelivery{})
			return nil, err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := tc.call()
			if result != nil || err == nil {
				t.Fatalf("result=%v, error=%v; invalid authorization must be rejected", result, err)
			}
		})
	}
}

func TestWebhookAuthorizationRechecksOriginalIdentityAndSource(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	auth := webhookReadAuth(t, p, "webhook:read")
	ctx, err := scopedContext(t.Context(), auth)
	if err != nil {
		t.Fatal(err)
	}
	other := p
	other.CredentialID = "33333333-3333-4333-8333-333333333333"
	failure := errors.New("authorization source unavailable")
	calls := 0
	source := authorizationReadScope{read: func(_ context.Context, got model.Principal, profile model.CredentialPolicyProfile) (model.CredentialAuthorization, error) {
		calls++
		if got != p || profile != auth.Profile {
			t.Fatalf("authorization lookup: %v %v", got, profile)
		}
		return auth, nil
	}}
	if err = requireScope(ctx, source, other, scopepolicy.WebhookRead); err == nil || calls != 0 {
		t.Fatalf("mismatched request: calls=%d err=%v", calls, err)
	}
	if err = requireScope(ctx, historyReadScopeMock{}, p, scopepolicy.WebhookRead); err == nil {
		t.Fatal("accepted a snapshot without an authorization source")
	}
	for _, tc := range []struct {
		name    string
		current model.CredentialAuthorization
		err     error
		fault   string
	}{
		{"revoked credential", auth, model.ErrNotFound, "unauthenticated"},
		{"source failure", auth, failure, ""},
		{"different credential", webhookReadAuth(t, other, "webhook:read"), nil, ""},
		{"different profile", model.CredentialAuthorization{Principal: p, Profile: model.SessionProfile}, nil, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			sc := authorizationReadScope{read: func(_ context.Context, got model.Principal, profile model.CredentialPolicyProfile) (model.CredentialAuthorization, error) {
				calls++
				if got != p || profile != auth.Profile {
					t.Errorf("lookup principal=%v profile=%v", got, profile)
				}
				return tc.current, tc.err
			}}
			err := requireScope(ctx, sc, p, scopepolicy.WebhookRead)
			if calls != 1 || err == nil {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
			if tc.fault != "" {
				mgmtWantFault(t, err, tc.fault)
			}
			if tc.err == failure && !errors.Is(err, failure) {
				t.Fatalf("source error lost: %v", err)
			}
		})
	}
}
