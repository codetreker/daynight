package task_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	taskprops "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
)

func pointer[T any](value T) *T { return &value }

func requireFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code || fault.Message == "" || err.Error() != fault.Message {
		t.Fatalf("expected %s fault, got %#v", code, err)
	}
	return fault
}

type entropyFailure struct{ err error }

func (failure entropyFailure) Read([]byte) (int, error) { return 0, failure.err }

func propertyPatch(items ...model.PullRequestProperty) model.TaskPropertiesPatch {
	values := make([]map[string]string, len(items))
	for index, item := range items {
		values[index] = map[string]string{"url": item.URL, "title": item.Title}
	}
	return model.TaskPropertiesPatch{"pullRequests": propertyJSON(values)}
}

func propertyJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

func testWorker(t *testing.T, properties model.TaskProperties) *model.WorkerClaim {
	t.Helper()
	value, err := taskproperties.Worker(properties)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func testPRs(t *testing.T, properties model.TaskProperties) []model.PullRequestProperty {
	t.Helper()
	value, err := taskproperties.PullRequests(properties)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func testWithWorker(t *testing.T, properties model.TaskProperties, worker *model.WorkerClaim) model.TaskProperties {
	t.Helper()
	values, err := taskprops.WithWorker(properties, worker)
	if err != nil {
		t.Fatal(err)
	}
	return values
}
