package auth

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type timedOutDeviceBody struct{}

func (timedOutDeviceBody) Read([]byte) (int, error) { return 0, timedOutDeviceBody{} }
func (timedOutDeviceBody) Close() error             { return nil }
func (timedOutDeviceBody) Error() string            { return "private body detail" }
func (timedOutDeviceBody) Timeout() bool            { return true }
func (timedOutDeviceBody) Temporary() bool          { return true }

func TestDeviceBodyReadTimeoutUsesSafeResponse(t *testing.T) {
	h := &Authentication{RequestAuthentication: &RequestAuthentication{logger: slog.Default()}}
	for _, handler := range []http.HandlerFunc{h.deviceCode, h.deviceToken} {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/device", nil)
		r.Body, r.ContentLength = timedOutDeviceBody{}, 1
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		handler(w, r)
		if w.Code != http.StatusRequestTimeout || !r.Close || !strings.Contains(w.Body.String(), "request_timeout") || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("status=%d close=%v body=%s", w.Code, r.Close, w.Body)
		}
	}
}
