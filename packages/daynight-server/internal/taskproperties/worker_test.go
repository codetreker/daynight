package taskproperties

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func workerFixture() core.WorkerClaim {
	native := "native-session"
	return core.WorkerClaim{
		ClaimID: "00000000-0000-4000-8000-000000000001", State: core.WorkerActive,
		UserID: "00000000-0000-4000-8000-000000000002", WorkerID: "00000000-0000-4000-8000-000000000003",
		Machine:  core.WorkerMachine{ID: "00000000-0000-4000-8000-000000000004", Name: "Build machine 中文"},
		Platform: core.PlatformLinux, Agent: core.AgentCodex, WorktreeID: "00000000-0000-4000-8000-000000000005",
		Phase: core.WorkerExecuting, Herdr: &core.WorkerHerdr{Session: "w", WorkspaceID: "workspace", PaneID: "pane"},
		NativeSessionID: &native, ClaimedAt: time.Date(2026, 10, 24, 1, 2, 3, 456789123, time.UTC),
	}
}

func workerJSON(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	worker := workerFixture()
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(Encode(core.TaskProperties{Worker: &worker})), &root); err != nil {
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

func TestWorkerCodecRetainsEverySupportedExecutionValue(t *testing.T) {
	for _, state := range []core.WorkerState{core.WorkerActive, core.WorkerReleased, core.WorkerCompleted} {
		for _, platform := range []core.TaskPlatform{core.PlatformWindows, core.PlatformLinux, core.PlatformMacOS} {
			for _, agent := range []core.WorkerAgent{core.AgentCodex, core.AgentCopilot} {
				for _, phase := range []core.WorkerPhase{core.WorkerPreparing, core.WorkerExecuting, core.WorkerVerifying, core.WorkerCompleting, core.WorkerWaiting, core.WorkerPaused} {
					t.Run(fmt.Sprintf("%s/%s/%s/%s", state, platform, agent, phase), func(t *testing.T) {
						worker := workerFixture()
						worker.State, worker.Platform, worker.Agent, worker.Phase = state, platform, agent, phase
						properties := core.TaskProperties{PullRequests: []core.PullRequestProperty{{URL: "opaque\x00", Title: "  preserved\n中文  "}}, Worker: &worker}
						actual, err := Decode([]byte(Encode(properties)))
						if err != nil || !reflect.DeepEqual(actual, properties) {
							t.Fatalf("worker resource changed during serialization: expected %#v actual %#v error %v", properties, actual, err)
						}
					})
				}
			}
		}
	}
	for _, worker := range []*core.WorkerClaim{nil, func() *core.WorkerClaim {
		value := workerFixture()
		value.Herdr, value.NativeSessionID = nil, nil
		return &value
	}()} {
		properties := core.TaskProperties{PullRequests: []core.PullRequestProperty{}, Worker: worker}
		encoded := Encode(properties)
		if !strings.Contains(encoded, `"worker":`) {
			t.Fatal("a full task omitted its required nullable worker field")
		}
		actual, err := Decode([]byte(encoded))
		if err != nil || !reflect.DeepEqual(actual, properties) {
			t.Fatalf("nullable worker/session fields changed: %#v %v", actual, err)
		}
	}
}

func TestWorkerCodecRequiresCompleteStrictReadStructure(t *testing.T) {
	for _, field := range []string{"claimId", "state", "userId", "workerId", "machine", "platform", "agent", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt"} {
		t.Run("missing "+field, func(t *testing.T) {
			worker := workerJSON(t)
			delete(worker, field)
			if _, err := Decode(workerPropertiesJSON(t, worker)); err == nil {
				t.Fatalf("missing worker.%s was accepted", field)
			}
		})
	}
	for _, test := range []struct{ name, key, value string }{
		{"claim uuid", "claimId", `"invalid"`}, {"user uuid", "userId", `"invalid"`}, {"worker uuid", "workerId", `"invalid"`}, {"worktree uuid", "worktreeId", `"invalid"`},
		{"state", "state", `"idle"`}, {"platform", "platform", `"darwin"`}, {"agent", "agent", `"claude"`}, {"phase", "phase", `"done"`},
		{"state null", "state", `null`}, {"worker numeric", "workerId", `123`}, {"claimed timestamp", "claimedAt", `"not-time"`}, {"zero timestamp", "claimedAt", `"0001-01-01T00:00:00Z"`},
		{"machine scalar", "machine", `3`}, {"machine missing id", "machine", `{"name":"build"}`}, {"machine missing name", "machine", `{"id":"00000000-0000-4000-8000-000000000004"}`},
		{"machine wrong id", "machine", `{"id":"wrong","name":"build"}`}, {"machine blank name", "machine", `{"id":"00000000-0000-4000-8000-000000000004","name":" \n"}`},
		{"machine NUL name", "machine", `{"id":"00000000-0000-4000-8000-000000000004","name":"build\u0000"}`},
		{"machine unknown", "machine", `{"id":"00000000-0000-4000-8000-000000000004","name":"build","extra":true}`},
		{"machine duplicate", "machine", `{"id":"00000000-0000-4000-8000-000000000004","name":"build","name":"other"}`},
		{"herdr scalar", "herdr", `false`}, {"herdr missing", "herdr", `{"session":"w","workspaceId":"workspace"}`}, {"herdr wrong type", "herdr", `{"session":"w","workspaceId":null,"paneId":"pane"}`},
		{"herdr blank", "herdr", `{"session":" ","workspaceId":"workspace","paneId":"pane"}`}, {"herdr NUL", "herdr", `{"session":"w","workspaceId":"workspace","paneId":"pane\u0000"}`},
		{"herdr unknown", "herdr", `{"session":"w","workspaceId":"workspace","paneId":"pane","extra":true}`}, {"herdr duplicate", "herdr", `{"session":"w","workspaceId":"workspace","paneId":"pane","paneId":"other"}`},
		{"native numeric", "nativeSessionId", `0`}, {"native blank", "nativeSessionId", `" "`}, {"native NUL", "nativeSessionId", `"session\u0000"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			worker := workerJSON(t)
			worker[test.key] = json.RawMessage(test.value)
			data, err := json.Marshal(worker)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Decode(append(append([]byte(`{"pullRequests":[],"worker":`), data...), '}')); err == nil {
				t.Fatalf("invalid worker field was accepted: %s", data)
			}
		})
	}
	worker := workerJSON(t)
	worker["extra"] = json.RawMessage(`true`)
	if _, err := Decode(workerPropertiesJSON(t, worker)); err == nil {
		t.Fatal("unknown worker field was accepted")
	}
	valid := string(workerPropertiesJSON(t, workerJSON(t)))
	duplicate := strings.Replace(valid, `"worker":{`, `"worker":null,"worker":{`, 1)
	if _, err := Decode([]byte(duplicate)); err == nil {
		t.Fatal("duplicate worker property was accepted")
	}
	duplicate = strings.Replace(valid, `"claimId":`, `"claimId":"00000000-0000-4000-8000-000000000001","claimId":`, 1)
	if _, err := Decode([]byte(duplicate)); err == nil {
		t.Fatal("duplicate worker identity was accepted")
	}
	for _, data := range []string{`{"pullRequests":[]}`, `{"pullRequests":[],"worker":{}}`, `{"pullRequests":[],"worker":[]}`, `{"pullRequests":[],"worker":true}`} {
		if _, err := Decode([]byte(data)); err == nil {
			t.Fatalf("invalid nullable worker read field accepted: %s", data)
		}
	}
}

func TestWorkerPropertyCannotEnterWritablePatch(t *testing.T) {
	for _, data := range []string{`{"worker":null}`, `{"pullRequests":[],"worker":null}`, string(workerPropertiesJSON(t, workerJSON(t)))} {
		if _, err := DecodePatch([]byte(data)); err == nil {
			t.Fatalf("protected worker input accepted by public patch: %s", data)
		}
	}
	patch, err := DecodePatch([]byte(`{"pullRequests":[{"url":"opaque\u0000","title":""}]}`))
	if err != nil || patch.PullRequests == nil || len(*patch.PullRequests) != 1 || (*patch.PullRequests)[0].URL != "opaque\x00" {
		t.Fatalf("public PR patch changed while worker became protected: %#v %v", patch, err)
	}
}
