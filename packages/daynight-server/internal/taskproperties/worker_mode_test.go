package taskproperties

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func encodedWorkerMode(t *testing.T, properties core.TaskProperties) string {
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
	if _, err := Decode(workerPropertiesJSON(t, worker)); err == nil {
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
				properties, err := Decode(workerPropertiesJSON(t, worker))
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
			if _, err := Decode(workerPropertiesJSON(t, worker)); err == nil {
				t.Fatalf("invalid mode accepted: %s", mode)
			}
		})
	}
	for _, agent := range []string{"codex", "copilot"} {
		worker := workerJSON(t)
		worker["agentControlMode"] = json.RawMessage(`"web"`)
		worker["agent"] = json.RawMessage(`"` + agent + `"`)
		if _, err := Decode(workerPropertiesJSON(t, worker)); err == nil {
			t.Fatalf("invalid web execution accepted for %s", agent)
		}
	}
}
