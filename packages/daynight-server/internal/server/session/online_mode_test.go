package session

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestControllerChannelRejectsIncompatibleAuthenticatedGrantBeforeUpgrade(t *testing.T) {
	calls := 0
	routes := &Routes{logger: slog.Default(), service: serviceCalls{AuthenticateControllerOnline: func(_ context.Context, token string, relay, body bool) error {
		calls++
		if token != "dncontroller_test" || relay || body {
			t.Fatalf("admission arguments: %q %v %v", token, relay, body)
		}
		return &model.Fault{Code: "upgrade_required", Message: "This Session requires online relay version 1."}
	}}}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/controller-channel", nil)
	request.Header.Set("Authorization", "Bearer dncontroller_test")
	request.Header.Set("Sec-WebSocket-Protocol", sp.Protocol)
	response := httptest.NewRecorder()
	routes.controllerChannel(response, request)
	if calls != 1 || response.Code != http.StatusUpgradeRequired || !strings.Contains(response.Body.String(), `"code":"upgrade_required"`) {
		t.Fatalf("response %d %s calls %d", response.Code, response.Body.String(), calls)
	}
	if strings.Contains(response.Body.String(), "dncontroller_test") {
		t.Fatal("credential leaked")
	}
}
