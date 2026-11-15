//go:build integration

package main

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func assertSyncSession(t *testing.T, sync api.TaskSync, task api.Task, state string) {
	t.Helper()
	item, exists := sync.TaskObservations[task.ID]
	if !exists || item.TaskVersion != resourceVersion(task.Version) || item.State != state || item.ObservedAt == nil || item.ObservedAt.IsZero() || item.FreshUntil == nil || item.FreshUntil.IsZero() || item.CanOpen {
		t.Fatalf("Task %s observation differs: %+v", task.ID, item)
	}
}

func sessionSyncInitialFlow(t *testing.T, f *fixture, project api.Project, manual, claimed api.Task) {
	t.Helper()
	snapshot := requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID), nil, http.StatusOK)
	if snapshot.Project.ID != project.ID || snapshot.Mode != "snapshot" || snapshot.Epoch == "" || snapshot.ObservedAt.IsZero() || snapshot.ResponseTaskAt.IsZero() || snapshot.ResponseSessionAt.IsZero() || snapshot.SessionPartial || len(snapshot.TaskObservations) != 2 {
		t.Fatalf("Session snapshot differs: %+v", snapshot)
	}
	assertSyncSession(t, snapshot, manual, "no_session")
	assertSyncSession(t, snapshot, claimed, "not_registered")
	// The API accepts a future watermark; advancing past the configured 10-second
	// overlap makes this unchanged delta empty without delaying the integration suite.
	query := url.Values{"epoch": {snapshot.Epoch}, "since": {snapshot.ObservedAt.Add(11 * time.Second).Format(time.RFC3339Nano)}}
	delta := requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID)+"?"+query.Encode(), nil, http.StatusOK)
	if delta.Project.ID != project.ID || delta.Mode != "delta" || delta.Epoch != snapshot.Epoch || len(delta.Tasks) != 0 || len(delta.TaskObservations) != 2 || delta.SessionPartial || delta.ResponseTaskAt.IsZero() || delta.ResponseSessionAt.IsZero() {
		t.Fatalf("unchanged Session delta differs: %+v", delta)
	}
	assertSyncSession(t, delta, manual, "no_session")
	assertSyncSession(t, delta, claimed, "not_registered")
}

func sessionSyncReopenedFlow(t *testing.T, f *fixture, project api.Project, claimed api.Task, sessionID, claimID string) {
	t.Helper()
	current := requestJSON[api.Task](t, f, http.MethodGet, taskPath(claimed), nil, http.StatusOK)
	completed := setStatus(t, f, current, "done", &claimID)
	if claim := workerClaim(t, completed); claim.ClaimID != claimID || claim.State != "completed" {
		t.Fatalf("completed worker differs: %+v", claim)
	}
	reopened := setStatus(t, f, completed, "todo", nil)
	reopened = setStatus(t, f, reopened, "in_progress", nil)
	if claim := workerClaim(t, reopened); claim.ClaimID != claimID || claim.State != "completed" {
		t.Fatalf("reopened worker history differs: %+v", claim)
	}
	sync := requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID), nil, http.StatusOK)
	assertSyncSession(t, sync, reopened, "no_session")
	history := requestJSON[sp.TaskSessionList](t, f, http.MethodGet, taskPath(reopened)+"/sessions?view=inspection", nil, http.StatusOK)
	if len(history.Items) != 1 || history.Items[0].SessionID != sessionID || history.Items[0].ClaimID != claimID {
		t.Fatalf("historical Session differs: %+v", history)
	}
	reopened = setStatus(t, f, reopened, "todo", nil)
	newClaimID := uuid.NewString()
	next := requestJSON[api.Task](t, f, http.MethodPost, taskPath(reopened)+"/worker-claim", map[string]any{
		"version": reopened.Version, "claimId": newClaimID, "workerId": uuid.NewString(), "worktreeId": uuid.NewString(),
		"machine":  map[string]any{"id": uuid.NewString(), "name": "Next integration execution"},
		"platform": "linux", "agent": "codex", "agentControlMode": "web",
	}, http.StatusOK)
	if claim := workerClaim(t, next); claim.ClaimID != newClaimID || claim.State != "active" {
		t.Fatalf("new claim differs: %+v", claim)
	}
	sync = requestJSON[api.TaskSync](t, f, http.MethodGet, syncPath(project.ID), nil, http.StatusOK)
	assertSyncSession(t, sync, next, "not_registered")
}
