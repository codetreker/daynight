package taskproperty_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func TestStoredValueReadersAndCopies(t *testing.T) {
	worker := workerFixture()
	values := propertyFixture(t, []model.PullRequestProperty{{URL: "u", Title: "t"}}, &worker)
	claim, err := taskproperty.Worker(values)
	if err != nil || claim == nil || claim.ClaimID != worker.ClaimID {
		t.Fatalf("worker read: %#v %v", claim, err)
	}
	if claim, err := taskproperty.Worker(nil); err != nil || claim != nil {
		t.Fatalf("absent worker: %#v %v", claim, err)
	}
	if _, err := taskproperty.Worker(model.TaskProperties{"worker": json.RawMessage(`{"claimId":1}`)}); err == nil {
		t.Fatal("worker decoding error was hidden")
	}
	if requests, err := taskproperty.PullRequests(nil); err != nil || requests != nil {
		t.Fatalf("absent requests: %#v %v", requests, err)
	}
	if _, err := taskproperty.PullRequests(model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":1}]`)}); err == nil {
		t.Fatal("pull request decoding error was hidden")
	}
	copy := taskproperty.Clone(values)
	copy["pullRequests"][0] = 'X'
	if !json.Valid(values["pullRequests"]) {
		t.Fatal("clone shared value bytes")
	}
}

func TestRawValuesAndValidationIdentity(t *testing.T) {
	for _, input := range []string{"true", "false"} {
		value, err := taskproperty.ParseInput("paused", input)
		if err != nil || string(value) != input {
			t.Fatalf("valid paused %q: %s %v", input, value, err)
		}
	}
	for _, tc := range []struct{ name, input string }{{"paused", "null"}, {"paused", "true false"}, {"missing", "true"}} {
		_, err := taskproperty.ParseInput(tc.name, tc.input)
		var invalid *taskproperty.ValidationError
		if !errors.As(err, &invalid) || invalid.Error() == "" {
			t.Fatalf("validation identity: %v", err)
		}
		if tc.name == "paused" && errors.Unwrap(err) == nil {
			t.Fatalf("validation cause: %v", err)
		}
	}
	if raw, err := taskproperty.EncodeWorker(nil); err != nil || string(raw) != "null" {
		t.Fatalf("nil worker encoding: %s %v", raw, err)
	}
}
