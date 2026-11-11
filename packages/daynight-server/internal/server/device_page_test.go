package server

import (
	"bytes"
	"strings"
	"testing"
)

func TestDevicePageRoutingAndCallbackProtection(t *testing.T) {
	var logs bytes.Buffer
	handler := uiTestHandler(t, &logs)
	for _, method := range []string{"GET", "HEAD"} {
		w := projectRequest(handler, method, "/device?user_code=BCDFG-HJKLM", "")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "text/html; charset=utf-8" {
			t.Fatalf("device page routing: %d", w.Code)
		}
	}
	if strings.Contains(logs.String(), "BCDFG-HJKLM") {
		t.Fatal("device code leaked through page request log")
	}
	if w := projectRequest(handler, "POST", "/device", ""); w.Code != 405 {
		t.Fatalf("device page accepted write: %d", w.Code)
	}
	if w := projectRequest(handler, "GET", "/device/extra", ""); w.Code != 404 {
		t.Fatalf("device page routing overlap: %d", w.Code)
	}
	for _, path := range []string{"/device", "/device/callback", "/api/v1/auth/device/code", "/api/v1/auth/device/token"} {
		config := configuredTestConfig()
		config.UniAuth.CallbackURL = config.Server.PublicOrigin + path
		if err := config.Validate(); err == nil {
			t.Fatalf("device route accepted as callback: %s", path)
		}
	}
}
