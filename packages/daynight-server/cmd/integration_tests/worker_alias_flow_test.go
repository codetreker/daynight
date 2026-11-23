//go:build integration

package main

import (
	"net/http"
	"testing"
)

func serverAPIWorkerAliasFlow(t *testing.T, f *fixture, workerID string) {
	t.Helper()
	base := "/api/v1/me/workers/" + workerID
	type alias struct {
		Value   *string `json:"value"`
		Version string  `json:"version"`
	}
	type resource struct {
		WorkerID string `json:"workerId"`
		Alias    alias  `json:"alias"`
	}
	initial := requestJSON[resource](t, f, http.MethodGet, base+"/alias", nil, http.StatusOK)
	if initial.WorkerID != workerID || initial.Alias.Value != nil || initial.Alias.Version != "1" {
		t.Fatalf("initial alias: %+v", initial)
	}
	saved := requestJSON[resource](t, f, http.MethodPut, base+"/alias", map[string]any{"value": " 开发机 👩‍💻 ", "expectedVersion": initial.Alias.Version}, http.StatusOK)
	if saved.WorkerID != workerID || saved.Alias.Value == nil || *saved.Alias.Value != "开发机 👩‍💻" || saved.Alias.Version != "2" {
		t.Fatalf("saved alias: %+v", saved)
	}
	headers := http.Header{"Daynight-Worker-Alias": {"1"}, "Daynight-Worker-Tool-Paths": {"2"}}
	detail := requestJSON[struct {
		Worker resource `json:"worker"`
	}](t, f, http.MethodGet, base, nil, http.StatusOK, headers)
	if detail.Worker.WorkerID != workerID || detail.Worker.Alias.Value == nil || *detail.Worker.Alias.Value != *saved.Alias.Value || detail.Worker.Alias.Version != saved.Alias.Version {
		t.Fatalf("detail alias: %+v", detail)
	}
	page := requestJSON[struct {
		Items []resource `json:"items"`
	}](t, f, http.MethodGet, "/api/v1/me/workers", nil, http.StatusOK, headers)
	found := false
	for _, worker := range page.Items {
		if worker.WorkerID == workerID {
			found = worker.Alias.Value != nil && *worker.Alias.Value == *saved.Alias.Value && worker.Alias.Version == saved.Alias.Version
		}
	}
	if !found {
		t.Fatalf("list did not contain saved alias: %+v", page)
	}
	cleared := requestJSON[resource](t, f, http.MethodPut, base+"/alias", map[string]any{"value": nil, "expectedVersion": saved.Alias.Version}, http.StatusOK)
	readback := requestJSON[resource](t, f, http.MethodGet, base+"/alias", nil, http.StatusOK)
	if cleared.WorkerID != workerID || readback.WorkerID != workerID || cleared.Alias.Value != nil || readback.Alias.Value != nil || cleared.Alias.Version != "3" || readback.Alias.Version != cleared.Alias.Version {
		t.Fatalf("cleared alias: %+v readback=%+v", cleared, readback)
	}
}
