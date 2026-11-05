package properties

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func TestDefinitionsExposeValueContractsWithoutSharingRegistryStorage(t *testing.T) {
	catalog := taskproperty.Definitions()
	if len(catalog) != 4 || catalog["paused"].ReadOnly || catalog["pullRequests"].ReadOnly || !catalog["worker"].ReadOnly {
		t.Fatalf("unexpected definitions: %#v", catalog)
	}
	if got := testPropertyNames(); !slices.Equal(got, []string{"paused", "pullRequests", "sessionStartup", "worker"}) {
		t.Fatalf("property order: %v", got)
	}
	encoded, err := json.Marshal(catalog)
	if err != nil || bytes.Contains(encoded, []byte(`"Normalize"`)) || bytes.Contains(encoded, []byte(`"Name"`)) || bytes.Contains(encoded, []byte(`"default"`)) {
		t.Fatalf("definition metadata serialized internal/default fields: %s (%v)", encoded, err)
	}
	catalog["worker"].Schema[0] = 'X'
	delete(catalog, "pullRequests")
	if fresh := taskproperty.Definitions(); len(fresh) != 4 || !json.Valid(fresh["worker"].Schema) {
		t.Fatal("caller mutated registry definitions")
	}
	for _, name := range testPropertyNames() {
		definition := taskproperty.Definitions()[name]
		if definition.Name != name || definition.Description == "" || definition.Normalize == nil {
			t.Fatalf("incomplete definition %s", name)
		}
	}
}

func TestSchemaMatchesKnownValueStructures(t *testing.T) {
	catalog := taskproperty.Definitions()
	if string(catalog["paused"].Schema) != `{"type":"boolean"}` {
		t.Fatalf("paused schema and input kind diverged: %#v", catalog["paused"])
	}
	var pr struct {
		Type  string `json:"type"`
		Items struct {
			Type                 string                     `json:"type"`
			Required             []string                   `json:"required"`
			AdditionalProperties bool                       `json:"additionalProperties"`
			Properties           map[string]json.RawMessage `json:"properties"`
		} `json:"items"`
	}
	if err := json.Unmarshal(catalog["pullRequests"].Schema, &pr); err != nil {
		t.Fatal(err)
	}
	if pr.Type != "array" || pr.Items.Type != "object" || pr.Items.AdditionalProperties || !slices.Equal(pr.Items.Required, []string{"url", "title"}) || len(pr.Items.Properties) != 2 {
		t.Fatalf("PR schema and native object contract diverged: %#v", pr)
	}
	for _, raw := range pr.Items.Properties {
		if string(raw) != `{"type":"string"}` {
			t.Fatalf("PR strings acquired extra constraints: %s", raw)
		}
	}
	var worker struct {
		Type                 string                     `json:"type"`
		Required             []string                   `json:"required"`
		AdditionalProperties bool                       `json:"additionalProperties"`
		Properties           map[string]json.RawMessage `json:"properties"`
		AllOf                []json.RawMessage          `json:"allOf"`
	}
	if err := json.Unmarshal(catalog["worker"].Schema, &worker); err != nil {
		t.Fatal(err)
	}
	fixture := workerJSON(t)
	if worker.Type != "object" || worker.AdditionalProperties || len(worker.Required) != len(fixture) || len(worker.Properties) != len(fixture) || len(worker.AllOf) != 1 {
		t.Fatalf("worker schema and native object contract diverged: %#v", worker)
	}
	for name := range fixture {
		if !slices.Contains(worker.Required, name) || worker.Properties[name] == nil {
			t.Fatalf("schema omitted required worker.%s", name)
		}
	}
	for name, expected := range map[string][]string{
		"state": {"active", "released", "completed"}, "platform": {"windows", "linux", "macos"}, "agent": {"codex", "copilot", "claude"},
		"agentControlMode": {"herdr", "web"}, "phase": {"preparing", "executing", "verifying", "completing", "waiting", "paused"},
	} {
		var value struct {
			Type string   `json:"type"`
			Enum []string `json:"enum"`
		}
		if err := json.Unmarshal(worker.Properties[name], &value); err != nil || value.Type != "string" || !slices.Equal(value.Enum, expected) {
			t.Fatalf("worker.%s enum diverged: %#v (%v)", name, value, err)
		}
	}
	for _, name := range []string{"herdr", "nativeSessionId"} {
		var value struct {
			AnyOf []json.RawMessage `json:"anyOf"`
		}
		if err := json.Unmarshal(worker.Properties[name], &value); err != nil || len(value.AnyOf) != 2 || string(value.AnyOf[1]) != `{"type":"null"}` {
			t.Fatalf("worker.%s lost nullable inner value: %s (%v)", name, worker.Properties[name], err)
		}
	}
}

func TestRegistryNormalizationAndCopiesPreservePresenceAndIsolation(t *testing.T) {
	input := model.TaskProperties{"pullRequests": json.RawMessage(`[ { "title":"a", "url":"b" } ]`)}
	before := bytes.Clone(input["pullRequests"])
	actual, err := Normalize(input)
	if err != nil || string(actual["pullRequests"]) != `[{"url":"b","title":"a"}]` || !bytes.Equal(input["pullRequests"], before) {
		t.Fatalf("normalization changed source or failed canonicalization: %s (%v)", actual, err)
	}
	copy := taskproperty.Clone(actual)
	copy["pullRequests"][0] = 'X'
	copy["added"] = json.RawMessage(`true`)
	if !json.Valid(actual["pullRequests"]) || len(actual) != 1 || taskproperty.Equal(copy, actual) {
		t.Fatal("Clone shared map or raw bytes")
	}
	if !taskproperty.Equal(actual, taskproperty.Clone(actual)) || taskproperty.Equal(actual, model.TaskProperties{}) || !taskproperty.Equal(nil, model.TaskProperties{}) {
		t.Fatal("normalized map equality changed property presence")
	}
	for _, empty := range []model.TaskProperties{nil, {}} {
		value, err := taskproperty.Normalize(empty)
		if err != nil || value == nil || len(value) != 0 {
			t.Fatalf("empty map gained properties: %#v %v", value, err)
		}
		if worker, err := taskproperty.Worker(empty); err != nil || worker != nil {
			t.Fatalf("absent worker changed: %#v %v", worker, err)
		}
		if requests, err := taskproperty.PullRequests(empty); err != nil || requests != nil {
			t.Fatalf("absent PR property changed: %#v %v", requests, err)
		}
	}
	worker := workerFixture()
	withWorker, err := WithWorker(actual, &worker)
	if err != nil || workerValue(t, withWorker).ClaimID != worker.ClaimID || len(actual) != 1 {
		t.Fatalf("adding worker changed original map: %#v %v", withWorker, err)
	}
	removed, err := WithWorker(withWorker, nil)
	if err != nil || !taskproperty.Equal(removed, actual) || workerValue(t, withWorker) == nil {
		t.Fatalf("removing worker changed original map: %#v %v", removed, err)
	}
	for _, properties := range []model.TaskProperties{{"worker": json.RawMessage(`null`)}, {"pullRequests": json.RawMessage(`null`)}} {
		_, err := taskproperty.Normalize(properties)
		var invalidValue *taskproperty.ValidationError
		if !errors.As(err, &invalidValue) {
			t.Fatalf("invalid stored property lost typed error: %v", err)
		}
	}
	if _, err := taskproperty.Worker(model.TaskProperties{"worker": json.RawMessage(`null`)}); err == nil {
		t.Fatal("worker accessor accepted illegal present value")
	}
	if _, err := taskproperty.PullRequests(model.TaskProperties{"pullRequests": json.RawMessage(`null`)}); err == nil {
		t.Fatal("PR accessor accepted illegal present value")
	}
	worker.AgentControlMode = ""
	if _, err := WithWorker(actual, &worker); err == nil {
		t.Fatal("worker write omitted required mode")
	}
}

func TestRegistryEnforcesPublicWritesAndSanitizesValidationErrors(t *testing.T) {
	for _, name := range []string{"paused", "pullRequests"} {
		if err := CheckWritable(name); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"worker", "private-property-input"} {
		if err := CheckWritable(name); err == nil {
			t.Fatalf("write of %s accepted", name)
		}
	}
	for _, test := range []struct {
		name, raw string
		public    bool
	}{
		{"private-property-input", `[]`, false}, {"worker", `{}`, true}, {"pullRequests", `[{"url":"private-value","title":`, true},
		{"pullRequests", `[{"url":"private-value","title":17}]`, false}, {"pullRequests", `[{"url":"a","title":"b","title":"private-value"}]`, false},
	} {
		_, err := normalizeValueForTest(test.name, json.RawMessage(test.raw), test.public)
		var invalidValue *taskproperty.ValidationError
		if !errors.As(err, &invalidValue) || invalidValue.Path == "" || invalidValue.Rule == "" || strings.Contains(err.Error(), "private-") {
			t.Fatalf("validation error exposed input or lost metadata: %#v (%v)", invalidValue, err)
		}
		if test.name == "pullRequests" && errors.Unwrap(err) == nil {
			t.Fatalf("value error lost its cause: %v", err)
		}
	}
	if _, err := Normalize(propertyFixture(t, nil, ptrWorker(workerFixture()))); err == nil {
		t.Fatal("public map accepted worker")
	}
}

func ptrWorker(value model.WorkerClaim) *model.WorkerClaim { return &value }

func TestRawInputPreservesNativeMeaningAndRejectsDuplicateOrTrailingJSON(t *testing.T) {
	value, err := ParseInput("pullRequests", `[ { "title":"", "url":"raw\u0000" } ]`)
	if err != nil || string(value) != `[{"url":"raw\u0000","title":""}]` {
		t.Fatalf("raw PR text changed: %s %v", value, err)
	}
	for _, input := range []string{"", "abc", "123", "null", `[] []`, `[`, `{"a":1,"a":2}`, `[{"url":"a","title":"b","title":"c"}]`} {
		if _, err := ParseInput("pullRequests", input); err == nil {
			t.Fatalf("invalid PR raw input accepted: %s", input)
		}
	}
	for _, name := range []string{"worker", "unknown"} {
		if _, err := ParseInput(name, `{}`); err == nil {
			t.Fatalf("unwritable property %s accepted", name)
		}
	}

}

func TestPausedBooleanInputPreservesPresenceAndRejectsOtherValues(t *testing.T) {
	for _, value := range []string{"true", "false"} {
		for _, input := range []string{value, " \n" + value + "\t "} {
			parsed, err := ParseInput("paused", input)
			if err != nil || string(parsed) != value {
				t.Fatalf("boolean input %q: %s (%v)", input, parsed, err)
			}
			normalized, err := Normalize(model.TaskProperties{"paused": json.RawMessage(input)})
			if err != nil || len(normalized) != 1 || string(normalized["paused"]) != value || taskproperty.Equal(normalized, model.TaskProperties{}) {
				t.Fatalf("boolean normalization lost presence: %#v (%v)", normalized, err)
			}
		}
	}
	for _, input := range []string{"", "null", `"true"`, `"false"`, "0", "1", "[]", "{}", "[true]", `{"paused":true}`, "true false", "false null", "TRUE"} {
		for _, parse := range []func() error{
			func() error { _, err := ParseInput("paused", input); return err },
			func() error { _, err := normalizeValueForTest("paused", json.RawMessage(input), true); return err },
		} {
			err := parse()
			var invalidValue *taskproperty.ValidationError
			if !errors.As(err, &invalidValue) || invalidValue.Path != "properties.paused" || errors.Unwrap(err) == nil {
				t.Fatalf("invalid boolean input %q lost validation identity: %v", input, err)
			}
		}
	}
}

func testPropertyNames() []string { return slices.Sorted(maps.Keys(taskproperty.Definitions())) }

func normalizeValueForTest(name string, raw json.RawMessage, public bool) (json.RawMessage, error) {
	if public {
		if err := CheckWritable(name); err != nil {
			return nil, err
		}
	}
	return taskproperty.NormalizeValue(name, raw)
}
