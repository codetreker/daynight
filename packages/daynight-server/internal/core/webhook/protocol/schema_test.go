package protocol

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func TestMachineSchema(t *testing.T) {
	raw, err := os.ReadFile("event.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schemaDoc any
	if err = json.Unmarshal(raw, &schemaDoc); err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if err = compiler.AddResource("urn:daynight:webhook:event:v1", schemaDoc); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile("urn:daynight:webhook:event:v1")
	if err != nil {
		t.Fatal(err)
	}
	now := sampleTime()
	one, two := int64(1), int64(2)
	tests := []Fact{
		func() Fact { f := fact(Created); f.Status = "todo"; return f }(),
		func() Fact { f := fact(StatusChanged); f.PreviousStatus = "todo"; f.Status = "done"; return f }(),
		func() Fact { f := fact(Paused); f.Paused = true; return f }(),
		func() Fact { f := fact(Deleted); f.DeletedAt = &now; return f }(),
		func() Fact { f := fact(StepUpdated); f.StepID = "00000001"; f.Action = "created"; return f }(),
		func() Fact {
			f := fact(StepUpdated)
			f.StepID = "00000001"
			f.Action = "moved"
			f.FromPosition, f.ToPosition = &one, &two
			return f
		}(),
		func() Fact {
			f := fact(StepUpdated)
			f.StepID = "00000001"
			f.Action = "status_changed"
			f.PreviousStatus, f.Status = "todo", "done"
			f.ChangedFields = []string{"title"}
			return f
		}(),
		func() Fact {
			f := fact(StepUpdated)
			f.StepID = "00000001"
			f.Action = "updated"
			f.ChangedFields = []string{"description", "title"}
			return f
		}(),
		func() Fact {
			f := fact(ThreadPosted)
			f.TaskVersion = 0
			f.MessageID = messageID
			f.CreatedAt = &now
			return f
		}(),
	}
	for _, f := range tests {
		raw, err := Render(eventID, f)
		if err != nil {
			t.Fatal(err)
		}
		var value any
		if err = json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		if err = schema.Validate(value); err != nil {
			t.Fatalf("%s: %v", f.Type, err)
		}
	}
	statusFact := fact(StatusChanged)
	statusFact.PreviousStatus, statusFact.Status = "todo", "done"
	statusBody, err := Render(eventID, statusFact)
	if err != nil {
		t.Fatal(err)
	}
	stepFact := fact(StepUpdated)
	stepFact.StepID, stepFact.Action, stepFact.PreviousStatus, stepFact.Status = "00000001", "status_changed", "todo", "done"
	stepFact.ChangedFields = []string{"description", "title"}
	stepBody, err := Render(eventID, stepFact)
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{
		strings.Replace(string(statusBody), `"status":"done"`, `"status":"todo"`, 1),
		strings.Replace(string(stepBody), `"status":"done"`, `"status":"todo"`, 1),
		strings.Replace(string(stepBody), `["description","title"]`, `["title","description"]`, 1),
	} {
		var value any
		if err := json.Unmarshal([]byte(invalid), &value); err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(value); err == nil {
			t.Fatalf("schema accepted invalid fact: %s", invalid)
		}
	}

}
