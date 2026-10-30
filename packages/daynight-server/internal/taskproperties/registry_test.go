package taskproperties

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestDefinitionsExposeValueContractsWithoutSharingRegistryStorage(t *testing.T) {
	catalog := Definitions()
	if len(catalog) != 2 || catalog["pullRequests"].ReadOnly || !catalog["worker"].ReadOnly {
		t.Fatalf("unexpected definitions: %#v", catalog)
	}
	if got := propertyNames(); !slices.Equal(got, []string{"pullRequests", "worker"}) {
		t.Fatalf("property order: %v", got)
	}
	encoded, err := json.Marshal(catalog)
	if err != nil || bytes.Contains(encoded, []byte(`"Normalize"`)) || bytes.Contains(encoded, []byte(`"Name"`)) || bytes.Contains(encoded, []byte(`"default"`)) {
		t.Fatalf("definition metadata serialized internal/default fields: %s (%v)", encoded, err)
	}
	catalog["worker"].Schema[0] = 'X'
	delete(catalog, "pullRequests")
	if fresh := Definitions(); len(fresh) != 2 || !json.Valid(fresh["worker"].Schema) {
		t.Fatal("caller mutated registry definitions")
	}
	for _, name := range propertyNames() {
		definition := Definitions()[name]
		if definition.Name != name || definition.Description == "" || definition.Normalize == nil {
			t.Fatalf("incomplete definition %s", name)
		}
	}
}

func TestSchemaMatchesKnownValueStructures(t *testing.T) {
	catalog := Definitions()
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
	input := core.TaskProperties{"pullRequests": json.RawMessage(`[ { "title":"a", "url":"b" } ]`)}
	before := bytes.Clone(input["pullRequests"])
	actual, err := Normalize(input, true)
	if err != nil || string(actual["pullRequests"]) != `[{"url":"b","title":"a"}]` || !bytes.Equal(input["pullRequests"], before) {
		t.Fatalf("normalization changed source or failed canonicalization: %s (%v)", actual, err)
	}
	copy := Clone(actual)
	copy["pullRequests"][0] = 'X'
	copy["added"] = json.RawMessage(`true`)
	if !json.Valid(actual["pullRequests"]) || len(actual) != 1 || Equal(copy, actual) {
		t.Fatal("Clone shared map or raw bytes")
	}
	if !Equal(actual, Clone(actual)) || Equal(actual, core.TaskProperties{}) || !Equal(nil, core.TaskProperties{}) {
		t.Fatal("normalized map equality changed property presence")
	}
	for _, empty := range []core.TaskProperties{nil, {}} {
		value, err := Normalize(empty, false)
		if err != nil || value == nil || len(value) != 0 {
			t.Fatalf("empty map gained properties: %#v %v", value, err)
		}
		if worker, err := Worker(empty); err != nil || worker != nil {
			t.Fatalf("absent worker changed: %#v %v", worker, err)
		}
		if requests, err := PullRequests(empty); err != nil || requests != nil {
			t.Fatalf("absent PR property changed: %#v %v", requests, err)
		}
	}
	worker := workerFixture()
	withWorker, err := WithWorker(actual, &worker)
	if err != nil || workerValue(t, withWorker).ClaimID != worker.ClaimID || len(actual) != 1 {
		t.Fatalf("adding worker changed original map: %#v %v", withWorker, err)
	}
	removed, err := WithWorker(withWorker, nil)
	if err != nil || !Equal(removed, actual) || workerValue(t, withWorker) == nil {
		t.Fatalf("removing worker changed original map: %#v %v", removed, err)
	}
	for _, properties := range []core.TaskProperties{{"worker": json.RawMessage(`null`)}, {"pullRequests": json.RawMessage(`null`)}} {
		_, err := Normalize(properties, false)
		var invalidValue *ValidationError
		if !errors.As(err, &invalidValue) {
			t.Fatalf("invalid stored property lost typed error: %v", err)
		}
	}
	if _, err := Worker(core.TaskProperties{"worker": json.RawMessage(`null`)}); err == nil {
		t.Fatal("worker accessor accepted illegal present value")
	}
	if _, err := PullRequests(core.TaskProperties{"pullRequests": json.RawMessage(`null`)}); err == nil {
		t.Fatal("PR accessor accepted illegal present value")
	}
	worker.AgentControlMode = ""
	if _, err := WithWorker(actual, &worker); err == nil {
		t.Fatal("worker write omitted required mode")
	}
}

func TestRegistryEnforcesPublicWritesAndSanitizesValidationErrors(t *testing.T) {
	if err := CheckWritable("pullRequests"); err != nil {
		t.Fatal(err)
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
		_, err := NormalizeValue(test.name, json.RawMessage(test.raw), test.public)
		var invalidValue *ValidationError
		if !errors.As(err, &invalidValue) || invalidValue.Path == "" || invalidValue.Rule == "" || strings.Contains(err.Error(), "private-") {
			t.Fatalf("validation error exposed input or lost metadata: %#v (%v)", invalidValue, err)
		}
		if test.name == "pullRequests" && errors.Unwrap(err) == nil {
			t.Fatalf("value error lost its cause: %v", err)
		}
	}
	if _, err := Normalize(propertyFixture(t, nil, ptrWorker(workerFixture())), true); err == nil {
		t.Fatal("public map accepted worker")
	}
}

func ptrWorker(value core.WorkerClaim) *core.WorkerClaim { return &value }

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
	for _, raw := range []string{`{"n":9223372036854775807,"nested":[null,true,false,17.5,"text",{}]}`, `-17`, `[]`, `{}`} {
		if err := strictValue([]byte(raw)); err != nil {
			t.Fatalf("valid JSON value rejected: %s (%v)", raw, err)
		}
	}
	for _, raw := range []string{"", `}`, `]`, `{`, `[`, `{1:2}`, `{"x":}`, `{"x":1`, `{"x":1]`, `[1}`, `[1,]`, `{"x":{"y":1,"y":2}}`, `1 2`} {
		if err := strictValue([]byte(raw)); err == nil {
			t.Fatalf("invalid JSON value accepted: %s", raw)
		}
	}
}

func TestStringDefinitionsAcceptRawTextAndJSONStringWithoutNewProductProperty(t *testing.T) {
	valueDefinition := Definition{Name: "testText", kind: "string", Normalize: func(raw json.RawMessage) (json.RawMessage, error) {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		return json.Marshal(value)
	}}
	for _, test := range []struct{ input, want string }{
		{"", ""}, {"abc", "abc"}, {"123", "123"}, {"true", "true"}, {"null", "null"}, {`[1]`, `[1]`},
		{`"123"`, "123"}, {`"line\n中文"`, "line\n中文"}, {`"unterminated`, `"unterminated`},
	} {
		actual, err := parseDefinitionInput(valueDefinition, test.input)
		var got string
		if err != nil || json.Unmarshal(actual, &got) != nil || got != test.want {
			t.Fatalf("string input %q: got %q (%v), want %q", test.input, actual, err, test.want)
		}
	}
	if !reflect.DeepEqual(propertyNames(), []string{"pullRequests", "worker"}) {
		t.Fatal("string shorthand test registered a product property")
	}
}
