package remote

import (
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestClientConstructionAndRepositoryPaths(t *testing.T) {
	key := &rsa.PrivateKey{}
	client, err := NewClient(123, key)
	if err != nil || client.base.String() != apiOrigin {
		t.Fatalf("default API origin: %v", err)
	}
	for _, tc := range []struct {
		id  int64
		key *rsa.PrivateKey
	}{{0, key}, {-1, key}, {1, nil}} {
		if _, err := NewClient(tc.id, tc.key); err == nil {
			t.Errorf("invalid app credentials accepted: %d", tc.id)
		}
	}
	if p, err := repoPath("owner", "repo.name"); err != nil || p != "/repos/owner/repo.name" {
		t.Fatalf("valid repository path: %q %v", p, err)
	}
	for _, tc := range [][2]string{{"", "repo"}, {"owner", ""}, {".", "repo"}, {"..", "repo"}, {"owner", "."}, {"owner", ".."}, {"a/b", "repo"}, {"a\\b", "repo"}, {"owner", "a/b"}, {"owner", "a\\b"}} {
		if _, err := repoPath(tc[0], tc[1]); err == nil {
			t.Errorf("invalid repository path accepted: %q", tc)
		}
	}
}

func TestHTTPErrorClassificationAndRetryHeaders(t *testing.T) {
	reset := time.Now().Add(4 * time.Minute).Truncate(time.Second)
	date := time.Now().Add(2 * time.Minute).UTC().Truncate(time.Second)
	for _, tc := range []struct {
		name       string
		status     int
		header     http.Header
		body, code string
		retry      time.Time
	}{
		{"unauthorized", 401, nil, "private upstream body", "unauthorized", time.Time{}},
		{"missing", 404, nil, "private upstream body", "not_found", time.Time{}},
		{"upstream unavailable", 500, nil, "private upstream body", "unavailable", time.Time{}},
		{"permission denied", 403, nil, `{"message":"access denied"}`, "permission_denied", time.Time{}},
		{"malformed permission response", 403, nil, "private upstream body", "unavailable", time.Time{}},
		{"abuse detection", 403, nil, `{"message":"abuse detection mechanism"}`, "rate_limited", time.Time{}},
		{"429 without headers", 429, nil, "private upstream body", "rate_limited", time.Time{}},
		{"retry date", 403, http.Header{"Retry-After": []string{date.Format(http.TimeFormat)}}, "private upstream body", "rate_limited", date},
		{"remaining with later reset", 403, http.Header{"Retry-After": []string{"1"}, "X-Ratelimit-Remaining": []string{"0"}, "X-Ratelimit-Reset": []string{strconv.FormatInt(reset.Unix(), 10)}}, "private upstream body", "rate_limited", reset},
		{"invalid reset", 403, http.Header{"X-Ratelimit-Remaining": []string{"0"}, "X-Ratelimit-Reset": []string{"bad"}}, "private upstream body", "rate_limited", time.Time{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				for k, values := range tc.header {
					for _, v := range values {
						w.Header().Add(k, v)
					}
				}
				w.Header().Set("X-GitHub-Request-Id", "request-id")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer srv.Close()
			resp, err := srv.Client().Get(srv.URL)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			before := time.Now()
			err = responseError(resp)
			var classified *Error
			if !errors.As(err, &classified) || classified.Code != tc.code || classified.Status != tc.status || classified.RequestID != "request-id" || strings.Contains(err.Error(), "private") {
				t.Fatalf("classification: %#v %v", classified, err)
			}
			if !tc.retry.IsZero() && !classified.RetryAt.Equal(tc.retry) {
				t.Fatalf("retry at %v, want %v", classified.RetryAt, tc.retry)
			}
			if tc.code == "rate_limited" && tc.retry.IsZero() && classified.RetryAt.Before(before.Add(59*time.Second)) {
				t.Fatalf("missing fallback retry: %v", classified.RetryAt)
			}
		})
	}
}

func TestHTTPTokenExchangeRejectsInvalidResponses(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		code   string
	}{
		{"permission", 403, `{"message":"denied"}`, "permission_denied"},
		{"malformed", 201, `{"token":"secret`, ""},
		{"empty token", 201, fmt.Sprintf(`{"token":"","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339)), ""},
		{"expired", 201, `{"token":"secret-token","expires_at":"2020-01-01T00:00:00Z"}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/app/installations/12/access_tokens" || r.Header.Get("Authorization") != "Bearer jwt-secret" {
					t.Error("incorrect exchange request")
				}
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			})
			token, expires, err := c.exchange(context.Background(), 12, "jwt-secret")
			if err == nil || token != "" || !expires.IsZero() || strings.Contains(err.Error(), "secret") {
				t.Fatalf("exchange: %q %v %v", token, expires, err)
			}
			if tc.code != "" {
				var e *Error
				if !errors.As(err, &e) || e.Code != tc.code {
					t.Fatalf("classification: %v", err)
				}
			}
		})
	}
	t.Run("cancelled request", func(t *testing.T) {
		c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) { t.Error("cancelled request reached server") })
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, _, err := c.exchange(ctx, 12, "jwt-secret"); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation: %v", err)
		}
	})
}

func TestHTTPReadJSONFailure(t *testing.T) {
	for _, tc := range []struct {
		status     int
		body, code string
	}{
		{200, `{"private-secret":`, ""},
		{404, `private-secret`, "not_found"},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); fmt.Fprint(w, tc.body) }))
		resp, err := srv.Client().Get(srv.URL)
		if err != nil {
			srv.Close()
			t.Fatal(err)
		}
		var data any
		err = readJSON(resp, &data)
		srv.Close()
		if err == nil || strings.Contains(err.Error(), "private-secret") {
			t.Fatalf("read JSON: %v", err)
		}
		if tc.code != "" {
			var e *Error
			if !errors.As(err, &e) || e.Code != tc.code {
				t.Fatalf("classification: %v", err)
			}
		}
	}
}
