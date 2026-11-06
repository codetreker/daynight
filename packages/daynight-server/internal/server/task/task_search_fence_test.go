package task_test

import (
	"context"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestSearchFenceTracksTaskWrites(t *testing.T) {
	ctx := context.Background()
	db := projectTestStore(t)
	handler := projectTestHandler(t, db, io.Discard)
	project := taskProject(t, handler)
	a := createHTTPTask(t, handler, project.ID, "match A")
	b := createHTTPTask(t, handler, project.ID, "match B")
	path := taskCollection(project.ID) + "/search"
	start := func() string {
		t.Helper()
		p := decodeResponse[api.TaskSearchPage](t, projectRequest(handler, "POST", path, `{"query":"match","limit":1}`), 200)
		if p.NextCursor == nil {
			t.Fatalf("missing continuation: %+v", p)
		}
		return *p.NextCursor
	}
	check := func(name string, change func()) {
		t.Helper()
		cursor := start()
		change()
		response := projectRequest(handler, "POST", path, jsonBody(t, map[string]any{"query": "match", "limit": 1, "cursor": cursor}))
		if response.Code != 409 {
			t.Fatalf("%s: %d %s", name, response.Code, response.Body)
		}
		assertProjectError(t, response, 409, "search_changed")
	}
	check("create", func() { createHTTPTask(t, handler, project.ID, "unmatched") })
	check("title", func() { a = updateHTTPTask(t, handler, a, map[string]any{"title": "match A changed"}) })
	check("description", func() { a = updateHTTPTask(t, handler, a, map[string]any{"description": "new description"}) })
	check("assignment", func() { a = updateHTTPTask(t, handler, a, map[string]any{"assignedTo": handler.principal.UserID}) })
	check("platform", func() { a = updateHTTPTask(t, handler, a, map[string]any{"requiredPlatform": "linux"}) })
	check("agent permission", func() { a = updateHTTPTask(t, handler, a, map[string]any{"allowAgents": true}) })
	check("dependency", func() { a = updateHTTPTask(t, handler, a, map[string]any{"dependsOn": []string{b.ID}}) })
	check("property", func() {
		propertyResource(t, handler, "PUT", taskPath(a)+"/properties/pullRequests", map[string]any{"version": a.Version, "valueText": "[]"})
		a = readHTTPTask(t, handler, a)
	})
	check("step", func() {
		decodeResponse[api.StepsResource](t, projectRequest(handler, "POST", taskPath(a)+"/steps", jsonBody(t, map[string]any{"version": a.Version, "id": "abcdef01", "title": "Step"})), 201)
		a = readHTTPTask(t, handler, a)
	})
	check("status", func() { b = setHTTPTask(t, handler, b, "in_progress") })
	worker := createHTTPWorkerTask(t, handler, project.ID, "worker")
	worker = updateHTTPTask(t, handler, worker, map[string]any{"allowAgents": true})
	check("worker claim", func() { worker = claimHTTPWorker(t, handler, worker, workerClaimBody(worker.Version)) })
	disposable := createHTTPTask(t, handler, project.ID, "discard")
	check("soft deletion", func() {
		r := projectRequest(handler, "DELETE", taskPath(disposable), jsonBody(t, api.TaskDeleteRequest{Version: disposable.Version}))
		if r.Code != 204 {
			t.Fatalf("delete: %d %s", r.Code, r.Body)
		}
	})
	check("history epoch replacement", func() {
		if _, err := db.Pool.Exec(ctx, `UPDATE projects SET task_cache_epoch=gen_random_uuid() WHERE id=$1`, project.ID); err != nil {
			t.Fatal(err)
		}
	})
	cursor := start()
	a = updateHTTPTask(t, handler, a, map[string]any{"title": a.Title})
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE tasks SET version=version+1 WHERE id=$1`, a.ID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, "POST", path, jsonBody(t, map[string]any{"query": "match", "limit": 1, "cursor": cursor}))
	if response.Code != 200 {
		t.Fatalf("no-op or rollback changed fence: %d %s", response.Code, response.Body)
	}
	cursor = start()
	b = updateHTTPTask(t, handler, b, map[string]any{"description": "changed before revocation"})
	if _, err = db.Pool.Exec(ctx, `DELETE FROM team_members WHERE user_id=$1 AND team_id=(SELECT team_id FROM project_ownership WHERE project_id=$2)`, handler.principal.UserID, project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `DELETE FROM project_grants WHERE user_id=$1 AND project_id=$2`, handler.principal.UserID, project.ID); err != nil {
		t.Fatal(err)
	}
	response = projectRequest(handler, "POST", path, jsonBody(t, map[string]any{"query": "match", "limit": 1, "cursor": cursor}))
	if response.Code != 403 && response.Code != 404 {
		t.Fatalf("revocation must precede changed fence: %d %s", response.Code, response.Body)
	}
}
