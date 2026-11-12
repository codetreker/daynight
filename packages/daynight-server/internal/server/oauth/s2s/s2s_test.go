package s2s

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const testKey = "test-shared-key-012345678901234567890123456789"

type issuerFunc func(context.Context, model.User) (coreoauth.IssuedFamily, error)

func (f issuerFunc) Issue(ctx context.Context, u model.User) (coreoauth.IssuedFamily, error) {
	return f(ctx, u)
}
func request(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/s2s/token", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "S2S "+testKey)
	return r
}
func logger(out io.Writer) *slog.Logger { return slog.New(slog.NewJSONHandler(out, nil)) }
func issuedFamily() coreoauth.IssuedFamily {
	now := time.Date(2026, 11, 12, 12, 0, 0, 123456000, time.UTC)
	return coreoauth.IssuedFamily{Grant: store.OAuthGrant{ID: "a1111111-1111-4111-8111-111111111111", UserID: "b2222222-2222-4222-8222-222222222222", ClientID: coreoauth.APIClientID, Resource: "https://daynight.test/api/v1", Scope: coreoauth.APIScope, CreatedAt: now, ExpiresAt: now.Add(coreoauth.GrantLifetime)}, AccessID: "c3333333-3333-4333-8333-333333333333", AccessToken: "dnapi_" + strings.Repeat("a", 43), RefreshToken: "dnapr_" + strings.Repeat("b", 43), AccessExpiresAt: now.Add(time.Hour)}
}
func errorCode(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("response %d %q: %v", w.Code, w.Body.String(), err)
	}
	if w.Code != status || !reflect.DeepEqual(got, map[string]any{"error": code}) {
		t.Fatalf("response %d %s, want %d %s", w.Code, w.Body.String(), status, code)
	}
}

func TestIssuerKeyAdmissionPrecedesBodyAndUser(t *testing.T) {
	for _, tc := range []struct {
		name, key string
		headers   []string
	}{
		{"missing", testKey, nil}, {"wrong", testKey, []string{"S2S wrong"}}, {"duplicate", testKey, []string{"S2S " + testKey, "S2S " + testKey}}, {"disabled", "", []string{"S2S " + testKey}}, {"bearer", testKey, []string{"Bearer " + testKey}}, {"leading", testKey, []string{" S2S " + testKey}}, {"extra_space", testKey, []string{"S2S  " + testKey}}, {"trailing", testKey, []string{"S2S " + testKey + " "}}, {"comma", testKey, []string{"S2S " + testKey + ", S2S " + testKey}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := request("")
			r.Body = &unreadBody{t: t}
			r.Header.Del("Authorization")
			for _, v := range tc.headers {
				r.Header.Add("Authorization", v)
			}
			h := New(issuerFunc(func(context.Context, model.User) (coreoauth.IssuedFamily, error) {
				t.Fatal("issuer called")
				return coreoauth.IssuedFamily{}, nil
			}), tc.key, logger(io.Discard))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			errorCode(t, w, 401, "unauthenticated")
			if !r.Close {
				t.Fatal("unread body connection was reusable")
			}
			if w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("issuer exposed CORS")
			}
		})
	}
}

type unreadBody struct{ t *testing.T }

func (b *unreadBody) Read([]byte) (int, error) { b.t.Error("unauthorized body read"); return 0, io.EOF }
func (*unreadBody) Close() error               { return nil }

func TestIssuerInputRefusals(t *testing.T) {
	for _, tc := range []struct{ name, body, media, query string }{
		{"empty", "", "", ""}, {"null", "null", "", ""}, {"missing", `{}`, "", ""}, {"unknown", `{"externalUserId":"alice","client_id":"other"}`, "", ""}, {"duplicate", `{"externalUserId":"alice","externalUserId":"bob"}`, "", ""}, {"wrong_type", `{"externalUserId":false}`, "", ""}, {"empty_id", `{"externalUserId":""}`, "", ""}, {"nul", `{"externalUserId":"a\u0000b"}`, "", ""}, {"unicode", `{"externalUserId":"\ud800"}`, "", ""}, {"profile_null", `{"externalUserId":"alice","profile":null}`, "", ""}, {"profile_duplicate", `{"externalUserId":"alice","profile":{"name":"one","name":"two"}}`, "", ""}, {"profile_unknown", `{"externalUserId":"alice","profile":{"email":"secret"}}`, "", ""}, {"profile_type", `{"externalUserId":"alice","profile":{"name":17}}`, "", ""}, {"profile_unicode", `{"externalUserId":"alice","profile":{"avatarUrl":"\udfff"}}`, "", ""}, {"media", `{"externalUserId":"alice"}`, "text/plain", ""}, {"query", `{"externalUserId":"alice"}`, "", "resource=other"}, {"long_id", `{"externalUserId":"` + strings.Repeat("a", 1025) + `"}`, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := request(tc.body)
			if tc.media != "" {
				r.Header.Set("Content-Type", tc.media)
			}
			r.URL.RawQuery = tc.query
			var logs bytes.Buffer
			h := New(issuerFunc(func(context.Context, model.User) (coreoauth.IssuedFamily, error) {
				t.Fatal("invalid input called issuer")
				return coreoauth.IssuedFamily{}, nil
			}), testKey, logger(&logs))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			errorCode(t, w, 400, "invalid_input")
			if strings.Contains(logs.String(), "secret") || strings.Contains(logs.String(), testKey) {
				t.Fatalf("sensitive log: %s", logs.String())
			}
		})
	}
}

func TestIssuerReturnsActualGrantAndUserInput(t *testing.T) {
	want := issuedFamily()
	name := "Alice"
	avatar := "data:image/png;base64,private-profile"
	var captured context.Context
	var calls int
	h := New(issuerFunc(func(ctx context.Context, user model.User) (coreoauth.IssuedFamily, error) {
		calls++
		if user.UniAuthID != "msft:object@tenant" || user.Name == nil || *user.Name != name || user.AvatarURL == nil || *user.AvatarURL != avatar || user.Email != nil {
			t.Fatalf("user: %#v", user)
		}
		deadline, ok := ctx.Deadline()
		remaining := time.Until(deadline)
		if !ok || remaining < 14*time.Second || remaining > 15*time.Second {
			t.Fatalf("operation deadline: %v %v", ok, remaining)
		}
		captured = ctx
		return want, nil
	}), testKey, logger(io.Discard))
	r := request(`{"externalUserId":"microsoft:tenant:object","profile":{"name":"Alice","avatarUrl":"` + avatar + `"}}`)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if calls != 1 || captured.Err() != context.Canceled {
		t.Fatalf("calls/cancel: %d %v", calls, captured.Err())
	}
	var got api.OAuthAPITokens
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	expected := api.OAuthAPITokens{AccessToken: want.AccessToken, TokenType: "Bearer", ExpiresIn: 3600, AccessExpiresAt: want.AccessExpiresAt, RefreshToken: want.RefreshToken, GrantExpiresAt: want.Grant.ExpiresAt, Scope: want.Grant.Scope, Resource: want.Grant.Resource, ClientID: want.Grant.ClientID, GrantID: want.Grant.ID, UserID: want.Grant.UserID}
	if w.Code != 200 || !reflect.DeepEqual(got, expected) {
		t.Fatalf("response %d %#v", w.Code, got)
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(w.Body.Bytes(), &fields)
	if len(fields) != 11 {
		t.Fatalf("DTO fields: %v", fields)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Pragma") != "no-cache" || w.Header().Get("Location") != "" {
		t.Fatalf("headers: %v", w.Header())
	}
	if strings.Contains(w.Body.String(), "private-profile") || strings.Contains(w.Body.String(), testKey) || strings.Contains(w.Body.String(), "microsoft:") {
		t.Fatal("response leaked input")
	}
}

func TestIssuerCompletionErrorsNeverReleaseSecrets(t *testing.T) {
	invalid := &model.Fault{Code: "invalid_input", Message: "private-profile"}
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"invalid", invalid, 400, "invalid_input"}, {"unknown", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.Join(invalid, context.DeadlineExceeded)}, 503, "outcome_unknown"}, {"unknown_marker", errors.Join(coreoauth.ErrAuthorizationUnknown, invalid), 503, "outcome_unknown"}, {"cleanup", &store.TransactionError{Phase: "rollback", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: invalid}, 500, "server_error"}, {"database", &store.Error{Phase: "query", DatabaseFailure: true, Cause: invalid}, 500, "server_error"}, {"committed_error", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, Cause: invalid}, 500, "server_error"}, {"opaque", errors.New("private-profile"), 500, "server_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			calls := 0
			h := New(issuerFunc(func(context.Context, model.User) (coreoauth.IssuedFamily, error) {
				calls++
				return issuedFamily(), tc.err
			}), testKey, logger(&logs))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, request(`{"externalUserId":"private-external"}`))
			errorCode(t, w, tc.status, tc.code)
			if calls != 1 {
				t.Fatalf("calls=%d", calls)
			}
			for _, secret := range []string{issuedFamily().AccessToken, issuedFamily().RefreshToken, testKey, "private-profile", "private-external"} {
				if strings.Contains(w.Body.String(), secret) || strings.Contains(logs.String(), secret) {
					t.Fatalf("secret leaked: %s", secret)
				}
			}
		})
	}
}

func TestIssuerOperationInheritsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{})
	done := make(chan struct{})
	var calls atomic.Int32
	h := New(issuerFunc(func(ctx context.Context, _ model.User) (coreoauth.IssuedFamily, error) {
		calls.Add(1)
		close(started)
		<-ctx.Done()
		return coreoauth.IssuedFamily{}, ctx.Err()
	}), testKey, logger(io.Discard))
	r := request(`{"externalUserId":"alice"}`).WithContext(ctx)
	w := httptest.NewRecorder()
	go func() { defer close(done); h.ServeHTTP(w, r) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("operation not started")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("operation not canceled")
	}
	if calls.Load() != 1 || w.Body.Len() != 0 {
		t.Fatalf("calls=%d body=%s", calls.Load(), w.Body.String())
	}
}
func TestIssuerParentDeadlineRetained(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	expected, _ := ctx.Deadline()
	h := New(issuerFunc(func(ctx context.Context, _ model.User) (coreoauth.IssuedFamily, error) {
		got, _ := ctx.Deadline()
		if !got.Equal(expected) {
			t.Fatalf("deadline extended: %v", got)
		}
		return issuedFamily(), nil
	}), testKey, logger(io.Discard))
	h.ServeHTTP(httptest.NewRecorder(), request(`{"externalUserId":"alice"}`).WithContext(ctx))
}

func TestIssuerBodyLimitAndReadTimeout(t *testing.T) {
	for _, tc := range []struct {
		name   string
		body   io.ReadCloser
		status int
	}{{"limit", io.NopCloser(strings.NewReader(strings.Repeat(" ", 1<<20) + `{}`)), 413}, {"timeout", io.NopCloser(timeoutReader{}), 408}} {
		t.Run(tc.name, func(t *testing.T) {
			h := New(issuerFunc(func(context.Context, model.User) (coreoauth.IssuedFamily, error) {
				t.Fatal("issuer called")
				return coreoauth.IssuedFamily{}, nil
			}), testKey, logger(io.Discard))
			r := request("")
			r.Body = tc.body
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if !r.Close {
				t.Fatal("failed body remains reusable")
			}
		})
	}
}

type timeoutReader struct{}

func (timeoutReader) Read([]byte) (int, error) { return 0, bodyTimeout{} }

type bodyTimeout struct{}

func (bodyTimeout) Error() string   { return "timed out" }
func (bodyTimeout) Timeout() bool   { return true }
func (bodyTimeout) Temporary() bool { return true }

func TestIssuerMethodsAndLostResponse(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodOptions} {
		t.Run(method, func(t *testing.T) {
			h := New(issuerFunc(func(context.Context, model.User) (coreoauth.IssuedFamily, error) {
				t.Fatal("issuer called")
				return coreoauth.IssuedFamily{}, nil
			}), testKey, logger(io.Discard))
			r := request(`{}`)
			r.Method = method
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			errorCode(t, w, 405, "invalid_request")
			if w.Header().Get("Allow") != "POST" || w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal(w.Header())
			}
		})
	}
	var logs bytes.Buffer
	calls := 0
	h := New(issuerFunc(func(context.Context, model.User) (coreoauth.IssuedFamily, error) { calls++; return issuedFamily(), nil }), testKey, logger(&logs))
	w := &shortWriter{header: make(http.Header)}
	h.ServeHTTP(w, request(`{"externalUserId":"private-external"}`))
	if calls != 1 || w.writes != 1 || !strings.Contains(logs.String(), "outcome_unknown") {
		t.Fatalf("calls=%d writes=%d logs=%s", calls, w.writes, logs.String())
	}
	for _, s := range []string{testKey, "private-external", issuedFamily().AccessToken, issuedFamily().RefreshToken} {
		if strings.Contains(logs.String(), s) {
			t.Fatal("secret in logs")
		}
	}
}

type shortWriter struct {
	header http.Header
	writes int
}

func (w *shortWriter) Header() http.Header         { return w.header }
func (*shortWriter) WriteHeader(int)               {}
func (w *shortWriter) Write(p []byte) (int, error) { w.writes++; return len(p) - 1, nil }

func TestIssuerBodyReadDeadlineAndSecretSerializationFailure(t *testing.T) {
	t.Run("body_deadline", func(t *testing.T) {
		h := New(issuerFunc(func(context.Context, model.User) (coreoauth.IssuedFamily, error) { return issuedFamily(), nil }), testKey, logger(io.Discard))
		w := &deadlineWriter{ResponseRecorder: httptest.NewRecorder()}
		h.ServeHTTP(w, request(`{"externalUserId":"alice"}`))
		if w.Code != http.StatusOK || len(w.deadlines) != 2 || !w.deadlines[1].IsZero() {
			t.Fatalf("body read deadlines: %v, status %d", w.deadlines, w.Code)
		}
		if left := time.Until(w.deadlines[0]); left < 14*time.Second || left > 15*time.Second {
			t.Fatalf("body budget: %v", left)
		}
	})
	t.Run("serialization_after_commit", func(t *testing.T) {
		var logs bytes.Buffer
		calls := 0
		h := New(issuerFunc(func(context.Context, model.User) (coreoauth.IssuedFamily, error) {
			calls++
			result := issuedFamily()
			result.AccessExpiresAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
			return result, nil
		}), testKey, logger(&logs))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, request(`{"externalUserId":"alice"}`))
		errorCode(t, w, http.StatusServiceUnavailable, "outcome_unknown")
		if calls != 1 || !strings.Contains(logs.String(), "outcome_unknown") {
			t.Fatalf("calls %d, logs %s", calls, logs.String())
		}
		for _, secret := range []string{testKey, issuedFamily().AccessToken, issuedFamily().RefreshToken} {
			if strings.Contains(logs.String(), secret) || strings.Contains(w.Body.String(), secret) {
				t.Fatal("serialization failure leaked token material")
			}
		}
	})
}

type deadlineWriter struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (w *deadlineWriter) SetReadDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return nil
}
