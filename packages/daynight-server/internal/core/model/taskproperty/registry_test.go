package taskproperty_test

import (
	"bytes"
	"encoding/json"
	"maps"
	"slices"
	"testing"

	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func testPropertyNames() []string { return slices.Sorted(maps.Keys(taskproperty.Definitions())) }

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
		"state": {"active", "completed"}, "platform": {"windows", "linux", "macos"}, "agent": {"codex", "copilot", "claude"},
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
