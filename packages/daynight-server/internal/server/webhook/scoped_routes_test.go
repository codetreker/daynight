package webhook

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type testScopedAuth struct{ authorization model.CredentialAuthorization }

func (a testScopedAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.authorization) }
}

type testScopedService struct {
	scopedService
	called     int
	auth       model.CredentialAuthorization
	mutation   webhookservice.Mutation
	redelivery webhookservice.Redelivery
	err        error
}

func (s *testScopedService) MutateAuthorized(_ context.Context, a model.CredentialAuthorization, _ webhookservice.Owner, m webhookservice.Mutation) (webhookservice.Result, error) {
	s.called++
	s.auth, s.mutation = a, m
	if s.err != nil {
		return webhookservice.Result{}, s.err
	}
	if m.ReturnReceipt {
		return webhookservice.Result{Body: map[string]any{"operationId": m.OperationID, "resourceId": endpointID}}, nil
	}
	return webhookservice.Result{Body: map[string]any{"name": "existing private name"}}, nil
}
func (s *testScopedService) RedeliverAuthorized(_ context.Context, a model.CredentialAuthorization, _ webhookservice.Owner, endpoint, delivery string, m webhookservice.Redelivery) (webhookservice.Result, error) {
	s.called++
	s.auth, s.redelivery = a, m
	if s.err != nil {
		return webhookservice.Result{}, s.err
	}
	return webhookservice.Result{Body: map[string]any{"operationId": m.OperationID, "resourceId": delivery}}, nil
}

func scopedFixture(t *testing.T, s *testScopedService, auth model.CredentialAuthorization) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	if err := RegisterScopedRoutes(mux, s, testScopedAuth{auth}, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	return mux
}

func TestScopedWebhookReceiptAndRefusal(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: userID, CredentialID: teamID}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"webhook:write"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}
	s := &testScopedService{}
	h := scopedFixture(t, s, auth)
	body := fmt.Sprintf(`{"operationId":"%s","issuedAt":"2026-11-07T08:00:00Z","expectedUserId":"%s","ifVersion":"1","name":"new"}`, operationID, userID)
	r := httptest.NewRequest(http.MethodPatch, "/api/v1/me/webhooks/"+endpointID, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Daynight-Return", "receipt-v1")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Header().Get("Daynight-Return") != "receipt-v1" || w.Body.String() != fmt.Sprintf("{\"operationId\":\"%s\",\"resourceId\":\"%s\"}\n", operationID, endpointID) || !s.mutation.ReturnReceipt || s.auth.Principal != principal {
		t.Fatalf("status=%d header=%q body=%s mutation=%+v auth=%+v", w.Code, w.Header().Get("Daynight-Return"), w.Body.String(), s.mutation, s.auth)
	}
	s.err = &model.Fault{Code: "insufficient_scope", Message: "Credential scope is insufficient.", Cause: scopepolicy.ErrInsufficientScope}
	r = httptest.NewRequest(http.MethodPatch, "/api/v1/me/webhooks/"+endpointID, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden || code(t, w) != "forbidden" || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || w.Header().Get("Daynight-Return") != "" || !strings.Contains(w.Body.String(), "scope is insufficient") {
		t.Fatalf("status=%d header=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
	if _, err := scopedAuthorization(context.Background(), principal); err == nil {
		t.Fatal("missing authorization accepted")
	}
	ctx := context.WithValue(context.Background(), scopedAuthorizationKey{}, auth)
	principal.CredentialID = endpointID
	if _, err := scopedAuthorization(ctx, principal); err == nil {
		t.Fatal("mismatched authorization accepted")
	}
}

func TestWebhookReceiptHeaderValidationAndRedelivery(t *testing.T) {
	auth := model.CredentialAuthorization{Principal: model.Principal{Kind: model.SessionCredential, UserID: userID, CredentialID: teamID}, Profile: model.SessionProfile}
	s := &testScopedService{}
	h := scopedFixture(t, s, auth)
	body := fmt.Sprintf(`{"operationId":"%s","issuedAt":"2026-11-07T08:00:00Z","expectedUserId":"%s","ifVersion":"1","ifGeneration":"1"}`, operationID, userID)
	path := "/api/v1/me/webhooks/" + endpointID + "/deliveries/" + teamID + "/redeliveries"
	for _, value := range []string{"unknown", "receipt-v1, receipt-v1", ""} {
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Daynight-Return", value)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || s.called != 0 {
			t.Fatalf("header=%q status=%d calls=%d body=%s", value, w.Code, s.called, w.Body.String())
		}
	}
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Daynight-Return", "receipt-v1")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusAccepted || !s.redelivery.ReturnReceipt || w.Header().Get("Daynight-Return") != "receipt-v1" || strings.Contains(w.Body.String(), "payload") {
		t.Fatalf("status=%d input=%+v body=%s", w.Code, s.redelivery, w.Body.String())
	}
	if err := RegisterScopedRoutes(nil, s, testScopedAuth{auth}, slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("missing mux accepted")
	}
}
