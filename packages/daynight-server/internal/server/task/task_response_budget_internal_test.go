package task

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestSyncAdmissionMeasuresActualRESTEnvelopeAndNewline(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	response := api.TaskSync{Mode: "snapshot", Epoch: "<&", ObservedAt: now, Tasks: []api.TaskViewRecord{{TitlePreview: "<&中文", Properties: api.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"<&","title":"x"}]`)}, DependsOn: []string{}, ExternalDependsOn: []string{}, CreatedAt: now, UpdatedAt: now}}, AssigneeVersions: []api.TaskAssigneeVersion{}}
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
	if !strings.HasSuffix(actual.String(), "\n") {
		t.Fatal("missing encoder newline")
	}
}
