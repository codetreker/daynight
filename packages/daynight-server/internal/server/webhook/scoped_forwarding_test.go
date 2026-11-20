package webhook

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type forwardingKey struct{}
type forwardingCall struct {
	name, endpoint, delivery string
	owner                    webhookservice.Owner
	query                    any
	auth                     model.CredentialAuthorization
	contextValue             any
}
type forwardingService struct {
	scopedService
	calls []forwardingCall
}

func (s *forwardingService) record(ctx context.Context, a model.CredentialAuthorization, name string, owner webhookservice.Owner, endpoint, delivery string, query any) (any, error) {
	s.calls = append(s.calls, forwardingCall{name, endpoint, delivery, owner, query, a, ctx.Value(forwardingKey{})})
	return map[string]string{"operation": name}, nil
}
func (s *forwardingService) CatalogAuthorized(c context.Context, a model.CredentialAuthorization) (any, error) {
	return s.record(c, a, "catalog", webhookservice.Owner{}, "", "", nil)
}
func (s *forwardingService) ListAuthorized(c context.Context, a model.CredentialAuthorization, o webhookservice.Owner, q webhookservice.ListQuery) (any, error) {
	return s.record(c, a, "list", o, "", "", q)
}
func (s *forwardingService) GetAuthorized(c context.Context, a model.CredentialAuthorization, o webhookservice.Owner, id string) (any, error) {
	return s.record(c, a, "get", o, id, "", nil)
}
func (s *forwardingService) OperationAuthorized(c context.Context, a model.CredentialAuthorization, o webhookservice.Owner, id string) (any, error) {
	return s.record(c, a, "operation", o, id, "", nil)
}
func (s *forwardingService) SecretAuthorized(c context.Context, a model.CredentialAuthorization, o webhookservice.Owner, id string) (any, error) {
	return s.record(c, a, "secret", o, id, "", nil)
}
func (s *forwardingService) ListDeliveriesAuthorized(c context.Context, a model.CredentialAuthorization, o webhookservice.Owner, endpoint string, q webhookservice.DeliveryQuery) (any, error) {
	return s.record(c, a, "deliveries", o, endpoint, "", q)
}
func (s *forwardingService) GetDeliveryAuthorized(c context.Context, a model.CredentialAuthorization, o webhookservice.Owner, endpoint, id string) (any, error) {
	return s.record(c, a, "delivery", o, endpoint, id, nil)
}
func (s *forwardingService) ListAttemptsAuthorized(c context.Context, a model.CredentialAuthorization, o webhookservice.Owner, endpoint, id string, q webhookservice.AttemptQuery) (any, error) {
	return s.record(c, a, "attempts", o, endpoint, id, q)
}
func (s *forwardingService) PayloadAuthorized(c context.Context, a model.CredentialAuthorization, o webhookservice.Owner, endpoint, id string) (any, error) {
	return s.record(c, a, "payload", o, endpoint, id, nil)
}
func (s *forwardingService) MutateAuthorized(c context.Context, a model.CredentialAuthorization, o webhookservice.Owner, m webhookservice.Mutation) (webhookservice.Result, error) {
	v, err := s.record(c, a, "mutate", o, m.EndpointID, "", m)
	return webhookservice.Result{Body: v}, err
}
func (s *forwardingService) RedeliverAuthorized(c context.Context, a model.CredentialAuthorization, o webhookservice.Owner, endpoint, id string, m webhookservice.Redelivery) (webhookservice.Result, error) {
	v, err := s.record(c, a, "redeliver", o, endpoint, id, m)
	return webhookservice.Result{Body: v}, err
}

func TestScopedWebhookReadRoutesForwardInputs(t *testing.T) {
	auth := model.CredentialAuthorization{Principal: model.Principal{Kind: model.SessionCredential, UserID: userID, CredentialID: operationID}, Profile: model.SessionProfile}
	s := &forwardingService{}
	mux := http.NewServeMux()
	if err := RegisterScopedRoutes(mux, s, testScopedAuth{auth}, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/teams/" + teamID + "/webhooks"
	enabled, generation, cursor := true, int64(7), "next"
	owner := webhookservice.Owner{Kind: "team", ID: teamID}
	tests := []struct {
		path, name, endpoint, delivery string
		owner                          webhookservice.Owner
		query                          any
	}{
		{"/api/v1/webhook-event-types", "catalog", "", "", webhookservice.Owner{}, nil},
		{base + "?q=alerts&enabled=true&limit=9&cursor=next", "list", "", "", owner, webhookservice.ListQuery{Query: "alerts", Enabled: &enabled, Limit: 9, Cursor: &cursor}},
		{base + "/" + endpointID, "get", endpointID, "", owner, nil},
		{base + "/operations/" + operationID, "operation", operationID, "", owner, nil},
		{base + "/" + endpointID + "/signing-secret", "secret", endpointID, "", owner, nil},
		{base + "/" + endpointID + "/deliveries?state=failed&limit=9&cursor=next", "deliveries", endpointID, "", owner, webhookservice.DeliveryQuery{State: "failed", Limit: 9, Cursor: &cursor}},
		{base + "/" + endpointID + "/deliveries/" + operationID, "delivery", endpointID, operationID, owner, nil},
		{base + "/" + endpointID + "/deliveries/" + operationID + "/attempts?generation=7&limit=9&cursor=next", "attempts", endpointID, operationID, owner, webhookservice.AttemptQuery{Generation: &generation, Limit: 9, Cursor: &cursor}},
		{base + "/" + endpointID + "/deliveries/" + operationID + "/payload", "payload", endpointID, operationID, owner, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s.calls = nil
			r := httptest.NewRequest(http.MethodGet, tc.path, nil)
			r = r.WithContext(context.WithValue(r.Context(), forwardingKey{}, "request-context"))
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			want := forwardingCall{tc.name, tc.endpoint, tc.delivery, tc.owner, tc.query, auth, "request-context"}
			if w.Code != http.StatusOK || w.Body.String() != fmt.Sprintf("{\"operation\":\"%s\"}\n", tc.name) || len(s.calls) != 1 || !reflect.DeepEqual(s.calls[0], want) {
				t.Fatalf("status=%d body=%s calls=%+v want=%+v", w.Code, w.Body.String(), s.calls, want)
			}
		})
	}
}

func TestScopedWebhookRejectsInvalidAuthenticationBeforeOperation(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: userID, CredentialID: operationID}
	s := &forwardingService{}
	mux := http.NewServeMux()
	if err := RegisterScopedRoutes(mux, s, testScopedAuth{model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile}}, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/webhook-event-types", nil))
	if w.Code != http.StatusUnauthorized || len(s.calls) != 0 {
		t.Fatalf("status=%d body=%s calls=%v", w.Code, w.Body.String(), s.calls)
	}

	adapter := scopedAdapter{s}
	owner := Owner{Kind: "personal", ID: userID}
	checks := []struct {
		name string
		call func(context.Context) error
	}{
		{"catalog", func(c context.Context) error { _, e := adapter.Catalog(c, principal); return e }},
		{"list", func(c context.Context) error { _, e := adapter.List(c, principal, owner, ListQuery{}); return e }},
		{"get", func(c context.Context) error { _, e := adapter.Get(c, principal, owner, endpointID); return e }},
		{"operation", func(c context.Context) error { _, e := adapter.Operation(c, principal, owner, operationID); return e }},
		{"secret", func(c context.Context) error { _, e := adapter.Secret(c, principal, owner, endpointID); return e }},
		{"mutate", func(c context.Context) error { _, e := adapter.Mutate(c, principal, owner, Mutation{}); return e }},
		{"deliveries", func(c context.Context) error {
			_, e := adapter.ListDeliveries(c, principal, owner, endpointID, webhookservice.DeliveryQuery{})
			return e
		}},
		{"delivery", func(c context.Context) error {
			_, e := adapter.GetDelivery(c, principal, owner, endpointID, operationID)
			return e
		}},
		{"attempts", func(c context.Context) error {
			_, e := adapter.ListAttempts(c, principal, owner, endpointID, operationID, webhookservice.AttemptQuery{})
			return e
		}},
		{"payload", func(c context.Context) error {
			_, e := adapter.Payload(c, principal, owner, endpointID, operationID)
			return e
		}},
		{"redeliver", func(c context.Context) error {
			_, e := adapter.Redeliver(c, principal, owner, endpointID, operationID, webhookservice.Redelivery{})
			return e
		}},
	}
	for _, tc := range checks {
		t.Run(tc.name, func(t *testing.T) {
			for _, ctx := range []context.Context{context.Background(), context.WithValue(context.Background(), scopedAuthorizationKey{}, model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile})} {
				err := tc.call(ctx)
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
					t.Fatalf("error=%v", err)
				}
			}
			if len(s.calls) != 0 {
				t.Fatalf("business call occurred: %+v", s.calls)
			}
		})
	}
}

func TestScopedWebhookRegistrationRejectsInvalidObservers(t *testing.T) {
	auth := testScopedAuth{model.CredentialAuthorization{Principal: model.Principal{Kind: model.SessionCredential, UserID: userID, CredentialID: operationID}, Profile: model.SessionProfile}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := &forwardingService{}
	for _, observers := range [][]func(ScopeRoute){{nil}, {func(ScopeRoute) {}, func(ScopeRoute) {}}} {
		mux := http.NewServeMux()
		if err := RegisterScopedRoutes(mux, s, auth, logger, observers...); err == nil {
			t.Fatal("accepted invalid route observers")
		}
		_, pattern := mux.Handler(httptest.NewRequest(http.MethodGet, "/api/v1/webhook-event-types", nil))
		if pattern != "" {
			t.Fatalf("installed route after invalid registration: %q", pattern)
		}
	}
}
