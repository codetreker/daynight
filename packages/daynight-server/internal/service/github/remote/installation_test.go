package remote

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestInstallationAppRequestAndStatus(t *testing.T) {
	var response atomic.Int32
	var requests, checkpoints atomic.Int32
	c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if checkpoints.Load() != requests.Load() {
			t.Error("request preceded its checkpoint")
		}
		if r.Method != http.MethodGet || r.URL.Path != "/app/installations/12" || len(strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")) != 3 || r.Header.Get("X-GitHub-Api-Version") != apiVersion {
			t.Errorf("unexpected App request: %s %s", r.Method, r.URL)
		}
		switch response.Load() {
		case 0:
			fmt.Fprint(w, `{"id":12,"suspended_at":null}`)
		case 1:
			fmt.Fprint(w, `{"id":12,"suspended_at":"2026-01-02T03:04:05Z"}`)
		case 2:
			w.Header().Set("X-GitHub-Request-Id", "request-id")
			w.WriteHeader(http.StatusNotFound)
		case 3:
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, `{"message":"access denied"}`)
		case 4:
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
		case 5:
			fmt.Fprint(w, `{"id":12}`)
		case 6:
			fmt.Fprint(w, `{"id":13,"suspended_at":null}`)
		case 7:
			fmt.Fprint(w, `{"id":12,"suspended_at":"invalid"}`)
		}
	})
	ctx := WithRequestCheckpoint(context.Background(), func(context.Context) error { checkpoints.Add(1); return nil })
	for _, tc := range []struct {
		mode      int32
		suspended bool
		code      string
		invalid   bool
	}{
		{0, false, "", false}, {1, true, "", false},
		{2, false, "installation_missing", false}, {3, false, "permission_denied", false}, {4, false, "rate_limited", false},
		{5, false, "", true}, {6, false, "", true}, {7, false, "", true},
	} {
		response.Store(tc.mode)
		got, err := c.Installation(ctx, 12)
		if tc.code != "" {
			var remoteErr *Error
			if !errors.As(err, &remoteErr) || remoteErr.Code != tc.code {
				t.Fatalf("mode %d: error %v", tc.mode, err)
			}
			if tc.mode == 2 && remoteErr.RequestID != "request-id" {
				t.Fatalf("missing request ID: %+v", remoteErr)
			}
			if tc.mode == 4 && remoteErr.RetryAt.IsZero() {
				t.Fatal("rate limit without retry time")
			}
		} else if tc.invalid {
			if !errors.Is(err, errInvalidObservation) {
				t.Fatalf("mode %d: error %v", tc.mode, err)
			}
		} else if err != nil || got.ID != 12 || got.Suspended != tc.suspended {
			t.Fatalf("mode %d: status %+v error %v", tc.mode, got, err)
		}
	}
	refused := errors.New("claim lost")
	ctx = WithRequestCheckpoint(context.Background(), func(context.Context) error { return refused })
	_, err := c.Installation(ctx, 12)
	if !errors.Is(err, refused) || requests.Load() != 8 {
		t.Fatalf("refusal: error %v requests %d", err, requests.Load())
	}
	_, err = c.Installation(context.Background(), 0)
	if err == nil || requests.Load() != 8 {
		t.Fatalf("invalid ID: error %v requests %d", err, requests.Load())
	}
}
