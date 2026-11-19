//go:build integration

package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func serverAPIGitHubRepositoryReadNormalFlow(t *testing.T, f *fixture, projectID string, db *pgxpool.Pool) {
	t.Helper()
	const legacyID = "9007199254740993"
	const currentID = "9007199254740994"
	const emptyID = "9007199254740995"
	base := "/api/v1/projects/" + projectID
	read := func(path string) map[string]any {
		t.Helper()
		response, data := f.request(t, http.MethodGet, base+path, "", nil, http.StatusOK)
		if response.Header.Get("Daynight-User-ID") != f.userID {
			t.Fatalf("%s did not identify the authenticated principal", path)
		}
		var result map[string]any
		if err := json.Unmarshal(data, &result); err != nil {
			t.Fatalf("decode %s: %v: %s", path, err, data)
		}
		return result
	}
	items := func(page map[string]any, count int) []any {
		t.Helper()
		values, ok := page["items"].([]any)
		if !ok || len(values) != count {
			t.Fatalf("expected %d items: %+v", count, page)
		}
		return values
	}
	source := func(page map[string]any, id, name string) {
		t.Helper()
		repository, ok := page["repository"].(map[string]any)
		if !ok || repository["repositoryId"] != id || repository["fullName"] != name {
			t.Fatalf("selected source differs: %+v", page)
		}
	}
	cursor := func(page map[string]any) string {
		t.Helper()
		value, ok := page["nextCursor"].(string)
		if !ok || value == "" {
			t.Fatalf("page lacks next cursor: %+v", page)
		}
		return url.QueryEscape(value)
	}
	_, err := db.Exec(f.context, `INSERT INTO project_github_repositories(project_id,repository_id,full_name)
		VALUES ($1,9007199254740994,'owner/current'),($1,9007199254740995,'owner/empty')`, projectID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(f.context, `INSERT INTO project_pull_requests
		(project_id,repository_id,number,github_id,url,title,author_id,author_login,state,draft,base_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision)
		VALUES
		($1,9007199254740994,3,2003,'https://github.com/owner/current/pull/3','Current source PR',700,'alpha','open',false,'main','abcdef','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','Current source description','2026-01-03T00:00:00Z',7),
		($1,9007199254740994,2,2002,'https://github.com/owner/current/pull/2','Current merged PR',701,'beta','merged',false,'main','abcdef','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',NULL,'2026-01-03T00:00:00Z',7)`, projectID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(f.context, `UPDATE project_github SET repository_id=9007199254740994,
		repository_full_name='owner/current',installation_id=17,installation_account_login='owner',
		last_full_generation=generation WHERE project_id=$1`, projectID)
	if err != nil {
		t.Fatal(err)
	}

	directory := read("/pull-request-repositories?limit=1")
	for index, expected := range []struct{ id, name string }{{legacyID, "owner/repository"}, {currentID, "owner/current"}, {emptyID, "owner/empty"}} {
		if directory["currentRepositoryId"] != currentID {
			t.Fatalf("directory current source differs: %+v", directory)
		}
		entry, ok := items(directory, 1)[0].(map[string]any)
		if !ok || entry["repositoryId"] != expected.id || entry["fullName"] != expected.name {
			t.Fatalf("directory source differs: %+v", directory)
		}
		if index < 2 {
			directory = read("/pull-request-repositories?limit=1&cursor=" + cursor(directory))
		} else if directory["nextCursor"] != nil {
			t.Fatalf("last directory page has next cursor: %+v", directory)
		}
	}

	legacy := read("/pull-requests?state=all")
	if legacy["total"] != "5" {
		t.Fatalf("implicit list changed sources: %+v", legacy)
	}
	items(legacy, 5)
	if _, present := legacy["repository"]; present {
		t.Fatalf("implicit response gained source metadata: %+v", legacy)
	}
	currentPath := "/pull-requests?repositoryId=" + currentID + "&state=all&limit=1"
	current := read(currentPath)
	source(current, currentID, "owner/current")
	counts, ok := current["counts"].(map[string]any)
	if current["total"] != "2" || !ok || counts["active"] != "1" || counts["merged"] != "1" || counts["closed"] != "0" || counts["all"] != "2" {
		t.Fatalf("selected source counts differ: %+v", current)
	}
	first, ok := items(current, 1)[0].(map[string]any)
	if !ok || first["number"] != "3" || first["title"] != "Current source PR" {
		t.Fatalf("selected source PR differs: %+v", current)
	}
	currentNext := read(currentPath + "&cursor=" + cursor(current))
	second, ok := items(currentNext, 1)[0].(map[string]any)
	if !ok || second["number"] != "2" || currentNext["nextCursor"] != nil {
		t.Fatalf("selected source next page differs: %+v", currentNext)
	}
	for _, expected := range []struct{ id, title, description string }{
		{legacyID, "Author second PR", ""},
		{currentID, "Current source PR", "Current source description"},
	} {
		detail := read("/pull-requests/3?repositoryId=" + expected.id)
		baseRepository, ok := detail["base"].(map[string]any)
		if !ok || baseRepository["repositoryId"] != expected.id || detail["number"] != "3" || detail["title"] != expected.title {
			t.Fatalf("same-number detail source differs: %+v", detail)
		}
		if expected.description != "" && detail["description"] != expected.description {
			t.Fatalf("selected source description differs: %+v", detail)
		}
	}
	implicitDetail := read("/pull-requests/3")
	if implicitDetail["title"] != "Author second PR" {
		t.Fatalf("implicit detail changed sources: %+v", implicitDetail)
	}

	authorsPath := "/pull-request-authors?repositoryId=" + currentID + "&limit=1"
	authors := read(authorsPath)
	source(authors, currentID, "owner/current")
	firstAuthor, ok := items(authors, 1)[0].(map[string]any)
	if !ok || firstAuthor["id"] != "700" || firstAuthor["login"] != "alpha" {
		t.Fatalf("selected source author differs: %+v", authors)
	}
	nextAuthors := read(authorsPath + "&cursor=" + cursor(authors))
	secondAuthor, ok := items(nextAuthors, 1)[0].(map[string]any)
	if !ok || secondAuthor["id"] != "701" || secondAuthor["login"] != "beta" || nextAuthors["nextCursor"] != nil {
		t.Fatalf("selected source next author differs: %+v", nextAuthors)
	}

	statisticsPath := "/pull-request-statistics?endDate=2026-01-01&window=29%401767225600000%2C-%401767312000000"
	stats := read(statisticsPath + "&repositoryId=" + currentID + "&authorId=700")
	source(stats, currentID, "owner/current")
	daily, ok := stats["daily"].([]any)
	authorDaily, authorDailyOK := stats["authorDaily"].([]any)
	author, authorOK := stats["author"].(map[string]any)
	if stats["projectTotal"] != "2" || stats["availability"] != "ready" || stats["hasAuthors"] != true || stats["authorId"] != "700" || !ok || len(daily) != 30 || daily[29] != "2" || !authorDailyOK || len(authorDaily) != 30 || authorDaily[29] != "1" || !authorOK || author["id"] != "700" {
		t.Fatalf("selected source statistics differ: %+v", stats)
	}
	legacyStats := read(statisticsPath)
	if legacyStats["projectTotal"] != "5" {
		t.Fatalf("implicit statistics changed sources: %+v", legacyStats)
	}
	if _, present := legacyStats["repository"]; present {
		t.Fatalf("implicit statistics gained source metadata: %+v", legacyStats)
	}
	emptyStats := read(statisticsPath + "&repositoryId=" + emptyID)
	source(emptyStats, emptyID, "owner/empty")
	if emptyStats["projectTotal"] != "0" || emptyStats["availability"] != "no_saved_data" || emptyStats["hasAuthors"] != false {
		t.Fatalf("historical source borrowed current synchronization state: %+v", emptyStats)
	}

	for _, expected := range []struct{ query, encoded, number string }{
		{"?limit=1", `{"v":1,"projectId":"` + projectID + `","state":"active","q":"","limit":1,"upperNumber":"9007199254740993","anchorNumber":"9007199254740993","direction":"next"}`, "3"},
		{"?state=all&limit=1&authorId=9007199254740997", `{"v":2,"projectId":"` + projectID + `","state":"all","q":"","limit":1,"upperNumber":"9007199254740993","anchorNumber":"9007199254740993","direction":"next","authorId":"9007199254740997"}`, "4"},
	} {
		encoded := base64.RawURLEncoding.EncodeToString([]byte(expected.encoded))
		page := read("/pull-requests" + expected.query + "&cursor=" + encoded)
		pr, ok := items(page, 1)[0].(map[string]any)
		if !ok || pr["number"] != expected.number {
			t.Fatalf("legacy cursor changed sources: %+v", page)
		}
	}
	oldAuthorCursor := base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"projectId":"` + projectID + `","q":"","limit":1,"revision":"7","nameKey":"renamed","authorId":"9007199254740997"}`))
	oldAuthors := read("/pull-request-authors?limit=1&cursor=" + oldAuthorCursor)
	oldAuthor, ok := items(oldAuthors, 1)[0].(map[string]any)
	if !ok || oldAuthor["id"] != "9007199254740998" || oldAuthor["login"] != "zeta" {
		t.Fatalf("legacy author cursor changed sources: %+v", oldAuthors)
	}
	if _, present := oldAuthors["repository"]; present {
		t.Fatalf("implicit authors gained source metadata: %+v", oldAuthors)
	}
	_, err = db.Exec(f.context, `UPDATE project_github SET repository_id=NULL,repository_full_name=NULL,
		installation_id=NULL,installation_account_login=NULL WHERE project_id=$1`, projectID)
	if err != nil {
		t.Fatal(err)
	}
	disconnected := read("/pull-request-repositories")
	if disconnected["currentRepositoryId"] != nil || disconnected["nextCursor"] != nil {
		t.Fatalf("disconnected directory current source differs: %+v", disconnected)
	}
	items(disconnected, 3)
	retained := read("/pull-requests/3?repositoryId=" + currentID)
	if retained["title"] != "Current source PR" || retained["description"] != "Current source description" {
		t.Fatalf("disconnected history differs: %+v", retained)
	}
}
