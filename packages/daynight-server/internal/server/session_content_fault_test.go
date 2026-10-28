package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func TestSessionContentFaultsRemainExplicitAndRecoverable(t *testing.T) {
	for code, status := range map[string]int{"controller_offline": http.StatusServiceUnavailable, "relay_instance_unavailable": http.StatusServiceUnavailable, "content_unavailable": http.StatusBadGateway} {
		t.Run(code, func(t *testing.T) {
			err := &service.Fault{Code: code, Message: "Connect the original controller to read local content."}
			if ErrorKind(err) != code {
				t.Fatal("content failure lost diagnostic category")
			}
			response := httptest.NewRecorder()
			writeError(response, httptest.NewRequest(http.MethodGet, "/session/timeline", nil), testLogger(), "session", "read", err)
			var body struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if json.Unmarshal(response.Body.Bytes(), &body) != nil || response.Code != status || body.Error.Code != code || body.Error.Message != err.Message {
				t.Fatalf("fault response %d %s", response.Code, response.Body)
			}
		})
	}
}
