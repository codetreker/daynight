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
