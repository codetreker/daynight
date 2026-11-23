//go:build integration

package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func serverAPIPromptNormalFlow(t *testing.T, f *fixture) {
	project := createProject(t, f, "Personal prompt API")
	workerID := uuid.NewString()
	path := "/api/v1/me/workers/" + workerID + "/report"
	stamp := "2026-10-29T00:00:00Z"
	probe := func(value any) map[string]any {
		return map[string]any{"state": "ok", "checkedAt": stamp, "value": value}
	}
	body := map[string]any{
		"machine": map[string]any{"id": uuid.NewString(), "name": "Integration machine"}, "platform": "linux", "workingDirectory": "/work", "sampledAt": stamp,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 12.5}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions":      map[string]any{"daynight": "1.0.0", "codex": map[string]any{"state": "not_installed", "checkedAt": stamp}, "copilot": map[string]any{"state": "error", "checkedAt": stamp, "code": "timeout"}},
		"taskInventory": nil, "configuration": map[string]any{"bootstrap": nil, "observation": nil, "toolPathsBootstrap": nil},
	}
	report := func(selectors string) []model.PromptResult {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(f.context, http.MethodPost, f.origin+path, bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Daynight-Worker-Configuration", "2")
		req.Header.Set("Daynight-Worker-Tool-Paths", "2")
		req.Header.Set("Daynight-Worker-Prompts", selectors)
		resp, err := f.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		data, readErr := io.ReadAll(resp.Body)
		closeErr := resp.Body.Close()
		if readErr != nil || closeErr != nil || resp.StatusCode != http.StatusOK || resp.Header.Get("Daynight-Worker-Configuration") != "2" {
			t.Fatalf("report: status=%d body=%s read=%v close=%v", resp.StatusCode, data, readErr, closeErr)
		}
		var receipt struct {
			Configuration struct {
				Prompts []model.PromptResult `json:"prompts"`
			} `json:"configuration"`
		}
		if err := json.Unmarshal(data, &receipt); err != nil {
			t.Fatal(err)
		}
		return receipt.Configuration.Prompts
	}
	report(`[]`) // Registers the Worker through its normal configuration report.
	paths := []string{"/api/v1/me/worker-prompt", "/api/v1/me/projects/" + project.ID + "/worker-prompt", "/api/v1/me/workers/" + workerID + "/prompt"}
	texts := []string{"user text", "project text", "worker text"}
	scopes := []model.PromptScope{model.PromptScopeUser, model.PromptScopeProject, model.PromptScopeWorker}
	ids := []string{f.userID, project.ID, workerID}
	for i, resourcePath := range paths {
		saved := requestJSON[model.PromptResource](t, f, http.MethodPut, resourcePath, map[string]any{"expectedUserId": f.userID, "revision": "0", "text": texts[i]}, http.StatusOK)
		read := requestJSON[model.PromptResource](t, f, http.MethodGet, resourcePath, nil, http.StatusOK)
		if saved.Scope != scopes[i] || saved.ScopeID != ids[i] || saved.Revision != "1" || saved.Text != texts[i] || !reflect.DeepEqual(read, saved) {
			t.Fatalf("prompt save/read: %+v %+v", saved, read)
		}
	}
	// Age the registered Worker past the active window without waiting on a clock.
	db, err := pgxpool.New(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	updated, err := db.Exec(f.context, `UPDATE workers SET last_seen_at=statement_timestamp()-interval '1 hour' WHERE user_id=$1 AND worker_id=$2`, f.userID, workerID)
	if err != nil || updated.RowsAffected() != 1 {
		t.Fatalf("age registered Worker: updated=%v error=%v", updated, err)
	}
	detail := requestJSON[api.WorkerDetailResponse](t, f, http.MethodGet, "/api/v1/me/workers/"+workerID, nil, http.StatusOK, http.Header{"Daynight-Worker-Tool-Paths": {"2"}})
	if detail.ObservedAt.Sub(detail.Worker.LastReportedAt) < 120*time.Second {
		t.Fatalf("Worker report remains active: %+v", detail)
	}
	reviewerPromptFlow(t, f, project.ID, workerID, paths, scopes, ids, texts)
	selectors := `[{"key":{"scope":"user"},"knownRevision":null},{"key":{"scope":"project","projectId":"` + project.ID + `"},"knownRevision":null},{"key":{"scope":"worker"},"knownRevision":null}]`
	results := report(selectors)
	if len(results) != 3 {
		t.Fatalf("prompt count: %+v", results)
	}
	for i, result := range results {
		if result.Status != "value" || result.Value == nil || result.Value.Scope != scopes[i] || result.Value.ScopeID != ids[i] || result.Value.Revision != "1" || result.Value.Text != texts[i] {
			t.Fatalf("prompt result %d: %+v", i, result)
		}
	}
	known := `[{"key":{"scope":"user"},"knownRevision":"1"},{"key":{"scope":"project","projectId":"` + project.ID + `"},"knownRevision":"1"},{"key":{"scope":"worker"},"knownRevision":"1"}]`
	unchanged := report(known)
	if len(unchanged) != 3 {
		t.Fatalf("unchanged count: %+v", unchanged)
	}
	for _, result := range unchanged {
		if result.Status != "unchanged" || result.Revision != "1" {
			t.Fatalf("unchanged: %+v", result)
		}
	}
	cleared := requestJSON[model.PromptResource](t, f, http.MethodPut, paths[1], map[string]any{"expectedUserId": f.userID, "revision": "1", "text": ""}, http.StatusOK)
	results = report(known)
	if cleared.Revision != "2" || cleared.Text != "" || len(results) != 3 || results[1].Status != "value" || results[1].Value == nil || results[1].Value.Revision != "2" || results[1].Value.Text != "" {
		t.Fatalf("clear/sync: %+v %+v", cleared, results)
	}
}

// reviewerPromptFlow uses the same Project and offline Worker as the development
// resources, so each read demonstrates the persisted purpose and account key.
func reviewerPromptFlow(t *testing.T, f *fixture, projectID, workerID string, developmentPaths []string, scopes []model.PromptScope, ids, developmentTexts []string) {
	t.Helper()
	paths := []string{"/api/v1/me/reviewer-prompt", "/api/v1/me/projects/" + projectID + "/reviewer-prompt", "/api/v1/me/workers/" + workerID + "/reviewer-prompt"}
	put := func(client *fixture, path, userID, revision, text string, status int) model.PromptResource {
		t.Helper()
		return requestJSON[model.PromptResource](t, client, http.MethodPut, path, map[string]any{"expectedUserId": userID, "revision": revision, "text": text}, status)
	}
	read := func(client *fixture, path string) model.PromptResource {
		t.Helper()
		return requestJSON[model.PromptResource](t, client, http.MethodGet, path, nil, http.StatusOK)
	}
	reject := func(client *fixture, path, userID, revision, text string, status int, code string) {
		t.Helper()
		result := requestJSON[api.ErrorResponse](t, client, http.MethodPut, path, map[string]any{"expectedUserId": userID, "revision": revision, "text": text}, status)
		if result.Error.Code != code {
			t.Fatalf("%s: expected %s, got %+v", path, code, result.Error)
		}
	}
	for i, path := range paths {
		empty := read(f, path)
		if empty.Scope != scopes[i] || empty.ScopeID != ids[i] || empty.Revision != "0" || empty.Text != "" || empty.UpdatedAt != nil {
			t.Fatalf("%s virtual resource: %+v", path, empty)
		}
		response, head := f.request(t, http.MethodHead, path, "", nil, http.StatusOK)
		if len(head) != 0 || response.Header.Get("Daynight-User-ID") != f.userID || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("%s HEAD: headers=%v body=%q", path, response.Header, head)
		}
		current := put(f, path, f.userID, "0", "reviewer "+string(scopes[i]), http.StatusOK)
		if current.Revision != "1" || current.Scope != scopes[i] || current.ScopeID != ids[i] || !reflect.DeepEqual(current, read(f, path)) {
			t.Fatalf("%s initial Reviewer save/read differs", path)
		}
		for _, body := range []string{strings.Repeat("a", 32768), strings.Repeat("界", 10922) + "ab", strings.Repeat("\"", 32766) + "\n<"} {
			current = put(f, path, f.userID, current.Revision, body, http.StatusOK)
			if current.Text != body || !reflect.DeepEqual(current, read(f, path)) {
				t.Fatalf("%s did not retain %d UTF-8 bytes", path, len(body))
			}
			reject(f, path, f.userID, current.Revision, body+"x", http.StatusBadRequest, "invalid_input")
			if !reflect.DeepEqual(current, read(f, path)) {
				t.Fatalf("%s changed after rejecting 32769 bytes", path)
			}
		}
		reject(f, path, f.userID, "0", "stale", http.StatusConflict, "version_conflict")
		reject(f, path, uuid.NewString(), current.Revision, "wrong account", http.StatusConflict, "identity_mismatch")
		if !reflect.DeepEqual(current, read(f, path)) {
			t.Fatalf("%s changed after rejected writes", path)
		}
		// Both writes use the same observed revision; exactly one may commit.
		type outcome struct {
			status int
			body   []byte
			err    error
		}
		outcomes := make(chan outcome, 2)
		for _, text := range []string{"concurrent one", "concurrent two"} {
			encoded, err := json.Marshal(map[string]any{"expectedUserId": f.userID, "revision": current.Revision, "text": text})
			if err != nil {
				t.Fatal(err)
			}
			go func() {
				req, err := http.NewRequestWithContext(f.context, http.MethodPut, f.origin+path, bytes.NewReader(encoded))
				if err != nil {
					outcomes <- outcome{err: err}
					return
				}
				req.Header.Set("Content-Type", "application/json")
				resp, err := f.client.Do(req)
				if err != nil {
					outcomes <- outcome{err: err}
					return
				}
				data, err := io.ReadAll(resp.Body)
				if closeErr := resp.Body.Close(); err == nil {
					err = closeErr
				}
				outcomes <- outcome{status: resp.StatusCode, body: data, err: err}
			}()
		}
		var success model.PromptResource
		wins, conflicts := 0, 0
		for range 2 {
			result := <-outcomes
			if result.err != nil {
				t.Fatal(result.err)
			}
			switch result.status {
			case http.StatusOK:
				wins++
				if err := json.Unmarshal(result.body, &success); err != nil {
					t.Fatal(err)
				}
			case http.StatusConflict:
				var failure api.ErrorResponse
				if err := json.Unmarshal(result.body, &failure); err != nil || failure.Error.Code != "version_conflict" {
					t.Fatalf("concurrent conflict: %s (%v)", result.body, err)
				}
				conflicts++
			default:
				t.Fatalf("concurrent write: status=%d body=%s", result.status, result.body)
			}
		}
		if wins != 1 || conflicts != 1 || success.Revision != "5" || (success.Text != "concurrent one" && success.Text != "concurrent two") || !reflect.DeepEqual(success, read(f, path)) {
			t.Fatalf("%s concurrent writes: wins=%d conflicts=%d saved=%+v", path, wins, conflicts, success)
		}
		cleared := put(f, path, f.userID, success.Revision, "", http.StatusOK)
		if cleared.Text != "" || cleared.Revision != "6" || !reflect.DeepEqual(cleared, read(f, path)) {
			t.Fatalf("%s clear did not persist: %+v", path, cleared)
		}
		development := read(f, developmentPaths[i])
		if development.Scope != scopes[i] || development.ScopeID != ids[i] || development.Revision != "1" || development.Text != developmentTexts[i] {
			t.Fatalf("%s development resource changed: %+v", path, development)
		}
	}

	// A second UniAuth account receives a separate value for the same Project;
	// removing its grant immediately makes that value inaccessible.
	team := requestJSON[api.Team](t, f, http.MethodPost, "/api/v1/teams", api.CreateTeamRequest{Name: "Prompt account", ExpectedUserID: f.userID}, http.StatusCreated)
	externalID := "prompt:" + uuid.NewString()
	added := requestJSON[api.AddTeamMemberReceipt](t, f, http.MethodPost, "/api/v1/teams/"+team.ID+"/members", map[string]any{"expectedUserId": f.userID, "user": map[string]any{"externalUserId": externalID, "profile": map[string]any{"name": "Prompt account"}}, "role": "member"}, http.StatusOK)
	plain := &http.Client{Timeout: 5 * time.Second}
	defer plain.CloseIdleConnections()
	body, err := json.Marshal(map[string]any{"externalUserId": externalID})
	if err != nil {
		t.Fatal(err)
	}
	_, tokenData := applicationRequest(t, f, plain, "/api/v1/oauth/s2s/token", string(body), "application/json", "S2S "+f.s2sSharedKey)
	var tokens applicationTokens
	if err := json.Unmarshal(tokenData, &tokens); err != nil || tokens.UserID != added.Membership.UserID {
		t.Fatal("second account token differs")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	other := *f
	other.client = &http.Client{Timeout: 5 * time.Second, Transport: tokenTransport{token: tokens.AccessToken, next: transport}}
	other.userID = tokens.UserID
	projectPath := "/api/v1/projects/" + projectID
	grantPath := projectPath + "/grants/" + other.userID
	member := requestJSON[struct {
		Added       bool                   `json:"added"`
		Participant api.ProjectParticipant `json:"participant"`
	}](t, f, http.MethodPost, projectPath+"/members/"+other.userID, map[string]any{"expectedUserId": f.userID}, http.StatusOK)
	if !member.Added || member.Participant.UserID != other.userID || member.Participant.DirectGrant == nil || member.Participant.DirectGrant.Role != "member" {
		t.Fatalf("second account Project membership: %+v", member)
	}
	for _, path := range paths[:2] {
		initial := read(&other, path)
		if initial.Revision != "0" || initial.Text != "" {
			t.Fatalf("second account initial %s: %+v", path, initial)
		}
		saved := put(&other, path, other.userID, "0", "second account", http.StatusOK)
		if saved.Revision != "1" || saved.Text != "second account" || !reflect.DeepEqual(saved, read(&other, path)) {
			t.Fatalf("second account %s: %+v", path, saved)
		}
		if owner := read(f, path); owner.Revision != "6" || owner.Text != "" {
			t.Fatalf("owner value changed: %+v", owner)
		}
	}
	requestJSON[api.ErrorResponse](t, &other, http.MethodGet, paths[2], nil, http.StatusNotFound)
	requestJSON[api.RemoveProjectGrantResult](t, f, http.MethodDelete, grantPath, map[string]any{"version": member.Participant.DirectGrant.Version, "expectedUserId": f.userID}, http.StatusOK)
	requestJSON[api.ErrorResponse](t, &other, http.MethodGet, paths[1], nil, http.StatusNotFound)
	reject(&other, paths[1], other.userID, "1", "after revocation", http.StatusNotFound, "not_found")
}
