package assistanttask

import (
	"context"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"io"
	"net/http"
	"testing"
)

func TestPresetRejectsMalformedRequestsBeforeCallingService(t *testing.T) {
	h := testHandler(t, func(context.Context, core.Actor, string, ...any) (any, error) {
		t.Fatal("malformed request invoked preset")
		return nil, nil
	}, io.Discard)
	for _, body := range []string{`{}`, `{"id":"bad","targetBotId":"` + testTarget + `"}`, `{"id":"` + testID + `","targetBotId":"bad"}`, `{"id":"` + testID + `","targetBotId":"` + testTarget + `","rules":[]}`} {
		response := request(h, http.MethodPost, "/api/v1/assistant-task-presets/watchdog", body, false)
		assertError(t, response, http.StatusBadRequest, "invalid_input")
	}
	response := request(h, http.MethodGet, "/api/v1/assistant-task-presets/watchdog", "", false)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("method %d", response.Code)
	}
}
