package server

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func rawProperty(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func apiWorker(t *testing.T, properties api.TaskProperties) *api.WorkerClaim {
	t.Helper()
	raw, exists := properties["worker"]
	if !exists {
		return nil
	}
	var value *api.WorkerClaim
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		t.Fatalf("invalid worker property: %s: %v", raw, err)
	}
	return value
}

func apiPullRequests(t *testing.T, properties api.TaskProperties) []api.PullRequestProperty {
	t.Helper()
	raw, exists := properties["pullRequests"]
	if !exists {
		return nil
	}
	var value []api.PullRequestProperty
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		t.Fatalf("invalid pullRequests property: %s: %v", raw, err)
	}
	return value
}
