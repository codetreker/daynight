package task

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestTaskMutationProjectionFailurePreservesCommittedFact(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	response := httptest.NewRecorder()
	// A typed decoding failure after the write returns must retain the
	// committed transaction outcome.
	task := model.Task{Properties: model.TaskProperties{"worker": json.RawMessage(`{"agent":3}`)}}
	writeTaskMutation(response, request, logger, "task", http.StatusCreated, "/created", task)
	var failure api.ErrorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || response.Code != http.StatusServiceUnavailable || failure.Error.Code != "write_outcome_unknown" || response.Header().Get("Location") != "" {
		t.Fatalf("unexpected response: status=%d body=%s err=%v", response.Code, response.Body, err)
	}
	if !strings.Contains(logs.String(), `"tx_outcome":"committed"`) || !strings.Contains(logs.String(), `"write_outcome":"unknown"`) {
		t.Fatalf("committed outcome missing: %s", &logs)
	}
}
