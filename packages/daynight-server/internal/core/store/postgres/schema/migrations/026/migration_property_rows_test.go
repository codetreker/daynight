package store

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func queryID(value int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", value) }

func legacyWorker026Fixture() map[string]any {
	return map[string]any{
		"claimId": queryID(201), "state": "active", "userId": queryID(202), "workerId": queryID(203),
		"machine": map[string]any{"id": queryID(204), "name": "Machine"}, "platform": "linux", "agent": "codex",
		"agentControlMode": "herdr", "worktreeId": queryID(205), "phase": "executing",
		"herdr":           map[string]any{"session": "session", "workspaceId": "workspace", "paneId": "pane"},
		"nativeSessionId": "native", "claimedAt": "2026-10-24T01:02:03.123456Z",
	}
}

func legacyWorkerJSON026(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(legacyWorker026Fixture())
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]json.RawMessage
	if err = json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func legacyWorkerPropertiesJSON026(t *testing.T, worker map[string]json.RawMessage) []byte {
	t.Helper()
	raw, err := json.Marshal(worker)
	if err != nil {
		t.Fatal(err)
	}
	return append(append([]byte(`{"pullRequests":[],"worker":`), raw...), '}')
}
func TestLegacyPropertyRows026RequiresCompleteStrictWorker(t *testing.T) {
	for _, field := range []string{"claimId", "state", "userId", "workerId", "machine", "platform", "agent", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt"} {
		t.Run("missing "+field, func(t *testing.T) {
			worker := legacyWorkerJSON026(t)
			delete(worker, field)
			if _, err := decodeLegacyPropertyRows026(legacyWorkerPropertiesJSON026(t, worker)); err == nil {
				t.Fatalf("missing worker.%s was accepted", field)
			}
		})
	}
	for _, test := range []struct{ name, key, value string }{
		{"claim uuid", "claimId", `"invalid"`}, {"user uuid", "userId", `"invalid"`}, {"worker uuid", "workerId", `"invalid"`}, {"worktree uuid", "worktreeId", `"invalid"`},
		{"state", "state", `"idle"`}, {"platform", "platform", `"darwin"`}, {"agent", "agent", `"other"`}, {"phase", "phase", `"done"`},
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
			worker := legacyWorkerJSON026(t)
			worker[test.key] = json.RawMessage(test.value)
			data, err := json.Marshal(worker)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := decodeLegacyPropertyRows026(append(append([]byte(`{"pullRequests":[],"worker":`), data...), '}')); err == nil {
				t.Fatalf("invalid worker field was accepted: %s", data)
			}
		})
	}
	worker := legacyWorkerJSON026(t)
	worker["extra"] = json.RawMessage(`true`)
	if _, err := decodeLegacyPropertyRows026(legacyWorkerPropertiesJSON026(t, worker)); err == nil {
		t.Fatal("unknown worker field was accepted")
	}
	valid := string(legacyWorkerPropertiesJSON026(t, legacyWorkerJSON026(t)))
	duplicate := strings.Replace(valid, `"worker":{`, `"worker":null,"worker":{`, 1)
	if _, err := decodeLegacyPropertyRows026([]byte(duplicate)); err == nil {
		t.Fatal("duplicate worker property was accepted")
	}
	duplicate = strings.Replace(valid, `"claimId":`, `"claimId":"00000000-0000-4000-8000-000000000001","claimId":`, 1)
	if _, err := decodeLegacyPropertyRows026([]byte(duplicate)); err == nil {
		t.Fatal("duplicate worker identity was accepted")
	}
	for _, data := range []string{`{"pullRequests":[]}`, `{"pullRequests":[],"worker":{}}`, `{"pullRequests":[],"worker":[]}`, `{"pullRequests":[],"worker":true}`} {
		if _, err := decodeLegacyPropertyRows026([]byte(data)); err == nil {
			t.Fatalf("invalid nullable worker read field accepted: %s", data)
		}
	}
}

func TestLegacyPropertyRows026NormalizesOnlySupportedValues(t *testing.T) {
	for _, raw := range []string{`[]`, `null`, `{"pullRequests":[]}false`, `{"pullRequests":[{}],"worker":null}`, `{"pullRequests":[{"url":"x","title":null}],"worker":null}`, `{"pullRequests":[{"url":"x","url":"y","title":""}],"worker":null}`} {
		if _, err := decodeLegacyPropertyRows026([]byte(raw)); err == nil {
			t.Fatalf("invalid legacy document accepted: %s", raw)
		}
	}
	for _, test := range []struct{ key, raw string }{{"agentControlMode", `"invalid"`}, {"agentControlMode", `null`}, {"claimId", `"00000000-0000-4000-8000-00000000000z"`}} {
		worker := legacyWorkerJSON026(t)
		worker[test.key] = json.RawMessage(test.raw)
		if _, err := decodeLegacyPropertyRows026(legacyWorkerPropertiesJSON026(t, worker)); err == nil {
			t.Fatal("invalid legacy worker mode or identifier accepted")
		}
	}
	worker := legacyWorkerJSON026(t)
	worker["agentControlMode"] = json.RawMessage(`"web"`)
	if _, err := decodeLegacyPropertyRows026(legacyWorkerPropertiesJSON026(t, worker)); err == nil {
		t.Fatal("legacy web worker with Herdr accepted")
	}
	worker["herdr"] = json.RawMessage(`null`)
	worker["nativeSessionId"] = json.RawMessage(`null`)
	if _, err := decodeLegacyPropertyRows026(legacyWorkerPropertiesJSON026(t, worker)); err != nil {
		t.Fatal(err)
	}
	if m026encodeWorker(nil) != nil {
		t.Fatal("nil legacy worker encoded as a record")
	}
}
