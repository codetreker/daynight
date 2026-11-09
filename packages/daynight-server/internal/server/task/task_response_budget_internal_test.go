package task

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

func TestSyncAdmissionMeasuresActualRESTEnvelopeAndNewline(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	response := api.TaskSync{Mode: "snapshot", Epoch: "<&", ObservedAt: now, Tasks: []api.TaskViewRecord{{TitlePreview: "<&中文", Properties: api.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"<&","title":"x"}]`)}, DependsOn: []string{}, ExternalDependsOn: []string{}, CreatedAt: now, UpdatedAt: now}}, AssigneeVersions: []api.TaskAssigneeVersion{}, Sessions: map[string]string{"11111111-1111-4111-8111-111111111111": "working", "22222222-2222-4222-8222-222222222222": "notice", "33333333-3333-4333-8333-333333333333": "warning", "44444444-4444-4444-8444-444444444444": "pending"}}
	var actual bytes.Buffer
	if err := json.NewEncoder(&actual).Encode(response); err != nil {
		t.Fatal(err)
	}
	if err := admitSyncResponse(response, int64(actual.Len())); err != nil {
		t.Fatal(err)
	}
	var fault *model.Fault
	if err := admitSyncResponse(response, int64(actual.Len()-1)); !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" {
		t.Fatalf("got %v", err)
	}
	withoutSessions := response
	withoutSessions.Sessions = map[string]string{}
	var baseline bytes.Buffer
	if err := json.NewEncoder(&baseline).Encode(withoutSessions); err != nil {
		t.Fatal(err)
	}
	if err := admitSyncResponse(response, int64(baseline.Len())); !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" {
		t.Fatalf("Session map escaped final response budget: %v", err)
	}
	if !strings.HasSuffix(actual.String(), "\n") {
		t.Fatal("missing encoder newline")
	}
}

func TestTaskReadResponseErrorPreservesUnrelatedCauses(t *testing.T) {
	unknown := errors.New("unexpected encoder failure")
	if got := taskReadResponseError(unknown); got != unknown {
		t.Fatalf("unrelated error was reclassified: %v", got)
	}
	for _, cause := range []error{&limit.Violation{Field: "task", Actual: 2, Max: 1}, taskprotocol.ErrLegacyWorkerIndeterminate} {
		var fault *model.Fault
		got := taskReadResponseError(cause)
		if !errors.As(got, &fault) || fault.Code != "resource_limit_exceeded" || !errors.Is(got, cause) {
			t.Fatalf("capacity classification lost cause: %v", got)
		}
	}
}

func TestTaskMutationProjectionFailurePreservesCommittedFact(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	request := httptest.NewRequest(http.MethodPost, "/", nil)
	response := httptest.NewRecorder()
	// This corrupt claim makes legacy projection fail after the write has
	// already returned; the response must never imply a rolled-back mutation.
	task := model.Task{Properties: model.TaskProperties{"worker": json.RawMessage(`{}`)}}
	writeTaskMutation(response, request, logger, "task", http.StatusCreated, "/created", task)
	var failure api.ErrorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || response.Code != http.StatusServiceUnavailable || failure.Error.Code != "write_outcome_unknown" || response.Header().Get("Location") != "" {
		t.Fatalf("unexpected response: status=%d body=%s err=%v", response.Code, response.Body, err)
	}
	if !strings.Contains(logs.String(), `"tx_outcome":"committed"`) || !strings.Contains(logs.String(), `"write_outcome":"unknown"`) {
		t.Fatalf("committed outcome missing: %s", &logs)
	}
}
