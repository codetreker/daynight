//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
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
	if initial["projectId"] != project.ID || initial["version"] != "1" || initial["revision"] != "0" || initial["serviceAvailable"] != true || initial["connection"] != "not_connected" || initial["pollIntervalMinutes"] != float64(5) {
		t.Fatalf("initial GitHub state differs: %+v", initial)
	}
	for _, key := range []string{"repository", "installation", "app", "grantId"} {
		if value, present := initial[key]; !present || value != nil {
			t.Fatalf("initial %s must be null: %+v", key, initial)
		}
	}
	sources := read(base + "/pull-request-repositories")
	sourceItems, ok := sources["items"].([]any)
	if sources["currentRepositoryId"] != nil || sources["nextCursor"] != nil || !ok || len(sourceItems) != 0 {
		t.Fatalf("initial repository directory differs: %+v", sources)
	}

	db, err := pgxpool.New(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(f.context, `INSERT INTO project_github
		(project_id,version,generation,revision,enabled,repository_id,legacy_repository_id,repository_full_name,repository_private,poll_interval_minutes,access_state,last_full_generation,last_full_success_at)
		VALUES ($1,3,2,7,false,9007199254740993,9007199254740993,'owner/repository',true,5,'unknown',1,'2026-01-02T03:04:05Z')`, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(f.context, `INSERT INTO project_github_repositories(project_id,repository_id,full_name) VALUES($1,9007199254740993,'owner/repository')`, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(f.context, `INSERT INTO project_pull_requests
		(project_id,repository_id,number,github_id,url,title,author_id,author_login,state,draft,base_ref,head_repository_id,head_repository_full_name,head_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision)
		VALUES
		($1,9007199254740993,9007199254740993,9007199254740995,'https://github.com/owner/repository/pull/9007199254740993','First PR',9007199254740997,'author','open',true,'main',9007199254740999,'fork/repository','feature','abcdef','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',$2,'2026-01-03T00:00:00Z',7),
		($1,9007199254740993,4,104,'https://github.com/owner/repository/pull/4','Author closed PR',9007199254740997,'author','closed',false,'main',NULL,NULL,NULL,'345678','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,'2026-01-03T00:00:00Z',7),
		($1,9007199254740993,3,103,'https://github.com/owner/repository/pull/3','Author second PR',9007199254740997,'author','open',false,'main',NULL,NULL,NULL,'234567','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,'2026-01-03T00:00:00Z',7),
		($1,9007199254740993,2,102,'https://github.com/owner/repository/pull/2','Second PR',NULL,NULL,'open',false,'main',NULL,NULL,NULL,'123456','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,'2026-01-03T00:00:00Z',7),
		($1,9007199254740993,1,101,'https://github.com/owner/repository/pull/1','Closed PR',9007199254740998,'zeta','closed',false,'main',NULL,NULL,NULL,'789abc','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,'2026-01-03T00:00:00Z',7)`, project.ID, "正文\n**original**\n")
	if err != nil {
		t.Fatal(err)
	}

	state := read(base + "/github")
	if state["connection"] != "not_connected" || state["serviceAvailable"] != true || state["version"] != "3" || state["revision"] != "7" {
		t.Fatalf("retained GitHub state differs: %+v", state)
	}
	repository, ok := state["repository"].(map[string]any)
	if !ok || repository["id"] != "9007199254740993" || repository["fullName"] != "owner/repository" || repository["private"] != true {
		t.Fatalf("retained repository differs: %+v", state["repository"])
	}

	authorsPath := base + "/pull-request-authors?q=a&limit=1"
	authors := read(authorsPath)
	authorItems, ok := authors["items"].([]any)
	if authors["projectId"] != project.ID || authors["revision"] != "7" || !ok || len(authorItems) != 1 {
		t.Fatalf("first author page differs: %+v", authors)
	}
	firstAuthor, ok := authorItems[0].(map[string]any)
	if !ok || firstAuthor["id"] != "9007199254740997" || firstAuthor["login"] != "author" || firstAuthor["loginAmbiguous"] != false {
		t.Fatalf("first author differs: %+v", authorItems[0])
	}
	authorCursor, ok := authors["nextCursor"].(string)
	if !ok || authorCursor == "" {
		t.Fatalf("first author page lacks a next cursor: %+v", authors)
	}
	moreAuthors := read(authorsPath + "&cursor=" + url.QueryEscape(authorCursor))
	authorItems, ok = moreAuthors["items"].([]any)
	if moreAuthors["projectId"] != project.ID || moreAuthors["revision"] != "7" || !ok || len(authorItems) != 1 || moreAuthors["nextCursor"] != nil {
		t.Fatalf("second author page differs: %+v", moreAuthors)
	}
	secondAuthor, ok := authorItems[0].(map[string]any)
	if !ok || secondAuthor["id"] != "9007199254740998" || secondAuthor["login"] != "zeta" || secondAuthor["loginAmbiguous"] != false {
		t.Fatalf("second author differs: %+v", authorItems[0])
	}

	first := read(base + "/pull-requests?limit=1")
	counts, ok := first["counts"].(map[string]any)
	if first["projectId"] != project.ID || first["revision"] != "7" || first["total"] != "3" || !ok || counts["active"] != "3" || counts["closed"] != "2" || counts["merged"] != "0" || counts["all"] != "5" {
		t.Fatalf("first page metadata differs: %+v", first)
	}
	if _, present := first["authorId"]; present {
		t.Fatalf("unfiltered page contains authorId: %+v", first)
	}
	if _, present := first["projectTotal"]; present {
		t.Fatalf("unfiltered page contains projectTotal: %+v", first)
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
	if !ok || secondSummary["number"] != "3" || second["nextCursor"] == nil {
		t.Fatalf("second page differs: %+v", second)
	}
	thirdCursor, ok := second["nextCursor"].(string)
	if !ok || thirdCursor == "" {
		t.Fatalf("second page lacks next cursor: %+v", second)
	}
	third := read(base + "/pull-requests?limit=1&cursor=" + url.QueryEscape(thirdCursor))
	thirdItems, ok := third["items"].([]any)
	if !ok || len(thirdItems) != 1 {
		t.Fatalf("third page items differ: %+v", third)
	}
	thirdSummary, ok := thirdItems[0].(map[string]any)
	if !ok || thirdSummary["number"] != "2" || thirdSummary["author"] != nil || third["nextCursor"] != nil {
		t.Fatalf("third page differs: %+v", third)
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

	authorQuery := "?authorId=9007199254740997&state=all&limit=1"
	authorFirst := read(base + "/pull-requests" + authorQuery)
	authorCounts, ok := authorFirst["counts"].(map[string]any)
	if !ok || authorFirst["authorId"] != "9007199254740997" || authorFirst["projectTotal"] != "5" || authorFirst["total"] != "3" || authorCounts["active"] != "2" || authorCounts["closed"] != "1" || authorCounts["merged"] != "0" || authorCounts["all"] != "3" {
		t.Fatalf("author page metadata differs: %+v", authorFirst)
	}
	authorItems, ok = authorFirst["items"].([]any)
	if !ok || len(authorItems) != 1 {
		t.Fatalf("author page items differ: %+v", authorFirst)
	}
	authorSummary, ok := authorItems[0].(map[string]any)
	if !ok || authorSummary["number"] != summary["number"] {
		t.Fatalf("author page first item differs: %+v", authorFirst)
	}
	author, ok := authorSummary["author"].(map[string]any)
	if !ok || author["id"] != "9007199254740997" || author["login"] != "author" {
		t.Fatalf("author identity differs: %+v", authorSummary)
	}
	authorNext, ok := authorFirst["nextCursor"].(string)
	if !ok || authorNext == "" || authorFirst["previousCursor"] != nil {
		t.Fatalf("author page cursors differ: %+v", authorFirst)
	}
	authorSecond := read(base + "/pull-requests" + authorQuery + "&cursor=" + url.QueryEscape(authorNext))
	authorItems, ok = authorSecond["items"].([]any)
	if !ok || len(authorItems) != 1 {
		t.Fatalf("author second page items differ: %+v", authorSecond)
	}
	authorSummary, ok = authorItems[0].(map[string]any)
	if !ok || authorSummary["number"] != "4" || authorSecond["total"] != "3" || authorSecond["projectTotal"] != "5" {
		t.Fatalf("author second page differs: %+v", authorSecond)
	}
	authorNext, ok = authorSecond["nextCursor"].(string)
	if !ok || authorNext == "" {
		t.Fatalf("author second page lacks next cursor: %+v", authorSecond)
	}
	authorThird := read(base + "/pull-requests" + authorQuery + "&cursor=" + url.QueryEscape(authorNext))
	authorItems, ok = authorThird["items"].([]any)
	if !ok || len(authorItems) != 1 {
		t.Fatalf("author third page items differ: %+v", authorThird)
	}
	authorSummary, ok = authorItems[0].(map[string]any)
	if !ok || authorSummary["number"] != "3" || authorThird["nextCursor"] != nil {
		t.Fatalf("author third page differs: %+v", authorThird)
	}
	authorPrevious, ok := authorSecond["previousCursor"].(string)
	if !ok || authorPrevious == "" {
		t.Fatalf("author second page lacks previous cursor: %+v", authorSecond)
	}
	authorBack := read(base + "/pull-requests" + authorQuery + "&cursor=" + url.QueryEscape(authorPrevious))
	backItems, ok = authorBack["items"].([]any)
	if !ok || len(backItems) != 1 {
		t.Fatalf("author previous page differs: %+v", authorBack)
	}
	backSummary, ok = backItems[0].(map[string]any)
	if !ok || backSummary["number"] != summary["number"] {
		t.Fatalf("author previous page did not return first item: %+v", authorBack)
	}
	filtered := read(base + "/pull-requests?authorId=9007199254740997&state=closed&q=closed")
	filteredItems, ok := filtered["items"].([]any)
	filteredCounts, countsOK := filtered["counts"].(map[string]any)
	if !ok || len(filteredItems) != 1 || !countsOK || filtered["total"] != "1" || filtered["projectTotal"] != "5" || filteredCounts["active"] != "2" || filteredCounts["closed"] != "1" || filteredCounts["all"] != "3" {
		t.Fatalf("combined author, state and query differ: %+v", filtered)
	}
	filteredSummary, ok := filteredItems[0].(map[string]any)
	if !ok || filteredSummary["number"] != "4" {
		t.Fatalf("combined filter item differs: %+v", filtered)
	}
	noMatch := read(base + "/pull-requests?authorId=9007199254740997&state=closed&q=absent")
	noMatchItems, ok := noMatch["items"].([]any)
	noMatchCounts, countsOK := noMatch["counts"].(map[string]any)
	if !ok || len(noMatchItems) != 0 || !countsOK || noMatch["total"] != "0" || noMatch["projectTotal"] != "5" || noMatchCounts["all"] != "3" {
		t.Fatalf("empty combined filter differs: %+v", noMatch)
	}
	missing := read(base + "/pull-requests?authorId=9223372036854775807&state=all")
	missingItems, ok := missing["items"].([]any)
	missingCounts, countsOK := missing["counts"].(map[string]any)
	if !ok || len(missingItems) != 0 || !countsOK || missing["authorId"] != "9223372036854775807" || missing["projectTotal"] != "5" || missing["total"] != "0" || missingCounts["all"] != "0" {
		t.Fatalf("missing author page differs: %+v", missing)
	}
	detail := read(base + "/pull-requests/9007199254740993")
	if detail["number"] != summary["number"] || detail["id"] != summary["id"] || detail["description"] != "正文\n**original**\n" {
		t.Fatalf("detail differs from saved observation: %+v", detail)
	}

	// Change saved observations after the list assertions so the statistics read
	// covers both sides of the window and a later login for the same author ID.
	_, err = db.Exec(f.context, `UPDATE project_pull_requests SET
		github_created_at = CASE number
			WHEN 3 THEN '2025-12-31T23:00:00Z'::timestamptz
			WHEN 2 THEN '2026-01-01T18:00:00Z'::timestamptz
			WHEN 1 THEN '2026-01-02T00:00:00Z'::timestamptz
			ELSE github_created_at END,
		author_login = CASE WHEN number=4 THEN 'renamed' ELSE author_login END,
		observed_at = CASE WHEN number=4 THEN '2026-01-04T00:00:00Z'::timestamptz ELSE observed_at END
		WHERE project_id=$1`, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	other := createProject(t, f, "Other GitHub PR reads")
	_, err = db.Exec(f.context, `INSERT INTO project_github(project_id,repository_id,legacy_repository_id,repository_full_name) VALUES($1,9007199254740993,9007199254740993,'owner/repository')`, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(f.context, `INSERT INTO project_github_repositories(project_id,repository_id,full_name) VALUES($1,9007199254740993,'owner/repository')`, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(f.context, `INSERT INTO project_pull_requests
		(project_id,repository_id,number,github_id,url,title,author_id,author_login,state,draft,base_ref,head_repository_id,head_repository_full_name,head_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision)
		SELECT $2,repository_id,number,github_id,url,title,author_id,author_login,state,draft,base_ref,head_repository_id,head_repository_full_name,head_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision
		FROM project_pull_requests WHERE project_id=$1 AND number=4`, project.ID, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, title := range []string{"First linked task", "Second linked task"} {
		task := createTask(t, f, project, title, nil)
		requestJSON[api.PropertyResource](t, f, http.MethodPut, taskPath(task)+"/properties/pullRequests", map[string]any{
			"version": task.Version, "valueText": `[{"url":"https://github.com/owner/repository/pull/4","title":"Author closed PR"}]`,
		}, http.StatusOK)
	}
	statisticsQuery := "?endDate=2026-01-01&window=29%401767225600000%2C-%401767312000000"
	stats := read(base + "/pull-request-statistics" + statisticsQuery)
	daily, ok := stats["daily"].([]any)
	if stats["projectId"] != project.ID || stats["endDate"] != "2026-01-01" || stats["revision"] != "7" || stats["projectTotal"] != "5" || stats["availability"] != "ready" || stats["hasAuthors"] != true || stats["authorId"] != nil || stats["author"] != nil || stats["authorDaily"] != nil || !ok || len(daily) != 30 || daily[29] != "3" {
		t.Fatalf("all-author statistics differ: %+v", stats)
	}
	for _, count := range daily[:29] {
		if count != "0" {
			t.Fatalf("unexpected daily count: %+v", daily)
		}
	}
	selected := read(base + "/pull-request-statistics" + statisticsQuery + "&authorId=9007199254740997")
	selectedAuthor, ok := selected["author"].(map[string]any)
	selectedDaily, dailyOK := selected["authorDaily"].([]any)
	if selected["projectTotal"] != "5" || selected["authorId"] != "9007199254740997" || !ok || selectedAuthor["id"] != "9007199254740997" || selectedAuthor["login"] != "renamed" || !dailyOK || len(selectedDaily) != 30 || selectedDaily[29] != "2" {
		t.Fatalf("selected-author statistics differ: %+v", selected)
	}
	otherStats := read("/api/v1/projects/" + other.ID + "/pull-request-statistics" + statisticsQuery)
	otherDaily, ok := otherStats["daily"].([]any)
	if otherStats["projectId"] != other.ID || otherStats["projectTotal"] != "1" || !ok || len(otherDaily) != 30 || otherDaily[29] != "1" {
		t.Fatalf("other project statistics differ: %+v", otherStats)
	}
	serverAPIGitHubRepositoryReadNormalFlow(t, f, project.ID, db)
}
