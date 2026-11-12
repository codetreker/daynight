package token

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type usageRotation struct {
	t       *testing.T
	failure error
	calls   int
	code    usage.Code
	cause   usage.Cause
}

func (s *usageRotation) Rotate(ctx context.Context, token, client, resource string, admit func(context.Context, string) error) (core.RotatedTokens, error) {
	s.calls++
	if token != "private-refresh" || client != "client" || resource != "https://server.test/mcp" {
		s.t.Fatalf("unexpected refresh arguments")
	}
	if err := admit(ctx, client); err != nil {
		s.t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	event := model.CredentialUsageEvent{Kind: model.UsageSubjectOAuthGrant, UserID: "00000000-0000-4000-8000-000000000001", SubjectID: "00000000-0000-4000-8000-000000000002", At: now}
	if err := usage.CollectorFrom(ctx).Record(usage.Fault{Phase: usage.PhaseRotation, Code: s.code, Cause: s.cause, Observation: usage.Observation{Event: event, RequestID: requestid.From(ctx), Source: usage.SourceOAuthRefresh}, OccurredAt: now}); err != nil {
		s.t.Fatal(err)
	}
	if s.failure != nil {
		return core.RotatedTokens{}, s.failure
	}
	return core.RotatedTokens{AccessToken: "new-access", RefreshToken: "new-refresh", ExpiresIn: 3600}, nil
}
func (*usageRotation) RevokePublic(context.Context, string, string) error { panic("unexpected revoke") }

type usageResponse struct {
	*httptest.ResponseRecorder
	beforeHeader func()
}

func (w *usageResponse) WriteHeader(status int) {
	w.beforeHeader()
	w.ResponseRecorder.WriteHeader(status)
}

func TestTokenRefreshPublishesUsageFaultBeforeResponse(t *testing.T) {
	for _, tc := range []struct {
		name    string
		failure error
		code    usage.Code
		cause   usage.Cause
		status  int
		body    string
	}{
		{"committed full", nil, usage.CodeQueueFull, usage.CauseCapacity, http.StatusOK, `"access_token":"new-access"`},
		{"unknown", core.ErrAuthorizationUnknown, usage.CodeRotationOutcomeUnknown, usage.CauseUnknown, http.StatusServiceUnavailable, `"error":"outcome_unknown"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			grants := &usageRotation{t: t, failure: tc.failure, code: tc.code, cause: tc.cause}
			rates := &tokenRate{counts: map[string]int{}}
			h := PublicTokens{Admission: core.PublicAdmission{Writer: tokenWriter{rates}}, Resource: "https://server.test/mcp", Grants: grants, Logger: logger}
			form := url.Values{"grant_type": {"refresh_token"}, "client_id": {"client"}, "resource": {"https://server.test/mcp"}, "refresh_token": {"private-refresh"}}
			r := httptest.NewRequest(http.MethodPost, "https://server.test/oauth/token", strings.NewReader(form.Encode()))
			r.RemoteAddr = "192.0.2.1:123"
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			r.Header.Set("X-Request-ID", "refresh-request")
			seen := 0
			w := &usageResponse{ResponseRecorder: httptest.NewRecorder(), beforeHeader: func() {
				seen++
				if grants.calls != 1 || !strings.Contains(logs.String(), `"error_code":"`+tc.code.String()+`"`) || !strings.Contains(logs.String(), `"origin_request_id":"refresh-request"`) {
					t.Fatalf("fault unavailable at response: calls=%d logs=%s", grants.calls, &logs)
				}
			}}
			httpx.RequestLogging(logger, http.HandlerFunc(h.Token)).ServeHTTP(w, r)
			if seen != 1 || grants.calls != 1 || w.Code != tc.status || !strings.Contains(w.Body.String(), tc.body) || strings.Count(logs.String(), `"error_code":"`+tc.code.String()+`"`) != 1 || strings.Contains(logs.String(), "private-refresh") || strings.Contains(w.Body.String(), "private-refresh") {
				t.Fatalf("headers=%d calls=%d status=%d body=%s logs=%s", seen, grants.calls, w.Code, w.Body.String(), &logs)
			}
		})
	}
}

func TestAPIRefreshPublishesUsageFaultOnceBeforeTokenDelivery(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "committed", true: "unknown"}[unknown], func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			refresh := secret.Random(core.APIRefreshPrefix)
			calls := 0
			grants := apiGrantOperations{rotate: func(ctx context.Context, token, client, resource string, admit func(context.Context, string) error) (core.RotatedTokens, error) {
				calls++
				if token != refresh || client != core.APIClientID || resource != "https://server.test/api/v1" {
					t.Fatal("API refresh usage tuple differs")
				}
				if err := admit(ctx, client); err != nil {
					t.Fatal(err)
				}
				now := time.Now().UTC().Truncate(time.Microsecond)
				code, cause := usage.CodeQueueFull, usage.CauseCapacity
				if unknown {
					code, cause = usage.CodeRotationOutcomeUnknown, usage.CauseUnknown
				}
				event := model.CredentialUsageEvent{Kind: model.UsageSubjectOAuthGrant, UserID: "00000000-0000-4000-8000-000000000001", SubjectID: "00000000-0000-4000-8000-000000000002", At: now}
				if err := usage.CollectorFrom(ctx).Record(usage.Fault{Phase: usage.PhaseRotation, Code: code, Cause: cause, Observation: usage.Observation{Event: event, RequestID: requestid.From(ctx), Source: usage.SourceOAuthRefresh}, OccurredAt: now}); err != nil {
					t.Fatal(err)
				}
				if unknown {
					return core.RotatedTokens{}, core.ErrAuthorizationUnknown
				}
				grant := store.OAuthGrant{ID: event.SubjectID, UserID: event.UserID, ClientID: client, Resource: resource, Scope: core.APIScope, ExpiresAt: now.Add(core.GrantLifetime)}
				return core.RotatedTokens{AccessToken: "provided-api-access", RefreshToken: "provided-api-refresh", ExpiresIn: 3600, Grant: &grant, AccessExpiresAt: now.Add(core.AccessLifetime)}, nil
			}}
			h := apiTokenAdapter(grants)
			h.Logger = logger
			r := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(apiRefreshForm(refresh).Encode()))
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			r.Header.Set("X-Request-ID", "api-refresh-usage")
			seen := 0
			w := &usageResponse{ResponseRecorder: httptest.NewRecorder(), beforeHeader: func() {
				seen++
				if calls != 1 || !strings.Contains(logs.String(), `"origin_request_id":"api-refresh-usage"`) {
					t.Fatal("API usage fault was not published before response")
				}
			}}
			httpx.RequestLogging(logger, http.HandlerFunc(h.Token)).ServeHTTP(w, r)
			code, status := usage.CodeQueueFull, http.StatusOK
			if unknown {
				code, status = usage.CodeRotationOutcomeUnknown, http.StatusServiceUnavailable
			}
			if w.Code != status || seen != 1 || calls != 1 || strings.Count(logs.String(), `"error_code":"`+code.String()+`"`) != 1 || strings.Contains(logs.String(), refresh) || strings.Contains(logs.String(), "provided-api-access") || strings.Contains(logs.String(), "provided-api-refresh") || unknown && strings.Contains(w.Body.String(), "access_token") {
				t.Fatalf("API usage calls=%d headers=%d status=%d body=%s logs=%s", calls, seen, w.Code, w.Body.String(), logs.String())
			}
		})
	}
}
