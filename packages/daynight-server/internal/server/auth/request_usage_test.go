package auth

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

func TestPATUsageDirectAuthenticationPublishesBeforeReturn(t *testing.T) {
	const user = "00000000-0000-4000-8000-000000000001"
	const credential = "00000000-0000-4000-8000-000000000002"
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	calls := 0
	before := time.Now().UTC()
	h, err := NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		if kind != model.PATCredential || secret != "secret" {
			t.Fatalf("unexpected authentication input")
		}
		return model.Principal{Kind: kind, UserID: user, CredentialID: credential}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://example.com"}, logger, func(ctx context.Context, source usage.Source, event model.CredentialUsageEvent) error {
		calls++
		if source != usage.SourceHTTPPAT || event.Kind != model.UsageSubjectPAT || event.UserID != user || event.SubjectID != credential || event.At.Before(before.Truncate(time.Microsecond)) || event.At.After(time.Now().UTC()) || event.At.Location() != time.UTC || event.At.Nanosecond()%1000 != 0 {
			t.Fatalf("invalid event %+v source %v", event, source)
		}
		return usage.CollectorFrom(ctx).Record(usage.Fault{Phase: usage.PhaseSubmit, Code: usage.CodeQueueFull, Cause: usage.CauseCapacity, Observation: usage.Observation{Event: event, RequestID: requestid.From(ctx), Source: source}, OccurredAt: event.At})
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := requestid.With(usage.WithCollector(context.Background(), &usage.Collector{}), "direct-request")
	req := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer secret")
	p, err := h.AuthenticateRequest(req)
	if err != nil || p.CredentialID != credential || calls != 1 {
		t.Fatalf("principal=%+v calls=%d err=%v", p, calls, err)
	}
	if !strings.Contains(logs.String(), `"error_code":"queue_full"`) || !strings.Contains(logs.String(), `"subject_id":"`+credential+`"`) || !strings.Contains(logs.String(), `"origin_request_id":"direct-request"`) || strings.Contains(logs.String(), "secret") {
		t.Fatalf("logs=%s", &logs)
	}
	if _, pending := usage.CollectorFrom(ctx).Snapshot(); pending {
		t.Fatal("published fault not acknowledged")
	}
}

func TestPATUsageAuthenticationBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name          string
		session, fail bool
		want          int
	}{{"pat", false, false, 1}, {"session", true, false, 0}, {"refused", false, true, 0}} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			sentinel := errors.New("authentication refused")
			logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
			h, err := NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, _ string) (model.Principal, error) {
				if tc.fail {
					return model.Principal{}, sentinel
				}
				return model.Principal{Kind: kind, UserID: "user", CredentialID: "credential"}, nil
			}, authconfig.AuthSettings{PublicOrigin: "https://example.com"}, logger, func(context.Context, usage.Source, model.CredentialUsageEvent) error {
				calls++
				return errors.New("recording failure")
			})
			if err != nil {
				t.Fatal(err)
			}
			handler := httpx.RequestLogging(logger, h.Require(func(w http.ResponseWriter, _ *http.Request, _ model.Principal) { w.WriteHeader(http.StatusForbidden) }))
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.session {
				req.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "secret"})
			} else {
				req.Header.Set("Authorization", "Bearer secret")
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			expected := http.StatusForbidden
			if tc.fail {
				expected = http.StatusInternalServerError
			}
			if calls != tc.want || w.Code != expected {
				t.Fatalf("calls=%d status=%d", calls, w.Code)
			}
		})
	}
}

func TestAPIAccessUsagePublishesBeforeAuthenticationReturns(t *testing.T) {
	for _, channel := range []bool{false, true} {
		t.Run(map[bool]string{false: "REST", true: "channel"}[channel], func(t *testing.T) {
			identity := applicationIdentity()
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			calls := 0
			before := time.Now().UTC().Truncate(time.Microsecond)
			h, err := NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
				t.Fatal("API access used native verifier")
				return model.Principal{}, nil
			}, authconfig.AuthSettings{PublicOrigin: "https://example.com"}, logger, func(ctx context.Context, source usage.Source, event model.CredentialUsageEvent) error {
				calls++
				if source != usage.SourceHTTPOAuth || event.Kind != model.UsageSubjectOAuthGrant || event.UserID != identity.Principal.UserID || event.SubjectID != identity.GrantID || event.At.Before(before) || event.At.After(time.Now().UTC()) || event.At.Location() != time.UTC || event.At.Nanosecond()%1000 != 0 {
					t.Fatalf("invalid API usage event=%+v source=%v", event, source)
				}
				return usage.CollectorFrom(ctx).Record(usage.Fault{Phase: usage.PhaseSubmit, Code: usage.CodeQueueFull, Cause: usage.CauseCapacity, Observation: usage.Observation{Event: event, RequestID: requestid.From(ctx), Source: source}, OccurredAt: event.At})
			})
			if err != nil {
				t.Fatal(err)
			}
			h.BindAPIAccess(func(context.Context, string) (store.OAuthAccessIdentity, error) { return identity, nil }, "https://application.example")
			ctx := requestid.With(usage.WithCollector(t.Context(), &usage.Collector{}), "api-request")
			request := httptest.NewRequest(http.MethodGet, "/protected", nil).WithContext(ctx)
			request.Header.Set("Origin", "https://application.example")
			if channel {
				got, err := h.AuthenticateAPIAccess(request, "dnapi_private-secret")
				if err != nil || got != identity {
					t.Fatalf("channel identity=%+v err=%v", got, err)
				}
			} else {
				request.Header.Set("Authorization", "Bearer dnapi_private-secret")
				got, err := h.AuthenticateRequest(request)
				if err != nil || got != identity.Principal {
					t.Fatalf("REST principal=%+v err=%v", got, err)
				}
			}
			if calls != 1 || !strings.Contains(logs.String(), `"source":"http_oauth"`) || !strings.Contains(logs.String(), `"subject_id":"`+identity.GrantID+`"`) || strings.Contains(logs.String(), "private-secret") {
				t.Fatalf("calls=%d logs=%s", calls, logs.String())
			}
			if _, pending := usage.CollectorFrom(ctx).Snapshot(); pending {
				t.Fatal("API usage fault not published before authentication returned")
			}
		})
	}
}

func TestAPIUsageOnlyRecordsSuccessfulAuthentication(t *testing.T) {
	for _, test := range []struct {
		name        string
		channel     bool
		origin      string
		failure     bool
		wantCalls   int
		wantSuccess bool
	}{
		{name: "REST business refusal", wantCalls: 1, wantSuccess: true},
		{name: "REST invalid credential", failure: true},
		{name: "channel missing Origin", channel: true},
		{name: "channel invalid credential", channel: true, origin: "https://application.example", failure: true},
		{name: "channel valid", channel: true, origin: "https://application.example", wantCalls: 1, wantSuccess: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			h, err := NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
				t.Fatal("API authentication reached native credentials")
				return model.Principal{}, nil
			}, authconfig.AuthSettings{PublicOrigin: "https://example.com"}, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)), func(context.Context, usage.Source, model.CredentialUsageEvent) error {
				calls++
				return errors.New("metadata recording unavailable")
			})
			if err != nil {
				t.Fatal(err)
			}
			h.BindAPIAccess(func(context.Context, string) (store.OAuthAccessIdentity, error) {
				if test.failure {
					return store.OAuthAccessIdentity{}, Failure()
				}
				return applicationIdentity(), nil
			}, "https://application.example")
			request := httptest.NewRequest(http.MethodGet, "/protected", nil)
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if test.channel {
				_, err := h.AuthenticateAPIAccess(request, "dnapi_secret")
				if (err == nil) != test.wantSuccess {
					t.Fatalf("authentication err=%v", err)
				}
			} else {
				request.Header.Set("Authorization", "Bearer dnapi_secret")
				response := httptest.NewRecorder()
				h.Require(func(w http.ResponseWriter, _ *http.Request, _ model.Principal) { w.WriteHeader(http.StatusForbidden) })(response, request)
				wantStatus := http.StatusUnauthorized
				if test.wantSuccess {
					wantStatus = http.StatusForbidden
				}
				if response.Code != wantStatus {
					t.Fatalf("response=%d want=%d", response.Code, wantStatus)
				}
			}
			if calls != test.wantCalls {
				t.Fatalf("usage calls=%d want=%d", calls, test.wantCalls)
			}
		})
	}
}
