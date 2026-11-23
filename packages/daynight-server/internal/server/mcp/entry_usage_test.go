package mcp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

const usageUserID = "00000000-0000-4000-8000-000000000001"
const usagePATID = "00000000-0000-4000-8000-000000000002"
const usageGrantID = "00000000-0000-4000-8000-000000000003"

type usagePATAuthenticator struct{}

func (usagePATAuthenticator) Authenticate(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	if kind != model.PATCredential || token != "pat-secret" {
		return model.Principal{}, model.Unauthenticated(nil)
	}
	return model.Principal{Kind: kind, UserID: usageUserID, CredentialID: usagePATID}, nil
}

type usageOAuthAuthenticator struct{}

func (usageOAuthAuthenticator) AuthenticateAccess(_ context.Context, token, resource string) (store.OAuthAccessIdentity, error) {
	if token != model.OAuthAccessPrefix+"valid" || resource != "https://daynight.test/mcp" {
		return store.OAuthAccessIdentity{}, model.Unauthenticated(nil)
	}
	return store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: usageUserID, CredentialID: "access-id"}, GrantID: usageGrantID}, nil
}

type usageBody struct{ read func() }

func (b usageBody) Read([]byte) (int, error) { b.read(); return 0, io.EOF }
func (usageBody) Close() error               { return nil }

func TestMCPUsageBeforeBodyAndPreservesProtocolResult(t *testing.T) {
	for _, tc := range []struct {
		name, token string
		source      usage.Source
		kind        model.UsageSubjectKind
		subject     string
		code        usage.Code
		cause       usage.Cause
	}{
		{"pat full", "pat-secret", usage.SourceMCPPAT, model.UsageSubjectPAT, usagePATID, usage.CodeQueueFull, usage.CauseCapacity},
		{"oauth stopped", model.OAuthAccessPrefix + "valid", usage.SourceMCPOAuth, model.UsageSubjectOAuthGrant, usageGrantID, usage.CodeShutdownIncomplete, usage.CauseStopped},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			calls := 0
			before := time.Now().UTC()
			e, err := New(usagePATAuthenticator{}, "https://daynight.test", nil, logger, usageOAuthAuthenticator{}, func(ctx context.Context, source usage.Source, event model.CredentialUsageEvent) error {
				calls++
				if source != tc.source || event.Kind != tc.kind || event.UserID != usageUserID || event.SubjectID != tc.subject || event.At.Before(before.Truncate(time.Microsecond)) || event.At.After(time.Now().UTC()) || event.At.Location() != time.UTC || event.At.Nanosecond()%1000 != 0 {
					t.Fatalf("event=%+v source=%v", event, source)
				}
				return usage.CollectorFrom(ctx).Record(usage.Fault{Phase: usage.PhaseSubmit, Code: tc.code, Cause: tc.cause, Observation: usage.Observation{Event: event, RequestID: requestid.From(ctx), Source: source}, OccurredAt: event.At})
			})
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				if err := e.Shutdown(ctx); err != nil {
					t.Error(err)
				}
			}()
			checked := false
			r := httptest.NewRequest(http.MethodPost, "/mcp", nil)
			r.Header.Set("Authorization", "Bearer "+tc.token)
			r.Header.Set("X-Request-ID", "mcp-usage")
			r.Body = usageBody{read: func() {
				checked = true
				if calls != 1 || !strings.Contains(logs.String(), `"error_code":"`+tc.code.String()+`"`) || !strings.Contains(logs.String(), `"subject_id":"`+tc.subject+`"`) {
					t.Fatalf("fault not published before body: calls=%d logs=%s", calls, &logs)
				}
			}}
			w := httptest.NewRecorder()
			httpx.RequestLogging(logger, e).ServeHTTP(w, r)
			if !checked || calls != 1 || w.Code < 400 || strings.Count(logs.String(), `"error_code":"`+tc.code.String()+`"`) != 1 || strings.Contains(logs.String(), tc.token) {
				t.Fatalf("read=%v calls=%d status=%d logs=%s", checked, calls, w.Code, &logs)
			}
		})
	}
}

func TestMCPUsageAuthenticationRejectionDoesNotRecord(t *testing.T) {
	for _, token := range []string{"bad", model.OAuthAccessPrefix + "invalid"} {
		t.Run(token, func(t *testing.T) {
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			calls := 0
			e, err := New(usagePATAuthenticator{}, "https://daynight.test", nil, logger, usageOAuthAuthenticator{}, func(context.Context, usage.Source, model.CredentialUsageEvent) error {
				calls++
				return errors.New("unexpected")
			})
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				if err := e.Shutdown(ctx); err != nil {
					t.Error(err)
				}
			}()
			r := httptest.NewRequest(http.MethodPost, "/mcp", nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			httpx.RequestLogging(logger, e).ServeHTTP(w, r)
			if calls != 0 || w.Code != http.StatusUnauthorized {
				t.Fatalf("calls=%d status=%d", calls, w.Code)
			}
		})
	}
}
