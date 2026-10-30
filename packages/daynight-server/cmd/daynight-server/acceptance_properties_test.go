package main

import (
	"encoding/json"
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
