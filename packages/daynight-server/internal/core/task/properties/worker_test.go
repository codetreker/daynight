package properties

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func workerFixture() model.WorkerClaim {
	native := "native-session"
	return model.WorkerClaim{
		ClaimID: "00000000-0000-4000-8000-000000000001", State: model.WorkerActive,
		UserID: "00000000-0000-4000-8000-000000000002", WorkerID: "00000000-0000-4000-8000-000000000003",
		Machine:  model.WorkerMachine{ID: "00000000-0000-4000-8000-000000000004", Name: "Build machine 中文"},
		Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: "00000000-0000-4000-8000-000000000005",
		Phase: model.WorkerExecuting, Herdr: &model.WorkerHerdr{Session: "w", WorkspaceID: "workspace", PaneID: "pane"},
		NativeSessionID: &native, ClaimedAt: time.Date(2026, 10, 24, 1, 2, 3, 456789123, time.UTC),
	}
}

func workerJSON(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	worker := workerFixture()
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(encodedProperties(t, propertyFixture(t, nil, &worker))), &root); err != nil {
		t.Fatal(err)
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(root["worker"], &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func workerPropertiesJSON(t *testing.T, worker map[string]json.RawMessage) []byte {
	t.Helper()
	data, err := json.Marshal(worker)
	if err != nil {
		t.Fatal(err)
	}
	return append(append([]byte(`{"pullRequests":[],"worker":`), data...), '}')
}

func TestWorkerPropertyCannotEnterWritablePatch(t *testing.T) {
	for _, data := range []string{`{"worker":null}`, `{"pullRequests":[],"worker":null}`, string(workerPropertiesJSON(t, workerJSON(t)))} {
		if _, err := DecodePatch([]byte(data)); err == nil {
			t.Fatalf("protected worker input accepted by public patch: %s", data)
		}
	}
	patch, err := DecodePatch([]byte(`{"pullRequests":[{"url":"opaque\u0000","title":""}]}`))
	if err != nil || len(pullRequestsValue(t, patch)) != 1 || pullRequestsValue(t, patch)[0].URL != "opaque\x00" {
		t.Fatalf("public PR patch changed while worker became protected: %#v %v", patch, err)
	}
}
