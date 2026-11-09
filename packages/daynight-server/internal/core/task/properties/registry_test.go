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
			t.Fatalf("invalid property input lost typed error: %v", err)
		}
	}
	var decode *json.UnmarshalTypeError
	if _, err := taskproperty.Worker(model.TaskProperties{"worker": json.RawMessage(`{"claimId":1}`)}); !errors.As(err, &decode) {
		t.Fatalf("worker accessor lost typed decode error: %v", err)
	}
	if _, err := taskproperty.PullRequests(model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":1}]`)}); !errors.As(err, &decode) {
		t.Fatalf("PR accessor lost typed decode error: %v", err)
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
