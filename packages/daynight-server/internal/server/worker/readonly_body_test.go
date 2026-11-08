package worker

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type timeoutBody struct{}

func (timeoutBody) Read([]byte) (int, error) { return 0, timeoutBody{} }
func (timeoutBody) Close() error             { return nil }
func (timeoutBody) Error() string            { return "private body detail" }
func (timeoutBody) Timeout() bool            { return true }
func (timeoutBody) Temporary() bool          { return true }

func TestReadOnlyBodyReadFailures(t *testing.T) {
	h := NewReadOnlyRoutes(nil, nil, slog.Default())
	p := model.Principal{UserID: "user"}
	for _, tc := range []struct {
		name        string
		makeRequest func() *http.Request
		status      int
		code        string
	}{
		{"too large", func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/", strings.NewReader(strings.Repeat("x", (64<<10)+1)))
		}, http.StatusRequestEntityTooLarge, "payload_too_large"},
		{"timeout", func() *http.Request {
			r := httptest.NewRequest(http.MethodPost, "/", nil)
			r.Body, r.ContentLength = timeoutBody{}, 1
			return r
		}, http.StatusRequestTimeout, "request_timeout"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := tc.makeRequest()
			r.SetPathValue("workerId", "f47ac10b-58cc-11cf-a447-001122334455")
			w := httptest.NewRecorder()
			h.request(w, r, p)
			if w.Code != tc.status || !r.Close || !strings.Contains(w.Body.String(), tc.code) || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("status=%d close=%v body=%s", w.Code, r.Close, w.Body)
			}
		})
	}
}
