//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/reviewassignment"

	"github.com/google/uuid"
)

type reviewAssignmentResponse struct {
	Status     string `json:"status"`
	Assignment *struct {
		WorkerID      string    `json:"workerId"`
		AssignedAt    time.Time `json:"assignedAt"`
		Online        *bool     `json:"online"`
		ReviewEnabled *bool     `json:"reviewEnabled"`
	} `json:"assignment"`
}

// Exercise a saved PR and an independently enabled Worker through the real
// background reconciliation loop and public APIs.
func serverAPIReviewAssignmentFlow(t *testing.T, f *fixture, projectID string, retargetSecond func(), retargetFirst, setSecondState func(string), switchRepository func(bool)) {
	t.Helper()
	path := "/api/v1/projects/" + projectID + "/pull-requests/"
	read := func(number string) reviewAssignmentResponse {
		t.Helper()
		response, body := f.request(t, http.MethodGet, path+number+"/review-assignment", "", nil, http.StatusOK)
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("assignment cache policy: %q", response.Header.Get("Cache-Control"))
		}
		var value reviewAssignmentResponse
		if err := json.Unmarshal(body, &value); err != nil {
			t.Fatalf("assignment response: %v", err)
		}
		return value
	}
	waiting := read("1")
	if waiting.Status != "waiting" || waiting.Assignment != nil {
		t.Fatalf("unassigned open PR: %+v", waiting)
	}

	workerID := uuid.NewString()
	workerBase := "/api/v1/me/workers/" + workerID
	headers := http.Header{"Daynight-Worker-Tool-Paths": {"2"}, "Daynight-Worker-Archive-Sessions": {"1"}}
	reportHeaders := headers.Clone()
	reportHeaders.Set("Daynight-Worker-Configuration", "1")
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	probe := func(value any) any { return map[string]any{"state": "ok", "checkedAt": stamp, "value": value} }
	paths := map[string]any{"codex": map[string]any{"kind": "auto"}, "copilot": map[string]any{"kind": "auto"}}
	bootstrap := map[string]any{
		"maxConcurrent": 1, "pollIntervalMs": 60000, "recoveryLimit": 3,
		"preferPlatformSpecificTasks": false, "enableSudoCleanup": false, "archiveSessions": true,
		"native":   map[string]any{"agent": "codex", "model": nil, "args": []string{}},
		"projects": []any{map[string]any{"projectId": projectID, "nativeOverrides": map[string]any{}}}, "toolPaths": paths,
	}
	report := map[string]any{
		"machine":  map[string]any{"id": uuid.NewString(), "name": "Review assignment integration"},
		"platform": "linux", "workingDirectory": "/work", "sampledAt": stamp,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions": map[string]any{"daynight": "1.0.0", "codex": probe("1.0.0"), "copilot": probe("1.0.0")}, "taskInventory": nil,
		"toolPaths":     map[string]any{"schemaVersion": 1, "observedAt": stamp, "entries": []any{}},
		"configuration": map[string]any{"bootstrap": bootstrap, "observation": nil, "toolPathsBootstrap": paths},
	}
	register := func(id string) {
		t.Helper()
		report["machine"] = map[string]any{"id": uuid.NewString(), "name": "Review assignment integration"}
		requestJSON[json.RawMessage](t, f, http.MethodPost, "/api/v1/me/workers/"+id+"/report", report, http.StatusOK, reportHeaders)
	}
	register(workerID)
	type participation struct {
		Enabled bool   `json:"enabled"`
		Version string `json:"version"`
	}
	initial := requestJSON[participation](t, f, http.MethodGet, workerBase+"/review-participation", nil, http.StatusOK)
	if initial.Enabled || initial.Version != "1" {
		t.Fatalf("initial participation: %+v", initial)
	}
	enabled := requestJSON[participation](t, f, http.MethodPut, workerBase+"/review-participation", map[string]any{"enabled": true, "expectedVersion": initial.Version}, http.StatusOK)
	if !enabled.Enabled || enabled.Version != "2" {
		t.Fatalf("enabled participation: %+v", enabled)
	}
	type candidate struct {
		ProjectID     string `json:"projectId"`
		RepositoryID  string `json:"repositoryId"`
		RepositoryURL string `json:"repositoryUrl"`
		Number        string `json:"number"`
	}
	type candidates struct {
		ReviewEnabled bool        `json:"reviewEnabled"`
		PullRequests  []candidate `json:"pullRequests"`
		NextCursor    *string     `json:"nextCursor"`
	}
	readCandidates := func(id string) candidates {
		t.Helper()
		response, body := f.request(t, http.MethodGet, "/api/v1/me/workers/"+id+"/review-pull-requests", "", nil, http.StatusOK)
		if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Daynight-User-ID") != f.userID {
			t.Fatalf("candidate response headers: %v", response.Header)
		}
		var value candidates
		if err := json.Unmarshal(body, &value); err != nil {
			t.Fatalf("candidate response: %v", err)
		}
		if value.PullRequests == nil || value.NextCursor != nil {
			t.Fatalf("candidate page: %s", body)
		}
		return value
	}
	assertCandidates := func(id string, on bool, numbers ...string) {
		t.Helper()
		want := candidates{ReviewEnabled: on, PullRequests: []candidate{}}
		for _, number := range numbers {
			want.PullRequests = append(want.PullRequests, candidate{projectID, "42", "https://github.com/example/integration", number})
		}
		if got := readCandidates(id); !reflect.DeepEqual(got, want) {
			t.Fatalf("worker %s candidates: got %+v want %+v", id, got, want)
		}
	}

	// Drive a bounded reconciliation against the same real database after both
	// PR observations are present, so absence does not depend on a sleep.
	db, err := postgres.Open(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var defaultBranch, firstBase, secondBase string
	if err := db.Pool.QueryRow(f.context, `SELECT g.repository_default_branch, p1.base_ref, p2.base_ref FROM project_github g JOIN project_pull_requests p1 ON p1.project_id=g.project_id AND p1.repository_id=g.repository_id AND p1.github_id=101 JOIN project_pull_requests p2 ON p2.project_id=g.project_id AND p2.repository_id=g.repository_id AND p2.github_id=102 WHERE g.project_id=$1 AND g.repository_id=42`, projectID).Scan(&defaultBranch, &firstBase, &secondBase); err != nil {
		t.Fatalf("read synchronized source and PRs: %v", err)
	}
	if defaultBranch != "trunk" || firstBase != "trunk" || secondBase != "release" {
		t.Fatalf("synchronized branches: default=%q first=%q second=%q", defaultBranch, firstBase, secondBase)
	}

	ctx, cancel := context.WithTimeout(f.context, 120*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	var assigned reviewAssignmentResponse
	for {
		assigned = read("1")
		if assigned.Status == "assigned" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for assignment: %+v\n%s", assigned, f.process.logs.String())
		case <-ticker.C:
		}
	}
	if assigned.Assignment == nil || assigned.Assignment.WorkerID != workerID || assigned.Assignment.AssignedAt.IsZero() || assigned.Assignment.Online == nil || !*assigned.Assignment.Online || assigned.Assignment.ReviewEnabled == nil || !*assigned.Assignment.ReviewEnabled {
		t.Fatalf("assignment differs: %+v", assigned)
	}
	assertCandidates(workerID, true, "1")

	reviewassignment.New(db, nil).Batch(f.context, 64)
	var firstCount, secondCount int
	if err := db.Pool.QueryRow(f.context, `SELECT count(*) FILTER (WHERE github_pr_id=101), count(*) FILTER (WHERE github_pr_id=102) FROM project_pr_review_assignments WHERE user_id=$1 AND project_id=$2 AND repository_id=42`, f.userID, projectID).Scan(&firstCount, &secondCount); err != nil {
		t.Fatalf("read stored assignments: %v", err)
	}
	if firstCount != 1 || secondCount != 0 {
		t.Fatalf("assignments after bounded reconciliation: trunk=%d release=%d", firstCount, secondCount)
	}
	t.Logf("repository=42 default=%s; PR 101 base=%s assignments=%d; PR 102 base=%s assignments=%d; worker=%s", defaultBranch, firstBase, firstCount, secondBase, secondCount, workerID)
	other := read("2")
	if other.Status != "waiting" || other.Assignment != nil {
		t.Fatalf("release PR assignment: %+v", other)
	}

	// Retain the first assignment while enabling only the second Worker for the
	// next PR. The second fixture PR is a Draft and becomes eligible on retarget.
	disabled := requestJSON[participation](t, f, http.MethodPut, workerBase+"/review-participation", map[string]any{"enabled": false, "expectedVersion": enabled.Version}, http.StatusOK)
	if disabled.Enabled || disabled.Version != "3" {
		t.Fatalf("disabled participation: %+v", disabled)
	}
	assertCandidates(workerID, false)
	worker2 := uuid.NewString()
	worker2Base := "/api/v1/me/workers/" + worker2
	register(worker2)
	secondEnabled := requestJSON[participation](t, f, http.MethodPut, worker2Base+"/review-participation", map[string]any{"enabled": true, "expectedVersion": "1"}, http.StatusOK)
	if !secondEnabled.Enabled || secondEnabled.Version != "2" {
		t.Fatalf("second participation: %+v", secondEnabled)
	}
	assertCandidates(worker2, true)
	retargetSecond()
	for {
		var base string
		if err := db.Pool.QueryRow(ctx, `SELECT base_ref FROM project_pull_requests WHERE project_id=$1 AND repository_id=42 AND github_id=102`, projectID).Scan(&base); err != nil {
			t.Fatalf("read retargeted PR: %v", err)
		}
		if base == "trunk" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for synchronized retarget: %q", base)
		case <-ticker.C:
		}
	}
	for {
		other = read("2")
		if other.Status == "assigned" && other.Assignment != nil && other.Assignment.WorkerID == worker2 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for retargeted PR assignment: %+v", other)
		case <-ticker.C:
		}
	}
	var draft bool
	if err := db.Pool.QueryRow(ctx, `SELECT draft FROM project_pull_requests WHERE project_id=$1 AND repository_id=42 AND github_id=102`, projectID).Scan(&draft); err != nil || !draft {
		t.Fatalf("synchronized Draft PR: draft=%t error=%v", draft, err)
	}
	assertCandidates(worker2, true, "2")
	reenabled := requestJSON[participation](t, f, http.MethodPut, workerBase+"/review-participation", map[string]any{"enabled": true, "expectedVersion": disabled.Version}, http.StatusOK)
	if !reenabled.Enabled || reenabled.Version != "4" {
		t.Fatalf("reenabled participation: %+v", reenabled)
	}
	assertCandidates(workerID, true, "1")
	assertCandidates(worker2, true, "2")
	retargetFirst("release")
	for {
		var base string
		if err := db.Pool.QueryRow(ctx, `SELECT base_ref FROM project_pull_requests WHERE project_id=$1 AND repository_id=42 AND github_id=101`, projectID).Scan(&base); err != nil {
			t.Fatalf("read retargeted first PR: %v", err)
		}
		if base == "release" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for synchronized first PR retarget: %q", base)
		case <-ticker.C:
		}
	}
	assertCandidates(workerID, true)
	assertCandidates(worker2, true, "2")
	retained := read("1")
	if retained.Status != "assigned" || retained.Assignment == nil || retained.Assignment.WorkerID != workerID || !retained.Assignment.AssignedAt.Equal(assigned.Assignment.AssignedAt) || retained.Assignment.ReviewEnabled == nil || !*retained.Assignment.ReviewEnabled {
		t.Fatalf("retained assignment: %+v", retained)
	}
	secondDisabled := requestJSON[participation](t, f, http.MethodPut, worker2Base+"/review-participation", map[string]any{"enabled": false, "expectedVersion": secondEnabled.Version}, http.StatusOK)
	if secondDisabled.Enabled {
		t.Fatalf("disabled second participation: %+v", secondDisabled)
	}
	assertCandidates(worker2, false)
	retainedSecond := read("2")
	if retainedSecond.Status != "assigned" || retainedSecond.Assignment == nil || retainedSecond.Assignment.WorkerID != worker2 || retainedSecond.Assignment.ReviewEnabled == nil || *retainedSecond.Assignment.ReviewEnabled {
		t.Fatalf("retained second assignment: %+v", retainedSecond)
	}
	secondReenabled := requestJSON[participation](t, f, http.MethodPut, worker2Base+"/review-participation", map[string]any{"enabled": true, "expectedVersion": secondDisabled.Version}, http.StatusOK)
	if !secondReenabled.Enabled {
		t.Fatalf("reenabled second participation: %+v", secondReenabled)
	}
	assertCandidates(worker2, true, "2")
	for _, state := range []string{"closed", "open", "merged"} {
		setSecondState(state)
		for {
			var observed string
			if err := db.Pool.QueryRow(ctx, `SELECT state FROM project_pull_requests WHERE project_id=$1 AND repository_id=42 AND github_id=102`, projectID).Scan(&observed); err != nil {
				t.Fatalf("read synchronized PR state: %v", err)
			}
			if observed == state {
				break
			}
			select {
			case <-ctx.Done():
				t.Fatalf("waiting for synchronized state %s: %s", state, observed)
			case <-ticker.C:
			}
		}
		if state == "open" {
			assertCandidates(worker2, true, "2")
		} else {
			assertCandidates(worker2, true)
		}
	}
	retargetFirst("trunk")
	for {
		var base string
		if err := db.Pool.QueryRow(ctx, `SELECT base_ref FROM project_pull_requests WHERE project_id=$1 AND repository_id=42 AND github_id=101`, projectID).Scan(&base); err != nil {
			t.Fatalf("read restored first PR: %v", err)
		}
		if base == "trunk" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for restored first PR: %q", base)
		case <-ticker.C:
		}
	}
	assertCandidates(workerID, true, "1")
	restoreSelection := func() {
		t.Helper()
		type configuration struct {
			Desired struct {
				Revision string `json:"revision"`
				Value    struct {
					Projects []struct {
						ProjectID string `json:"projectId"`
					} `json:"projects"`
				} `json:"value"`
			} `json:"desired"`
		}
		current := requestJSON[configuration](t, f, http.MethodGet, workerBase+"/configuration", nil, http.StatusOK, headers)
		if len(current.Desired.Value.Projects) != 0 {
			t.Fatalf("repository switch retained Worker selection: %+v", current)
		}
		requestJSON[json.RawMessage](t, f, http.MethodPut, workerBase+"/configuration", map[string]any{"revision": current.Desired.Revision, "value": bootstrap}, http.StatusOK, headers)
		restored := requestJSON[configuration](t, f, http.MethodGet, workerBase+"/configuration", nil, http.StatusOK, headers)
		if len(restored.Desired.Value.Projects) != 1 || restored.Desired.Value.Projects[0].ProjectID != projectID {
			t.Fatalf("restored Worker selection: %+v", restored)
		}
	}
	waitRepository := func(wantID int64) {
		t.Helper()
		for {
			var id int64
			var branch string
			if err := db.Pool.QueryRow(ctx, `SELECT COALESCE(repository_id,0), COALESCE(repository_default_branch,'') FROM project_github WHERE project_id=$1`, projectID).Scan(&id, &branch); err != nil {
				t.Fatalf("read synchronized repository: %v", err)
			}
			if id == wantID && branch == "trunk" {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatalf("waiting for synchronized repository %d: id=%d default=%q", wantID, id, branch)
			case <-ticker.C:
			}
		}
	}
	switchRepository(false)
	waitRepository(43)
	restoreSelection()
	assertCandidates(workerID, true)
	var retainedCount int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_pr_review_assignments WHERE user_id=$1 AND project_id=$2 AND repository_id=42 AND github_pr_id=101 AND worker_id=$3`, f.userID, projectID, workerID).Scan(&retainedCount); err != nil || retainedCount != 1 {
		t.Fatalf("historical assignment after repository switch: count=%d error=%v", retainedCount, err)
	}
	switchRepository(true)
	waitRepository(42)
	restoreSelection()
	assertCandidates(workerID, true, "1")
}
