//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The synchronizer is delivered independently. Seed its persisted observations
// so this flow exercises the actual read API without depending on GitHub.
func serverAPIGitHubReadNormalFlow(t *testing.T, f *fixture) {
	t.Helper()
	project := createProject(t, f, "GitHub PR reads")
	base := "/api/v1/projects/" + project.ID
	read := func(path string) map[string]any {
		t.Helper()
		response, data := f.request(t, http.MethodGet, path, "", nil, http.StatusOK)
		if response.Header.Get("Daynight-User-ID") != f.userID {
			t.Fatalf("%s did not identify the authenticated principal", path)
		}
		var result map[string]any
		if err := json.Unmarshal(data, &result); err != nil {
			t.Fatalf("decode %s: %v: %s", path, err, data)
		}
		return result
	}
	initial := read(base + "/github")
	if initial["projectId"] != project.ID || initial["version"] != "1" || initial["revision"] != "0" || initial["serviceAvailable"] != false || initial["connection"] != "not_connected" || initial["pollIntervalMinutes"] != float64(5) {
		t.Fatalf("initial GitHub state differs: %+v", initial)
	}
	for _, key := range []string{"repository", "installation"} {
		if value, present := initial[key]; !present || value != nil {
			t.Fatalf("initial %s must be null: %+v", key, initial)
		}
	}

	db, err := pgxpool.New(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(f.context, `INSERT INTO project_github
		(project_id,version,generation,revision,enabled,app_id,installation_id,repository_id,installation_account_login,repository_full_name,repository_private,poll_interval_minutes,access_state,last_full_generation,last_full_success_at)
		VALUES ($1,3,2,7,false,123,456,9007199254740993,'owner','owner/repository',true,5,'available',1,'2026-01-02T03:04:05Z')`, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(f.context, `INSERT INTO project_pull_requests
		(project_id,number,github_id,url,title,author_id,author_login,state,draft,base_ref,head_repository_id,head_repository_full_name,head_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision)
		VALUES
		($1,9007199254740993,9007199254740995,'https://github.com/owner/repository/pull/9007199254740993','First PR',9007199254740997,'author','open',true,'main',9007199254740999,'fork/repository','feature','abcdef','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',$2,'2026-01-03T00:00:00Z',7),
		($1,2,102,'https://github.com/owner/repository/pull/2','Second PR',NULL,NULL,'open',false,'main',NULL,NULL,NULL,'123456','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,'2026-01-03T00:00:00Z',7),
		($1,1,101,'https://github.com/owner/repository/pull/1','Closed PR',NULL,NULL,'closed',false,'main',NULL,NULL,NULL,'789abc','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,'2026-01-03T00:00:00Z',7)`, project.ID, "正文\n**original**\n")
	if err != nil {
		t.Fatal(err)
	}

	state := read(base + "/github")
	if state["connection"] != "disconnected" || state["serviceAvailable"] != false || state["version"] != "3" || state["revision"] != "7" {
		t.Fatalf("retained GitHub state differs: %+v", state)
	}
	repository, ok := state["repository"].(map[string]any)
	if !ok || repository["id"] != "9007199254740993" || repository["fullName"] != "owner/repository" || repository["private"] != true {
		t.Fatalf("retained repository differs: %+v", state["repository"])
	}

	first := read(base + "/pull-requests?limit=1")
	counts, ok := first["counts"].(map[string]any)
	if first["projectId"] != project.ID || first["revision"] != "7" || first["total"] != "2" || !ok || counts["active"] != "2" || counts["closed"] != "1" || counts["merged"] != "0" || counts["all"] != "3" {
		t.Fatalf("first page metadata differs: %+v", first)
	}
	items, ok := first["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("first page items differ: %+v", first)
	}
	summary, ok := items[0].(map[string]any)
	if !ok || summary["number"] != "9007199254740993" || summary["id"] != "9007199254740995" || summary["title"] != "First PR" || summary["state"] != "open" || summary["draft"] != true || summary["revision"] != "7" {
		t.Fatalf("first summary differs: %+v", items[0])
	}
	if _, present := summary["description"]; present {
		t.Fatalf("summary contains description: %+v", summary)
	}
	head, ok := summary["head"].(map[string]any)
	if !ok || head["repositoryId"] != "9007199254740999" || head["repositoryFullName"] != "fork/repository" || head["ref"] != "feature" || head["sha"] != "abcdef" {
		t.Fatalf("head identity differs: %+v", summary["head"])
	}
	baseRef, ok := summary["base"].(map[string]any)
	if !ok || baseRef["repositoryId"] != "9007199254740993" || baseRef["repositoryFullName"] != "owner/repository" || baseRef["ref"] != "main" {
		t.Fatalf("base identity differs: %+v", summary["base"])
	}
	next, ok := first["nextCursor"].(string)
	if !ok || next == "" || first["previousCursor"] != nil {
		t.Fatalf("first page cursors differ: %+v", first)
	}
	second := read(base + "/pull-requests?limit=1&cursor=" + url.QueryEscape(next))
	items, ok = second["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("second page items differ: %+v", second)
	}
	secondSummary, ok := items[0].(map[string]any)
	if !ok || secondSummary["number"] != "2" || secondSummary["author"] != nil || second["nextCursor"] != nil {
		t.Fatalf("second page differs: %+v", second)
	}
	previous, ok := second["previousCursor"].(string)
	if !ok || previous == "" {
		t.Fatalf("second page lacks previous cursor: %+v", second)
	}
	back := read(base + "/pull-requests?limit=1&cursor=" + url.QueryEscape(previous))
	backItems, ok := back["items"].([]any)
	if !ok || len(backItems) != 1 {
		t.Fatalf("previous page differs: %+v", back)
	}
	backSummary, ok := backItems[0].(map[string]any)
	if !ok || backSummary["number"] != summary["number"] {
		t.Fatalf("previous page did not return the first PR: %+v", back)
	}
	detail := read(base + "/pull-requests/9007199254740993")
	if detail["number"] != summary["number"] || detail["id"] != summary["id"] || detail["description"] != "正文\n**original**\n" {
		t.Fatalf("detail differs from saved observation: %+v", detail)
	}
}
