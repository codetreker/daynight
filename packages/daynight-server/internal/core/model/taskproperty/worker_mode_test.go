package taskproperty_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func encodedWorkerMode(t *testing.T, properties model.TaskProperties) string {
	t.Helper()
	var document struct {
		Worker struct {
			Mode string `json:"agentControlMode"`
		} `json:"worker"`
	}
	if err := json.Unmarshal([]byte(encodedProperties(t, properties)), &document); err != nil {
		t.Fatal(err)
	}
	return document.Worker.Mode
}

func TestWorkerModeReadRequiresCanonicalControlMode(t *testing.T) {
	worker := workerJSON(t)
	delete(worker, "agentControlMode")
	if _, err := taskproperty.Decode(workerPropertiesJSON(t, worker)); err == nil {
		t.Fatal("stored worker without control mode was accepted")
	}
}

func TestWorkerModeCodecPreservesSupportedExecutionPairs(t *testing.T) {
	for _, mode := range []string{"herdr", "web"} {
		for _, agent := range []string{"codex", "claude", "copilot"} {
			t.Run(mode+"/"+agent, func(t *testing.T) {
				worker := workerJSON(t)
				worker["agentControlMode"] = json.RawMessage(`"` + mode + `"`)
				worker["agent"] = json.RawMessage(`"` + agent + `"`)
				if mode == "web" {
					worker["herdr"] = json.RawMessage(`null`)
				}
				properties, err := taskproperty.Decode(workerPropertiesJSON(t, worker))
				if err != nil {
					t.Fatalf("supported execution rejected: %v", err)
				}
				if got := encodedWorkerMode(t, properties); got != mode {
					t.Fatalf("mode changed during serialization: got %q, want %q", got, mode)
				}
			})
		}
	}
}

func TestWorkerModeCodecRejectsInvalidModesAndWebHerdrBindings(t *testing.T) {
	for _, mode := range []string{`null`, `false`, `""`, `"WEB"`, `"other"`, `"web "`} {
		t.Run(mode, func(t *testing.T) {
			worker := workerJSON(t)
			worker["agentControlMode"] = json.RawMessage(mode)
			if _, err := taskproperty.Decode(workerPropertiesJSON(t, worker)); err == nil {
				t.Fatalf("invalid mode accepted: %s", mode)
			}
		})
	}
	for _, agent := range []string{"codex", "copilot"} {
		worker := workerJSON(t)
		worker["agentControlMode"] = json.RawMessage(`"web"`)
		worker["agent"] = json.RawMessage(`"` + agent + `"`)
		if _, err := taskproperty.Decode(workerPropertiesJSON(t, worker)); err == nil {
			t.Fatalf("invalid web execution accepted for %s", agent)
		}
	}
}

func TestStoredWorkerAcceptsWebWithoutHerdr(t *testing.T) {
	worker := workerJSON(t)
	worker["agentControlMode"] = json.RawMessage(`"web"`)
	delete(worker, "herdr")
	properties, err := taskproperty.Decode(workerPropertiesJSON(t, worker))
	if err != nil {
		t.Fatalf("stored web worker without herdr: %v", err)
	}
	claim, err := taskproperty.Worker(properties)
	if err != nil || claim.AgentControlMode != model.AgentControlModeWeb || claim.Herdr != nil {
		t.Fatalf("stored worker changed: %#v, %v", claim, err)
	}
	encoded, err := taskproperty.Encode(properties)
	if err != nil {
		t.Fatalf("re-encode stored worker: %v", err)
	}
	decoded, err := taskproperty.Decode([]byte(encoded))
	if err != nil {
		t.Fatalf("read re-encoded worker: %v", err)
	}
	claim, err = taskproperty.Worker(decoded)
	if err != nil || claim.AgentControlMode != model.AgentControlModeWeb || claim.Herdr != nil {
		t.Fatalf("worker changed on round trip: %#v, %v", claim, err)
	}
	raw, _ := json.Marshal(worker)
	value, err := taskproperty.NormalizeValue("worker", raw)
	if err != nil || strings.Contains(string(value), `"herdr"`) {
		t.Fatalf("new Web claim retained a retired field: %s %v", value, err)
	}
	worker["herdr"] = json.RawMessage(`{"session":"s","workspaceId":"w","paneId":"p"}`)
	if _, err := taskproperty.Decode(workerPropertiesJSON(t, worker)); err == nil {
		t.Fatal("stored web worker accepted a herdr binding")
	}
}

func TestStoredHerdrWorkerRetainsResourcesAcrossEncoding(t *testing.T) {
	worker := workerJSON(t)
	worker["herdr"] = json.RawMessage(`{"session":"会话\n&","workspaceId":"workspace","paneId":"pane"}`)
	properties, err := taskproperty.Decode(workerPropertiesJSON(t, worker))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := taskproperty.Encode(properties)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := taskproperty.Decode([]byte(encoded))
	if err != nil {
		t.Fatal(err)
	}
	claim, err := taskproperty.Worker(decoded)
	if err != nil || claim.Herdr == nil || claim.Herdr.Session != "会话\n&" || claim.Herdr.WorkspaceID != "workspace" || claim.Herdr.PaneID != "pane" {
		t.Fatalf("historical resource changed: %#v, %v", claim, err)
	}
}
