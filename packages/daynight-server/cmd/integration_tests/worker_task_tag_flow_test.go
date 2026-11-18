//go:build integration

package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func serverAPIWorkerTaskTagAdmissionFlow(t *testing.T, f *fixture) {
	project := createProject(t, f, "Worker tag admission")
	tag := requestJSON[catalogTag](t, f, http.MethodPost, "/api/v1/projects/"+project.ID+"/tags", map[string]any{"name": "Backend"}, http.StatusCreated)
	matching := createTask(t, f, project, "Matching", map[string]any{"status": "todo", "assignedTo": f.userID, "tagIds": []string{tag.ID}})
	unmatched := createTask(t, f, project, "Unmatched", map[string]any{"status": "todo", "assignedTo": f.userID})
	matching = requestJSON[api.Task](t, f, http.MethodPatch, taskPath(matching), map[string]any{"version": matching.Version, "allowAgents": true}, http.StatusOK)
	unmatched = requestJSON[api.Task](t, f, http.MethodPatch, taskPath(unmatched), map[string]any{"version": unmatched.Version, "allowAgents": true}, http.StatusOK)

	workerID, machineID := uuid.NewString(), uuid.NewString()
	base := "/api/v1/me/workers/" + workerID
	headers := http.Header{"Daynight-Worker-Tool-Paths": {"2"}, "Daynight-Worker-Archive-Sessions": {"1"}}
	reportHeaders := headers.Clone()
	reportHeaders.Set("Daynight-Worker-Configuration", "1")
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	probe := func(value any) any { return map[string]any{"state": "ok", "checkedAt": stamp, "value": value} }
	paths := map[string]any{"codex": map[string]any{"kind": "auto"}, "copilot": map[string]any{"kind": "auto"}}
	bootstrap := map[string]any{"maxConcurrent": 1, "pollIntervalMs": 60000, "recoveryLimit": 3, "preferPlatformSpecificTasks": false, "enableSudoCleanup": false, "archiveSessions": true, "native": map[string]any{"agent": "codex", "model": nil, "args": []string{}}, "projects": []any{}, "toolPaths": paths}
	report := map[string]any{
		"machine": map[string]any{"id": machineID, "name": "Tag admission"}, "platform": "linux", "workingDirectory": "/work", "sampledAt": stamp,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions": map[string]any{"daynight": "1.0.0", "codex": probe("1.0.0"), "copilot": probe("1.0.0")}, "taskInventory": nil,
		"toolPaths":     map[string]any{"schemaVersion": 1, "observedAt": stamp, "entries": []any{}},
		"configuration": map[string]any{"bootstrap": bootstrap, "observation": nil, "toolPathsBootstrap": paths},
	}
	requestJSON[json.RawMessage](t, f, http.MethodPost, base+"/report", report, http.StatusOK, reportHeaders)
	type resource struct {
		Desired struct {
			Revision string         `json:"revision"`
			Value    map[string]any `json:"value"`
		} `json:"desired"`
		ObservationRevision string `json:"observationRevision"`
	}
	initial := requestJSON[resource](t, f, http.MethodGet, base+"/configuration", nil, http.StatusOK, headers)
	if initial.Desired.Revision != "1" || initial.ObservationRevision != "0" {
		t.Fatalf("bootstrap result differs: %+v", initial)
	}
	item := map[string]any{"key": map[string]any{"kind": "taskTagFilter"}, "targetRevision": initial.Desired.Revision, "appliedValue": nil, "state": "pending", "error": nil, "lastFailure": nil, "nextAttemptAt": nil}
	report["configuration"] = map[string]any{"bootstrap": nil, "observation": map[string]any{"baseRevision": initial.ObservationRevision, "desiredRevision": initial.Desired.Revision, "items": []any{item}}, "toolPathsBootstrap": nil}
	observation := requestJSON[struct {
		Configuration struct {
			ObservationAccepted bool   `json:"observationAccepted"`
			ObservationRevision string `json:"observationRevision"`
		} `json:"configuration"`
	}](t, f, http.MethodPost, base+"/report", report, http.StatusOK, reportHeaders)
	if !observation.Configuration.ObservationAccepted || observation.Configuration.ObservationRevision != "1" {
		t.Fatalf("support observation was not accepted: %+v", observation)
	}
	initial.Desired.Value["taskTagFilter"] = map[string]any{"names": []string{"backend"}, "match": "any"}
	saved := requestJSON[resource](t, f, http.MethodPut, base+"/configuration", map[string]any{"revision": initial.Desired.Revision, "value": initial.Desired.Value}, http.StatusOK, headers)
	read := requestJSON[resource](t, f, http.MethodGet, base+"/configuration", nil, http.StatusOK, headers)
	filter, ok := read.Desired.Value["taskTagFilter"].(map[string]any)
	names, namesOK := filter["names"].([]any)
	if saved.Desired.Revision != "2" || read.Desired.Revision != saved.Desired.Revision || !ok || filter["match"] != "any" || !namesOK || len(names) != 1 || names[0] != "backend" {
		t.Fatalf("saved target differs: saved=%+v read=%+v", saved, read)
	}

	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(`["any",["backend"]]`)))
	claimHeaders := http.Header{"Daynight-Worker-Protocol": {"2"}}
	claim := func(task api.Task, claimID string) map[string]any {
		return map[string]any{"version": task.Version, "claimId": claimID, "workerId": workerID, "machine": map[string]any{"id": machineID, "name": "Tag admission"}, "platform": "linux", "agent": "codex", "agentControlMode": "web", "worktreeId": uuid.NewString(), "taskTagFilterKey": digest}
	}
	refused := requestJSON[api.ErrorResponse](t, f, http.MethodPost, taskPath(unmatched)+"/worker-claim", claim(unmatched, uuid.NewString()), http.StatusConflict, claimHeaders)
	if refused.Error.Code != "claim_conflict" {
		t.Fatalf("unmatched claim error differs: %+v", refused)
	}
	stillTodo := requestJSON[api.Task](t, f, http.MethodGet, taskPath(unmatched), nil, http.StatusOK, claimHeaders)
	if stillTodo.ID != unmatched.ID || stillTodo.Version != unmatched.Version || stillTodo.Status != "todo" || stillTodo.Properties["worker"] != nil {
		t.Fatalf("refused claim changed task: %+v", stillTodo)
	}
	claimID := uuid.NewString()
	claimed := requestJSON[api.Task](t, f, http.MethodPost, taskPath(matching)+"/worker-claim", claim(matching, claimID), http.StatusOK, claimHeaders)
	readClaim := requestJSON[api.Task](t, f, http.MethodGet, taskPath(matching), nil, http.StatusOK, claimHeaders)
	if claimed.ID != matching.ID || claimed.Status != "in_progress" || workerClaim(t, claimed).ClaimID != claimID || workerClaim(t, claimed).WorkerID != workerID || workerClaim(t, readClaim).ClaimID != claimID || readClaim.Version != claimed.Version {
		t.Fatalf("matching claim differs: receipt=%+v read=%+v", claimed, readClaim)
	}
}
