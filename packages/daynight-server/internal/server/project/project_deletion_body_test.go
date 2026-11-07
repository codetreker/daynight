package project

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type timeoutDeletionBody struct{}

func (timeoutDeletionBody) Read([]byte) (int, error) { return 0, timeoutDeletionBody{} }
func (timeoutDeletionBody) Close() error             { return nil }
func (timeoutDeletionBody) Error() string            { return "private body detail" }
func (timeoutDeletionBody) Timeout() bool            { return true }
func (timeoutDeletionBody) Temporary() bool          { return true }

func TestProjectDeleteRejectsBodyAndTimeoutBeforeDeletion(t *testing.T) {
	h := &projectHandler{logger: slog.Default()}
	for _, tc := range []struct {
		name        string
		makeRequest func() *http.Request
		status      int
		code        string
	}{
		{"nonempty", func() *http.Request { return httptest.NewRequest(http.MethodDelete, "/", strings.NewReader("x")) }, http.StatusBadRequest, "invalid_input"},
		{"oversized", func() *http.Request {
			return httptest.NewRequest(http.MethodDelete, "/", strings.NewReader(strings.Repeat("x", 1<<20)))
		}, http.StatusBadRequest, "invalid_input"},
		{"timeout", func() *http.Request {
			r := httptest.NewRequest(http.MethodDelete, "/", nil)
			r.Body, r.ContentLength = timeoutDeletionBody{}, 1
			return r
		}, http.StatusRequestTimeout, "request_timeout"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := tc.makeRequest()
			w := httptest.NewRecorder()
			h.delete(w, r, model.Principal{UserID: "user"})
			if w.Code != tc.status || !r.Close || !strings.Contains(w.Body.String(), tc.code) || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("status=%d close=%v body=%s", w.Code, r.Close, w.Body)
			}
		})
	}
}
