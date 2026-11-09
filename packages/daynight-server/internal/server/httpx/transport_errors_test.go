package httpx

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

type failingDeadlineWriter struct {
	*httptest.ResponseRecorder
	initialErr error
	clearErr   error
}

func (w *failingDeadlineWriter) SetReadDeadline(deadline time.Time) error {
	if deadline.IsZero() {
		return w.clearErr
	}
	return w.initialErr
}

type countingBody struct{ reads int }

func (b *countingBody) Read([]byte) (int, error) { b.reads++; return 0, io.EOF }
func (*countingBody) Close() error               { return nil }

func TestDeadlineBodyControlFailures(t *testing.T) {
	for _, tc := range []struct {
		name    string
		initial bool
	}{
		{"initial deadline", true},
		{"deadline clear", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cause := errors.New("private socket detail")
			w := &failingDeadlineWriter{ResponseRecorder: httptest.NewRecorder()}
			if tc.initial {
				w.initialErr = cause
			} else {
				w.clearErr = cause
			}
			source := &countingBody{}
			r := httptest.NewRequest(http.MethodPost, "/", nil)
			r.Body = source
			_, err := io.ReadAll(NewDeadlineBody(w, r, time.Second))
			var failure *BodyReadError
			if !errors.As(err, &failure) || !errors.Is(err, cause) || failure.Status != http.StatusBadRequest || strings.Contains(err.Error(), cause.Error()) {
				t.Fatalf("unsafe or unclassified deadline failure: %v", err)
			}
			if !r.Close || w.Header().Get("Connection") != "close" {
				t.Fatal("failed deadline left request reusable")
			}
			if tc.initial && source.reads != 0 || !tc.initial && source.reads != 1 {
				t.Fatalf("source reads = %d", source.reads)
			}
		})
	}
}

func TestDeadlineBodyEmptyAndCanceled(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.Body = nil
	w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	body := NewDeadlineBody(w, r, time.Second)
	if data, err := io.ReadAll(body); err != nil || len(data) != 0 || r.Body != http.NoBody || len(w.reads) != 2 || !w.reads[1].IsZero() {
		t.Fatalf("empty body: %q, %v, deadlines %v", data, err, w.reads)
	}
	if _, err := body.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("completed body returned %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r = httptest.NewRequest(http.MethodPost, "/", strings.NewReader("x")).WithContext(ctx)
	_, err := io.ReadAll(NewDeadlineBody(httptest.NewRecorder(), r, time.Minute))
	var failure *BodyReadError
	if !errors.As(err, &failure) || !errors.Is(err, context.Canceled) || failure.Status != http.StatusBadRequest || !r.Close {
		t.Fatalf("canceled read: %v, close=%v", err, r.Close)
	}
}

func TestRequestTargetLimitsBeforeRouting(t *testing.T) {
	for _, tc := range []struct {
		name, target string
		status       int
	}{
		{"target exact", "/" + strings.Repeat("a", transport.MaxRequestTargetBytes-1), http.StatusNoContent},
		{"target oversized", "/" + strings.Repeat("a", transport.MaxRequestTargetBytes), http.StatusRequestURITooLong},
		{"query exact", "/?" + strings.Repeat("a", transport.MaxRawQueryBytes), http.StatusNoContent},
		{"query oversized", "/?" + strings.Repeat("a", transport.MaxRawQueryBytes+1), http.StatusRequestURITooLong},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, tc.target, strings.NewReader("secret-body"))
			body := &countingBody{}
			r.Body = body
			w := httptest.NewRecorder()
			hits := 0
			LimitRequestTarget(quietLogger(), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				hits++
				w.WriteHeader(http.StatusNoContent)
			})).ServeHTTP(w, r)
			if w.Code != tc.status || body.reads != 0 || hits != map[bool]int{true: 1, false: 0}[tc.status == http.StatusNoContent] {
				t.Fatalf("status=%d hits=%d body reads=%d", w.Code, hits, body.reads)
			}
			if tc.status == http.StatusRequestURITooLong && (!r.Close || w.Header().Get("Connection") != "close" || strings.Contains(w.Body.String(), tc.target)) {
				t.Fatalf("oversized request not safely rejected: close=%v headers=%v", r.Close, w.Header())
			}
		})
	}
	if msg := (&URITooLongError{}).Error(); msg == "" {
		t.Fatal("empty URI limit diagnostic")
	}
}
