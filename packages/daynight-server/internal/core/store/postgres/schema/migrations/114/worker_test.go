package migration114

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const fixture = `{"claimId":"00000000-0000-4000-8000-000000000001","state":"active","userId":"00000000-0000-4000-8000-000000000002","workerId":"00000000-0000-4000-8000-000000000003","machine":{"id":"00000000-0000-4000-8000-000000000004","name":"Machine"},"platform":"windows","agent":"codex","agentControlMode":"web","worktreeId":"00000000-0000-4000-8000-000000000005","phase":"executing","nativeSessionId":null,"claimedAt":"2020-01-02T03:04:05Z"}`

func TestFrozenStoredWorkerRules(t *testing.T) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(fixture), &fields); err != nil {
		t.Fatal(err)
	}
	assert := func(t *testing.T, raw []byte, valid bool) {
		t.Helper()
		err := validateWorker(raw)
		if (err == nil) != valid {
			t.Fatalf("frozen=%v want valid=%v", err, valid)
		}
		if valid {
			var original inventoryWorker
			var current model.WorkerClaim
			if err := json.Unmarshal(raw, &original); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(raw, &current); err != nil || original.State != string(current.State) || original.UserID != current.UserID || original.WorkerID != current.WorkerID {
				t.Fatalf("original inventory rules differ: %v", err)
			}
		}
	}
	assert(t, []byte(fixture), true)
	for key := range fields {
		t.Run("missing "+key, func(t *testing.T) {
			copy := make(map[string]json.RawMessage)
			for name, value := range fields {
				if name != key {
					copy[name] = value
				}
			}
			raw, _ := json.Marshal(copy)
			assert(t, raw, false)
		})
	}
	for _, test := range []struct {
		key, value string
		valid      bool
	}{
		{"state", `"completed"`, true}, {"state", `"released"`, false}, {"state", `null`, false},
		{"userId", `"ABCDEF01-ABCD-ABCD-ABCD-ABCDEF012345"`, true}, {"userId", `"00000000-0000-0000-0000-000000000000"`, true},
		{"userId", `"00000000-0000-0000-0000-00000000000g"`, false}, {"userId", `"000000000000-0000-0000-000000000000"`, false}, {"userId", `"short"`, false},
		{"state", `7`, false}, {"machine", `null`, false}, {"machine", `{"id":"invalid","name":"ok"}`, false},
		{"machine", `{"id":"00000000-0000-4000-8000-000000000004"}`, false}, {"machine", `{"name":"ok"}`, false},
		{"machine", `{"id":"00000000-0000-4000-8000-000000000004","name":"\u0000"}`, false},
		{"platform", `"other"`, false}, {"agent", `"other"`, false}, {"agentControlMode", `"other"`, false}, {"phase", `"other"`, false},
		{"claimedAt", `"invalid"`, false}, {"claimedAt", `"0001-01-01T00:00:00Z"`, false},
		{"herdr", `null`, true}, {"herdr", `false`, false}, {"herdr", `{"session":"s","workspaceId":"w","paneId":"p"}`, false},
		{"nativeSessionId", `"native"`, true}, {"nativeSessionId", `" "`, false}, {"nativeSessionId", `7`, false},
	} {
		t.Run(test.key+" "+test.value, func(t *testing.T) {
			copy := make(map[string]json.RawMessage)
			for key, value := range fields {
				copy[key] = value
			}
			copy[test.key] = json.RawMessage(test.value)
			raw, _ := json.Marshal(copy)
			assert(t, raw, test.valid)
		})
	}
	for _, binding := range []string{`null`, `{"session":"s","workspaceId":"w","paneId":"p"}`, `{"session":"s","workspaceId":"w"}`, `{"session":"s","workspaceId":"w","paneId":" "}`} {
		herdr := strings.Replace(fixture, `"agentControlMode":"web"`, `"agentControlMode":"herdr","herdr":`+binding, 1)
		assert(t, []byte(herdr), binding == `null` || strings.Contains(binding, `"paneId":"p"`))
	}
	for _, raw := range []string{`null`, `[]`, `{`, `{"other":1}`, fixture + ` true`, strings.Replace(fixture, `"state":"active"`, `"state":"active","state":"active"`, 1), strings.Replace(fixture, `"state":"active"`, `"state":`, 1)} {
		if err := validateWorker([]byte(raw)); err == nil {
			t.Fatalf("invalid object accepted: %s", raw)
		}
	}
}
