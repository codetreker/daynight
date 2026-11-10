package worker

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const configurationInputProjectA = "11111111-1111-4111-8111-111111111111"
const configurationInputProjectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

func configurationInputDocument() map[string]any {
	return map[string]any{
		"maxConcurrent": 1, "pollIntervalMs": 60000, "recoveryLimit": 3, "preferPlatformSpecificTasks": false,
		"native":   map[string]any{"agent": "codex", "model": nil, "args": []any{}},
		"projects": []any{},
	}
}

func configurationInputJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestWorkerConfigurationInputPreservesOverridesAndCanonicalizesProjects(t *testing.T) {
	document := configurationInputDocument()
	document["maxConcurrent"] = int64(64)
	document["pollIntervalMs"] = int64(60000)
	document["recoveryLimit"] = int64(0)
	document["preferPlatformSpecificTasks"] = true
	document["native"] = map[string]any{"agent": "copilot", "model": "provider/model", "args": []any{"--flag", "a b"}}
	document["projects"] = []any{
		map[string]any{"projectId": strings.ToUpper(configurationInputProjectB), "nativeOverrides": map[string]any{"agent": "claude", "model": nil, "args": []any{}}},
		map[string]any{"projectId": configurationInputProjectA, "nativeOverrides": map[string]any{}},
	}
	value, err := ParseWorkerConfiguration(configurationInputJSON(t, document))
	if err != nil {
		t.Fatal(err)
	}
	if value.MaxConcurrent != 64 || value.PollIntervalMs != 60000 || value.RecoveryLimit != 0 || !value.PreferPlatformSpecificTasks || value.Native.Agent != model.AgentCopilot || value.Native.Model == nil || *value.Native.Model != "provider/model" || !reflect.DeepEqual(value.Native.Args, []string{"--flag", "a b"}) {
		t.Fatalf("invalid parsed settings: %+v", value)
	}
	if len(value.Projects) != 2 || value.Projects[0].ProjectID != configurationInputProjectA || value.Projects[1].ProjectID != configurationInputProjectB || len(value.Projects[0].NativeOverrides) != 0 {
		t.Fatalf("projects not canonical or inheritance lost: %+v", value.Projects)
	}
	overrides := value.Projects[1].NativeOverrides
	if string(overrides["agent"]) != `"claude"` || string(overrides["model"]) != "null" || string(overrides["args"]) != "[]" {
		t.Fatalf("explicit override intent lost: %s %s %s", overrides["agent"], overrides["model"], overrides["args"])
	}
	for _, agent := range []string{"codex", "claude", "copilot"} {
		document := configurationInputDocument()
		document["native"].(map[string]any)["agent"] = agent
		parsed, err := ParseWorkerConfiguration(configurationInputJSON(t, document))
		if err != nil || parsed.PreferPlatformSpecificTasks || parsed.Native.Agent != model.WorkerAgent(agent) || parsed.Native.Model != nil || parsed.Native.Args == nil || parsed.Projects == nil {
			t.Fatalf("explicit empty settings rejected: %+v %v", parsed, err)
		}
	}
}

func TestWorkerConfigurationInputRejectsMalformedConfiguration(t *testing.T) {
	cases := map[string]func(map[string]any){
		"preference missing":    func(v map[string]any) { delete(v, "preferPlatformSpecificTasks") },
		"preference null":       func(v map[string]any) { v["preferPlatformSpecificTasks"] = nil },
		"preference number":     func(v map[string]any) { v["preferPlatformSpecificTasks"] = 1 },
		"preference string":     func(v map[string]any) { v["preferPlatformSpecificTasks"] = "false" },
		"missing scalar":        func(v map[string]any) { delete(v, "maxConcurrent") },
		"unknown field":         func(v map[string]any) { v["repositoryRoot"] = "/private" },
		"max zero":              func(v map[string]any) { v["maxConcurrent"] = 0 },
		"max unsafe":            func(v map[string]any) { v["maxConcurrent"] = int64(9007199254740992) },
		"max fractional":        func(v map[string]any) { v["maxConcurrent"] = 1.5 },
		"max null":              func(v map[string]any) { v["maxConcurrent"] = nil },
		"max string":            func(v map[string]any) { v["maxConcurrent"] = "1" },
		"poll zero":             func(v map[string]any) { v["pollIntervalMs"] = 0 },
		"poll over timer":       func(v map[string]any) { v["pollIntervalMs"] = int64(2147483648) },
		"recovery negative":     func(v map[string]any) { v["recoveryLimit"] = -1 },
		"recovery unsafe":       func(v map[string]any) { v["recoveryLimit"] = int64(9007199254740992) },
		"native missing":        func(v map[string]any) { delete(v, "native") },
		"native null":           func(v map[string]any) { v["native"] = nil },
		"native scalar":         func(v map[string]any) { v["native"] = "codex" },
		"native agent missing":  func(v map[string]any) { delete(v["native"].(map[string]any), "agent") },
		"native agent invalid":  func(v map[string]any) { v["native"].(map[string]any)["agent"] = "other" },
		"native agent null":     func(v map[string]any) { v["native"].(map[string]any)["agent"] = nil },
		"native model missing":  func(v map[string]any) { delete(v["native"].(map[string]any), "model") },
		"native model number":   func(v map[string]any) { v["native"].(map[string]any)["model"] = 5 },
		"native model blank":    func(v map[string]any) { v["native"].(map[string]any)["model"] = "  " },
		"native model control":  func(v map[string]any) { v["native"].(map[string]any)["model"] = "model\x00" },
		"native args missing":   func(v map[string]any) { delete(v["native"].(map[string]any), "args") },
		"native args null":      func(v map[string]any) { v["native"].(map[string]any)["args"] = nil },
		"native args object":    func(v map[string]any) { v["native"].(map[string]any)["args"] = map[string]any{} },
		"native arg blank":      func(v map[string]any) { v["native"].(map[string]any)["args"] = []any{" "} },
		"native arg control":    func(v map[string]any) { v["native"].(map[string]any)["args"] = []any{"--flag\n"} },
		"native arg number":     func(v map[string]any) { v["native"].(map[string]any)["args"] = []any{2} },
		"native arg null":       func(v map[string]any) { v["native"].(map[string]any)["args"] = []any{nil} },
		"native read only mode": func(v map[string]any) { v["native"].(map[string]any)["agentControlMode"] = "web" },
		"projects missing":      func(v map[string]any) { delete(v, "projects") },
		"projects null":         func(v map[string]any) { v["projects"] = nil },
		"projects object":       func(v map[string]any) { v["projects"] = map[string]any{} },
		"project scalar":        func(v map[string]any) { v["projects"] = []any{"project"} },
		"project missing id":    func(v map[string]any) { v["projects"] = []any{map[string]any{"nativeOverrides": map[string]any{}}} },
		"project id null": func(v map[string]any) {
			v["projects"] = []any{map[string]any{"projectId": nil, "nativeOverrides": map[string]any{}}}
		},
		"project invalid id": func(v map[string]any) {
			v["projects"] = []any{map[string]any{"projectId": "unknown", "nativeOverrides": map[string]any{}}}
		},
		"project missing overrides": func(v map[string]any) { v["projects"] = []any{map[string]any{"projectId": configurationInputProjectA}} },
		"project null overrides": func(v map[string]any) {
			v["projects"] = []any{map[string]any{"projectId": configurationInputProjectA, "nativeOverrides": nil}}
		},
		"project invalid override": func(v map[string]any) {
			v["projects"] = []any{map[string]any{"projectId": configurationInputProjectA, "nativeOverrides": map[string]any{"model": ""}}}
		},
		"project unknown attribute": func(v map[string]any) {
			v["projects"] = []any{map[string]any{"projectId": configurationInputProjectA, "nativeOverrides": map[string]any{}, "path": "private"}}
		},
		"project duplicate normalized id": func(v map[string]any) {
			v["projects"] = []any{map[string]any{"projectId": configurationInputProjectB, "nativeOverrides": map[string]any{}}, map[string]any{"projectId": strings.ToUpper(configurationInputProjectB), "nativeOverrides": map[string]any{}}}
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			document := configurationInputDocument()
			change(document)
			_, err := ParseWorkerConfiguration(configurationInputJSON(t, document))
			requireFault(t, err, "invalid_input")
		})
	}
	for _, raw := range []string{`null`, `[]`, `{`, `{} {}`, `{"maxConcurrent":1,"maxConcurrent":2}`, `{"maxConcurrent":1,"pollIntervalMs":1,"recoveryLimit":0,"native":{"agent":"codex","agent":"copilot","model":null,"args":[]},"projects":[]}`} {
		_, err := ParseWorkerConfiguration(json.RawMessage(raw))
		requireFault(t, err, "invalid_input")
	}
}

func TestWorkerConfigurationRevisionBoundaries(t *testing.T) {
	for _, test := range []struct {
		text string
		zero bool
		want int64
	}{{"0", true, 0}, {"1", false, 1}, {"9007199254740993", false, 9007199254740993}, {"9223372036854775807", false, math.MaxInt64}} {
		got, err := ConfigurationRevision(test.text, test.zero)
		if err != nil || got != test.want {
			t.Fatalf("revision %q: %d %v", test.text, got, err)
		}
	}
	for _, text := range []string{"", "0", "-0", "-1", "+1", "01", " 1", "1 ", "1.0", "1e3", "9223372036854775808", "999999999999999999999999999"} {
		_, err := ConfigurationRevision(text, false)
		requireFault(t, err, "invalid_input")
	}
}

func configurationInputFailure() map[string]any {
	return map[string]any{"code": "timeout", "category": "repository", "phase": "prepare", "occurredAt": "2026-11-04T12:00:00+02:00"}
}

func configurationInputItem(kind string, value any) map[string]any {
	key := map[string]any{"kind": kind}
	if strings.HasPrefix(kind, "project") {
		key["projectId"] = configurationInputProjectB
	}
	return map[string]any{"key": key, "targetRevision": "2", "appliedValue": value, "state": "applied", "error": nil, "lastFailure": nil, "nextAttemptAt": nil}
}

func configurationInputExchange(item map[string]any) map[string]any {
	return map[string]any{"bootstrap": nil, "observation": map[string]any{"baseRevision": "0", "desiredRevision": "3", "items": []any{item}}}
}

func TestWorkerConfigurationInputParsesCompleteApplicationOutcomes(t *testing.T) {
	native := map[string]any{"agent": "claude", "model": nil, "args": []any{}}
	items := []any{
		configurationInputItem("maxConcurrent", 3), configurationInputItem("pollIntervalMs", 1000), configurationInputItem("recoveryLimit", 0),
		configurationInputItem("native", native), configurationInputItem("projectPreparation", true), configurationInputItem("projectRemoval", true), configurationInputItem("projectNative", native),
	}
	failure := configurationInputItem("projectPreparation", nil)
	failure["state"] = "error"
	failure["error"] = configurationInputFailure()
	failure["lastFailure"] = configurationInputFailure()
	failure["nextAttemptAt"] = "2026-11-04T12:01:00+02:00"
	failure["key"].(map[string]any)["projectId"] = configurationInputProjectA
	items = append(items, failure)
	document := map[string]any{"bootstrap": configurationInputDocument(), "observation": map[string]any{"baseRevision": "9007199254740993", "desiredRevision": "9223372036854775807", "items": items}}
	parsed, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, document))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Bootstrap == nil || parsed.Observation == nil || parsed.Observation.BaseRevision != "9007199254740993" || len(parsed.Observation.Items) != 8 {
		t.Fatalf("incomplete outcomes: %+v", parsed)
	}
	errorItem := parsed.Observation.Items[7]
	if errorItem.Error == nil || errorItem.LastFailure == nil || errorItem.Error.OccurredAt.Location() != time.UTC || errorItem.Error.OccurredAt.Hour() != 10 || errorItem.NextAttemptAt == nil || errorItem.NextAttemptAt.Location() != time.UTC || errorItem.Key.ProjectID != configurationInputProjectA || string(errorItem.AppliedValue) != "null" {
		t.Fatalf("error outcome not normalized: %+v", errorItem)
	}
	for _, state := range []string{"pending", "applying", "applied"} {
		item := configurationInputItem("maxConcurrent", 4)
		item["state"] = state
		item["lastFailure"] = configurationInputFailure()
		if state != "applied" {
			item["appliedValue"] = nil
		}
		result, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, configurationInputExchange(item)))
		if err != nil || result.Observation.Items[0].LastFailure == nil {
			t.Fatalf("state %s cannot preserve unreported failure: %+v %v", state, result, err)
		}
	}
	for _, raw := range []string{`{"bootstrap":null,"observation":null}`, `{"bootstrap":null,"observation":{"baseRevision":"0","desiredRevision":"1","items":[]}}`} {
		parsed, err := ParseWorkerConfigurationExchange(json.RawMessage(raw))
		if err != nil || parsed == nil {
			t.Fatalf("empty exchange: %+v %v", parsed, err)
		}
	}
}

func TestWorkerConfigurationPreferenceApplicationAcceptsBothBooleanValues(t *testing.T) {
	for _, value := range []any{false, true, nil} {
		item := configurationInputItem("preferPlatformSpecificTasks", value)
		if value == nil {
			item["state"] = "pending"
		}
		parsed, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, configurationInputExchange(item)))
		if err != nil || !reflect.DeepEqual(parsed.Observation.Items[0].AppliedValue, configurationInputJSON(t, value)) {
			t.Fatalf("preference application %v was not preserved: %+v %v", value, parsed, err)
		}
	}
	for _, value := range []any{1, "false", []any{}, map[string]any{}} {
		_, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, configurationInputExchange(configurationInputItem("preferPlatformSpecificTasks", value))))
		requireFault(t, err, "invalid_input")
	}
}

func TestWorkerConfigurationInputRejectsInvalidExchange(t *testing.T) {
	cases := map[string]func(map[string]any){
		"missing bootstrap":        func(v map[string]any) { delete(v, "bootstrap") },
		"missing observation":      func(v map[string]any) { delete(v, "observation") },
		"unknown field":            func(v map[string]any) { v["reportedAt"] = "2026-11-04T00:00:00Z" },
		"bad bootstrap":            func(v map[string]any) { v["bootstrap"] = map[string]any{} },
		"bad observation":          func(v map[string]any) { v["observation"] = "bad" },
		"missing desired":          func(v map[string]any) { delete(v["observation"].(map[string]any), "desiredRevision") },
		"reported timestamp input": func(v map[string]any) { v["observation"].(map[string]any)["reportedAt"] = "2026-11-04T00:00:00Z" },
		"base number":              func(v map[string]any) { v["observation"].(map[string]any)["baseRevision"] = 1 },
		"base leading zero":        func(v map[string]any) { v["observation"].(map[string]any)["baseRevision"] = "01" },
		"desired zero":             func(v map[string]any) { v["observation"].(map[string]any)["desiredRevision"] = "0" },
		"items null":               func(v map[string]any) { v["observation"].(map[string]any)["items"] = nil },
		"items not array":          func(v map[string]any) { v["observation"].(map[string]any)["items"] = map[string]any{} },
		"item scalar":              func(v map[string]any) { v["observation"].(map[string]any)["items"] = []any{"bad"} },
		"duplicate item": func(v map[string]any) {
			observation := v["observation"].(map[string]any)
			items := observation["items"].([]any)
			observation["items"] = append(items, items[0])
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			document := configurationInputExchange(configurationInputItem("maxConcurrent", 1))
			change(document)
			_, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, document))
			requireFault(t, err, "invalid_input")
		})
	}
	itemCases := map[string]func(map[string]any){
		"missing key":             func(v map[string]any) { delete(v, "key") },
		"unknown key":             func(v map[string]any) { v["key"].(map[string]any)["taskId"] = configurationInputProjectA },
		"bad key":                 func(v map[string]any) { v["key"] = "maxConcurrent" },
		"unknown kind":            func(v map[string]any) { v["key"].(map[string]any)["kind"] = "task" },
		"missing kind":            func(v map[string]any) { delete(v["key"].(map[string]any), "kind") },
		"null kind":               func(v map[string]any) { v["key"].(map[string]any)["kind"] = nil },
		"project kind missing id": func(v map[string]any) { v["key"].(map[string]any)["kind"] = "projectRemoval" },
		"project bad id": func(v map[string]any) {
			v["key"] = map[string]any{"kind": "projectPreparation", "projectId": "invalid"}
		},
		"global project id": func(v map[string]any) { v["key"].(map[string]any)["projectId"] = configurationInputProjectA },
		"missing target":    func(v map[string]any) { delete(v, "targetRevision") },
		"target zero":       func(v map[string]any) { v["targetRevision"] = "0" },
		"target newer":      func(v map[string]any) { v["targetRevision"] = "4" },
		"missing value":     func(v map[string]any) { delete(v, "appliedValue") },
		"applied null":      func(v map[string]any) { v["appliedValue"] = nil },
		"scalar zero":       func(v map[string]any) { v["appliedValue"] = 0 },
		"scalar unsafe":     func(v map[string]any) { v["appliedValue"] = int64(9007199254740992) },
		"poll over timer": func(v map[string]any) {
			v["key"].(map[string]any)["kind"] = "pollIntervalMs"
			v["appliedValue"] = int64(2147483648)
		},
		"recovery negative": func(v map[string]any) { v["key"].(map[string]any)["kind"] = "recoveryLimit"; v["appliedValue"] = -1 },
		"native missing tuple": func(v map[string]any) {
			v["key"].(map[string]any)["kind"] = "native"
			v["appliedValue"] = map[string]any{"agent": "codex"}
		},
		"project false": func(v map[string]any) {
			v["key"] = map[string]any{"kind": "projectRemoval", "projectId": configurationInputProjectA}
			v["appliedValue"] = false
		},
		"project value number": func(v map[string]any) {
			v["key"] = map[string]any{"kind": "projectPreparation", "projectId": configurationInputProjectA}
			v["appliedValue"] = 1
		},
		"missing state":             func(v map[string]any) { delete(v, "state") },
		"invalid state":             func(v map[string]any) { v["state"] = "ready" },
		"missing error":             func(v map[string]any) { delete(v, "error") },
		"error state without error": func(v map[string]any) { v["state"] = "error" },
		"applied state with error":  func(v map[string]any) { v["error"] = configurationInputFailure() },
		"missing failure":           func(v map[string]any) { delete(v, "lastFailure") },
		"bad failure":               func(v map[string]any) { v["lastFailure"] = "output" },
		"missing retry":             func(v map[string]any) { delete(v, "nextAttemptAt") },
		"retry invalid time":        func(v map[string]any) { v["nextAttemptAt"] = "tomorrow" },
		"retry without error":       func(v map[string]any) { v["nextAttemptAt"] = "2026-11-04T00:00:00Z" },
		"retry zero time": func(v map[string]any) {
			v["state"] = "error"
			v["error"] = configurationInputFailure()
			v["nextAttemptAt"] = "0001-01-01T00:00:00Z"
		},
		"unknown item attribute": func(v map[string]any) { v["output"] = "private" },
	}
	for name, change := range itemCases {
		t.Run(name, func(t *testing.T) {
			item := configurationInputItem("maxConcurrent", 1)
			change(item)
			_, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, configurationInputExchange(item)))
			requireFault(t, err, "invalid_input")
		})
	}
	for _, raw := range []string{`null`, `[]`, `{`, `{"bootstrap":null,"bootstrap":null,"observation":null}`, `{"bootstrap":null,"observation":{"baseRevision":"0","desiredRevision":"1","items":[],"items":[]}}`} {
		_, err := ParseWorkerConfigurationExchange(json.RawMessage(raw))
		requireFault(t, err, "invalid_input")
	}
}

func TestWorkerConfigurationFailureInputTaxonomy(t *testing.T) {
	for _, code := range []string{"not_found", "permission_denied", "timeout", "command_failed", "invalid_output", "invalid_configuration", "io_error", "unavailable"} {
		for _, category := range []string{"validation", "repository", "agent", "runtime", "storage"} {
			for _, phase := range []string{"validate", "prepare", "apply", "stop", "persist"} {
				document := configurationInputFailure()
				document["code"] = code
				document["category"] = category
				document["phase"] = phase
				value, err := configurationFailure(configurationInputJSON(t, document))
				if err != nil || value == nil || value.Code != code || value.Category != category || value.Phase != phase {
					t.Fatalf("allowed diagnostic rejected: %+v %v", value, err)
				}
			}
		}
	}
	for name, change := range map[string]func(map[string]any){
		"missing code":     func(v map[string]any) { delete(v, "code") },
		"unknown code":     func(v map[string]any) { v["code"] = "raw command stderr" },
		"unknown category": func(v map[string]any) { v["category"] = "other" },
		"unknown phase":    func(v map[string]any) { v["phase"] = "execute" },
		"missing time":     func(v map[string]any) { delete(v, "occurredAt") },
		"null time":        func(v map[string]any) { v["occurredAt"] = nil },
		"invalid time":     func(v map[string]any) { v["occurredAt"] = "yesterday" },
		"zero time":        func(v map[string]any) { v["occurredAt"] = "0001-01-01T00:00:00Z" },
		"unknown output":   func(v map[string]any) { v["message"] = "private" },
	} {
		t.Run(name, func(t *testing.T) {
			document := configurationInputFailure()
			change(document)
			_, err := configurationFailure(configurationInputJSON(t, document))
			requireFault(t, err, "invalid_input")
		})
	}
	value, err := configurationFailure(json.RawMessage("null"))
	if err != nil || value != nil {
		t.Fatalf("null failure: %+v %v", value, err)
	}
}

func TestWorkerConfigurationInputUnicodeBoundaries(t *testing.T) {
	configuration := string(configurationInputJSON(t, configurationInputDocument()))
	observation := string(configurationInputJSON(t, configurationInputExchange(configurationInputItem("native", map[string]any{"agent": "codex", "model": nil, "args": []any{}}))))
	for _, model := range []string{`"\ud800"`, `"\udfff"`, `"\ud800\u0041"`, `"\ud83d\\ude00"`, `"` + string([]byte{0xff}) + `"`} {
		raw := strings.Replace(configuration, `"model":null`, `"model":`+model, 1)
		_, err := ParseWorkerConfiguration(json.RawMessage(raw))
		requireFault(t, err, "invalid_input")
		_, err = ParseWorkerConfigurationExchange(json.RawMessage(`{"bootstrap":` + raw + `,"observation":null}`))
		requireFault(t, err, "invalid_input")
		raw = strings.Replace(observation, `"model":null`, `"model":`+model, 1)
		_, err = ParseWorkerConfigurationExchange(json.RawMessage(raw))
		requireFault(t, err, "invalid_input")
	}
	for _, test := range []struct{ raw, want string }{{`"\ud83d\ude00"`, "😀"}, {`"�"`, "�"}, {`"\ufffd"`, "�"}, {`"\\ud800"`, `\ud800`}} {
		raw := strings.Replace(configuration, `"model":null`, `"model":`+test.raw, 1)
		parsed, err := ParseWorkerConfiguration(json.RawMessage(raw))
		if err != nil || parsed.Native.Model == nil || *parsed.Native.Model != test.want {
			t.Fatalf("valid Unicode model %s: %+v %v", test.raw, parsed, err)
		}
		raw = strings.Replace(observation, `"model":null`, `"model":`+test.raw, 1)
		parsedExchange, err := ParseWorkerConfigurationExchange(json.RawMessage(raw))
		if err != nil || parsedExchange.Observation == nil || len(parsedExchange.Observation.Items) != 1 {
			t.Fatalf("valid Unicode observation %s: %+v %v", test.raw, parsedExchange, err)
		}
	}
}

func configurationCapacityValue() model.WorkerConfiguration {
	return model.WorkerConfiguration{MaxConcurrent: 3, PollIntervalMs: 60000, RecoveryLimit: 0,
		Native:   model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}},
		Projects: []model.WorkerProjectConfiguration{}}
}

func configurationCapacityDocument() map[string]any {
	return map[string]any{
		"maxConcurrent": 3, "pollIntervalMs": 60000, "recoveryLimit": 0, "preferPlatformSpecificTasks": false,
		"native": map[string]any{"agent": "codex", "model": nil, "args": []any{}}, "projects": []any{},
	}
}

func configurationCapacityText(size int) string {
	return strings.Repeat("界", size/3) + strings.Repeat("x", size%3)
}

func configurationCapacityProjectID(index int) string {
	return fmt.Sprintf("%08x-0000-4000-8000-000000000001", index+1)
}

type configurationCapacityCase struct {
	name           string
	valid, invalid any
	setDocument    func(map[string]any, any)
	setValue       func(*model.WorkerConfiguration)
	changed        bool
}

func configurationCapacityCases() []configurationCapacityCase {
	args := make([]any, 129)
	for i := range args {
		args[i] = "x"
	}
	projects := make([]any, 129)
	for i := range projects {
		projects[i] = map[string]any{"projectId": configurationCapacityProjectID(i), "nativeOverrides": map[string]any{}}
	}
	return []configurationCapacityCase{
		{"maxConcurrent", 64, 65,
			func(v map[string]any, x any) { v["maxConcurrent"] = x },
			func(v *model.WorkerConfiguration) { v.MaxConcurrent = 64 }, true},
		{"pollIntervalMs", 60000, 60001,
			func(v map[string]any, x any) { v["pollIntervalMs"] = x },
			func(v *model.WorkerConfiguration) { v.PollIntervalMs = 60000 }, false},
		{"recoveryLimit", 10, 11,
			func(v map[string]any, x any) { v["recoveryLimit"] = x },
			func(v *model.WorkerConfiguration) { v.RecoveryLimit = 10 }, true},
		{"native.model", configurationCapacityText(256), configurationCapacityText(256) + "x",
			func(v map[string]any, x any) { v["native"].(map[string]any)["model"] = x },
			func(v *model.WorkerConfiguration) { text := configurationCapacityText(256); v.Native.Model = &text }, true},
		{"native.arg", []any{configurationCapacityText(4096)}, []any{configurationCapacityText(4096) + "x"},
			func(v map[string]any, x any) { v["native"].(map[string]any)["args"] = x },
			func(v *model.WorkerConfiguration) { v.Native.Args = []string{configurationCapacityText(4096)} }, true},
		{"native.args", args[:128], args,
			func(v map[string]any, x any) { v["native"].(map[string]any)["args"] = x },
			func(v *model.WorkerConfiguration) {
				v.Native.Args = make([]string, 128)
				for i := range v.Native.Args {
					v.Native.Args[i] = "x"
				}
			}, true},
		{"desired.projects", projects[:128], projects,
			func(v map[string]any, x any) { v["projects"] = x },
			func(v *model.WorkerConfiguration) {
				v.Projects = make([]model.WorkerProjectConfiguration, 128)
				for i := range v.Projects {
					v.Projects[i] = model.WorkerProjectConfiguration{ProjectID: configurationCapacityProjectID(i), NativeOverrides: map[string]json.RawMessage{}}
				}
			}, false},
	}
}

func configurationCapacityObservationProjectID(index int) string {
	// Adjacent IDs are swapped so unintended sorting changes this reproducible input.
	return configurationCapacityProjectID(index ^ 1)
}

func configurationCapacityObservationDocument(count int, base string) map[string]any {
	items := make([]any, count)
	for i := range items {
		items[i] = map[string]any{
			"key":            map[string]any{"kind": "projectPreparation", "projectId": configurationCapacityObservationProjectID(i)},
			"targetRevision": "1", "appliedValue": nil, "state": "pending", "error": nil, "lastFailure": nil, "nextAttemptAt": nil,
		}
	}
	return map[string]any{"baseRevision": base, "desiredRevision": "1", "items": items}
}

func configurationCapacityObservation(count int, base string) model.WorkerConfigurationObservation {
	items := make([]model.WorkerConfigurationItem, count)
	for i := range items {
		items[i] = model.WorkerConfigurationItem{
			Key:            model.WorkerConfigurationItemKey{Kind: "projectPreparation", ProjectID: configurationCapacityObservationProjectID(i)},
			TargetRevision: "1", AppliedValue: json.RawMessage("null"), State: "pending",
		}
	}
	return model.WorkerConfigurationObservation{BaseRevision: base, DesiredRevision: "1", Items: items}
}

func TestWorkerConfigurationCapacityInput(t *testing.T) {
	for _, tc := range configurationCapacityCases() {
		t.Run(tc.name, func(t *testing.T) {
			document := configurationCapacityDocument()
			tc.setDocument(document, tc.valid)
			got, err := ParseWorkerConfiguration(configurationInputJSON(t, document))
			want := configurationCapacityValue()
			tc.setValue(&want)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("normal capacity input differs: got %+v, want %+v: %v", got, want, err)
			}
			document = configurationCapacityDocument()
			tc.setDocument(document, tc.invalid)
			_, err = ParseWorkerConfiguration(configurationInputJSON(t, document))
			requireFault(t, err, "invalid_input")
		})
	}
	t.Run("observation.items", func(t *testing.T) {
		document := map[string]any{"bootstrap": nil, "observation": configurationCapacityObservationDocument(MaxObservationItems, "0")}
		got, err := ParseWorkerConfigurationExchange(configurationInputJSON(t, document))
		observation := configurationCapacityObservation(MaxObservationItems, "0")
		want := &model.WorkerConfigurationExchange{Observation: &observation}
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("maximum observation differs: got %+v, want %+v: %v", got, want, err)
		}
		document["observation"] = configurationCapacityObservationDocument(MaxObservationItems+1, "1")
		_, err = ParseWorkerConfigurationExchange(configurationInputJSON(t, document))
		requireFault(t, err, "invalid_input")
	})
}
