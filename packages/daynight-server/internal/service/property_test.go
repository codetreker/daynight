package service

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

func propertyJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

func propertyPatch(items ...model.PullRequestProperty) model.TaskPropertiesPatch {
	values := make([]map[string]string, len(items))
	for index, item := range items {
		values[index] = map[string]string{"url": item.URL, "title": item.Title}
	}
	return model.TaskPropertiesPatch{"pullRequests": propertyJSON(values)}
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
	values, err := taskproperties.WithWorker(properties, worker)
	if err != nil {
		t.Fatal(err)
	}
	return values
}
