package main

import (
	"encoding/json"
	"reflect"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func acceptanceProperties(t *testing.T, items []api.PullRequestProperty) api.TaskProperties {
	t.Helper()
	value, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	return api.TaskProperties{"pullRequests": value}
}

func acceptancePullRequests(t *testing.T, properties api.TaskProperties) []api.PullRequestProperty {
	t.Helper()
	raw, exists := properties["pullRequests"]
	if !exists {
		return nil
	}
	var result []api.PullRequestProperty
	if json.Unmarshal(raw, &result) != nil || result == nil {
		t.Fatal("invalid present PR property")
	}
	return result
}

func acceptanceWorker(t *testing.T, properties api.TaskProperties) *api.WorkerClaim {
	t.Helper()
	raw, exists := properties["worker"]
	if !exists {
		return nil
	}
	var worker *api.WorkerClaim
	if json.Unmarshal(raw, &worker) != nil || worker == nil {
		t.Fatal("invalid present worker property")
	}
	return worker
}

func acceptanceCLIPropertyResource(t *testing.T, cli *acceptanceCLI, task api.Task) api.PropertyResource {
	t.Helper()
	resource := acceptanceCLIJSON[api.PropertyResource](t, cli.run(t, cli.caller, "task", "properties", task.ID, "--project", task.ProjectID, "--json"))
	if resource.ProjectID != task.ProjectID || resource.TaskID != task.ID || resource.Version != task.Version || resource.Properties == nil || !reflect.DeepEqual(resource.Properties, task.Properties) {
		t.Fatal("installed property resource disagrees with the complete task")
	}
	return resource
}

func acceptanceCLISetPullRequests(t *testing.T, cli *acceptanceCLI, task api.Task, properties api.TaskProperties) api.Task {
	t.Helper()
	value, exists := properties["pullRequests"]
	if !exists {
		t.Fatal("installed PR setup requires an explicit property value")
	}
	cli.run(t, cli.caller, "task", "set-property", task.ID, "pullRequests", string(value), "--project", task.ProjectID, "--if-version", strconv.FormatInt(task.Version, 10))
	after := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", task.ID, "--project", task.ProjectID, "--json"))
	acceptanceCLIPropertyResource(t, cli, after)
	return after
}
