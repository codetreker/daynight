//go:build integration

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5/pgxpool"
)

type reviewerFixtureCommits struct{ root, bare, checkout, base, head string }

func reviewerCommand(t *testing.T, dir, file string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, file, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("fixture command %s: %v: %s", file, err, out)
	}
	return strings.TrimSpace(string(out))
}

// Both the server's synchronization and the Worker's checkout use these real objects.
func prepareReviewerFixtureGit(t *testing.T) reviewerFixtureCommits {
	t.Helper()
	root := filepath.Join(integrationRunRoot(t), "reviewer-worker")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	work, bare, checkout := filepath.Join(root, "seed"), filepath.Join(root, "remote.git"), filepath.Join(root, "worker-checkout")
	reviewerCommand(t, root, "git", "init", "--initial-branch=trunk", work)
	reviewerCommand(t, work, "git", "config", "user.name", "Integration")
	reviewerCommand(t, work, "git", "config", "user.email", "integration@example.invalid")
	if err := os.WriteFile(filepath.Join(work, "file.txt"), []byte("base\n"), 0600); err != nil {
		t.Fatal(err)
	}
	reviewerCommand(t, work, "git", "add", "file.txt")
	reviewerCommand(t, work, "git", "commit", "-m", "base")
	base := reviewerCommand(t, work, "git", "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(work, "file.txt"), []byte("review target\n"), 0600); err != nil {
		t.Fatal(err)
	}
	reviewerCommand(t, work, "git", "commit", "-am", "review target")
	head := reviewerCommand(t, work, "git", "rev-parse", "HEAD")
	reviewerCommand(t, root, "git", "init", "--bare", "--initial-branch=trunk", bare)
	reviewerCommand(t, work, "git", "push", bare, base+":refs/heads/trunk", head+":refs/pull/1/head")
	reviewerCommand(t, root, "git", "clone", bare, checkout)
	reviewerCommand(t, checkout, "git", "remote", "set-url", "origin", "https://github.com/example/integration.git")
	return reviewerFixtureCommits{root, bare, checkout, base, head}
}

// Reviewer runs as the built Worker process against the real service; the two
// executables simulate only GitHub and Copilot and persist independent receipts.
func serverAPIReviewerWorkerFlow(t *testing.T, f *fixture, projectID, workerID, enabledVersion string, commits reviewerFixtureCommits) string {
	t.Helper()
	node, cli := os.Getenv("DAYNIGHT_INTEGRATION_NODE_PATH"), os.Getenv("DAYNIGHT_INTEGRATION_CLI_PATH")
	if node == "" || cli == "" || !filepath.IsAbs(node) || !filepath.IsAbs(cli) {
		t.Fatal("integration runner must provide absolute Node and built CLI paths")
	}
	for _, file := range []string{node, cli} {
		if _, err := os.Stat(file); err != nil {
			t.Fatal(err)
		}
	}
	const prompt = "Reviewer integration instruction: inspect this exact target."
	saved := requestJSON[model.PromptResource](t, f, http.MethodPut, "/api/v1/me/reviewer-prompt", map[string]any{"expectedUserId": f.userID, "revision": "0", "text": prompt}, http.StatusOK)
	read := requestJSON[model.PromptResource](t, f, http.MethodGet, "/api/v1/me/reviewer-prompt", nil, http.StatusOK)
	if saved.Revision != "1" || read.Text != prompt || read.Revision != saved.Revision {
		t.Fatalf("review prompt not persisted: %+v", read)
	}
	var registrations atomic.Int64
	var disabledPolls atomic.Int64
	target, err := url.Parse(f.origin)
	if err != nil {
		t.Fatal(err)
	}
	forward := httputil.NewSingleHostReverseProxy(target)
	forward.ModifyResponse = func(response *http.Response) error {
		if response.StatusCode != http.StatusOK || response.Request.URL.Path != "/api/v1/me/workers/"+workerID+"/review-pull-requests" {
			return nil
		}
		body, err := io.ReadAll(response.Body)
		if err != nil {
			return err
		}
		response.Body = io.NopCloser(bytes.NewReader(body))
		var result struct {
			ReviewEnabled bool `json:"reviewEnabled"`
		}
		if json.Unmarshal(body, &result) == nil && !result.ReviewEnabled {
			disabledPolls.Add(1)
		}
		return nil
	}
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && (strings.Contains(r.URL.Path, "/sessions") || strings.Contains(r.URL.Path, "/test-sessions")) {
			registrations.Add(1)
		}
		r.Host = target.Host
		forward.ServeHTTP(w, r)
	}))
	t.Cleanup(proxy.Close)
	root := commits.root
	configDir, binDir, home := filepath.Join(root, "config"), filepath.Join(root, "bin"), filepath.Join(root, "home")
	for _, dir := range []string{configDir, binDir, home} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"gh", "copilot"} {
		data, err := os.ReadFile(filepath.Join("testdata", "reviewer", name+".cjs"))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(binDir, name), data, 0700); err != nil {
			t.Fatal(err)
		}
	}
	peer, err := os.ReadFile(filepath.Join("..", "..", "..", "e2e_tests", "tests", "native-worker-peer.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "codex.mjs"), peer, 0700); err != nil {
		t.Fatal(err)
	}
	peerLog := filepath.Join(root, "codex-events.jsonl")
	state, publication, input, requests := filepath.Join(root, "state.json"), filepath.Join(root, "publication.json"), filepath.Join(root, "input.json"), filepath.Join(root, "requests.jsonl")
	block, starts, stoppedReview := filepath.Join(root, "block-review"), filepath.Join(root, "review-starts"), filepath.Join(root, "review-stopped")
	if err := os.WriteFile(block, []byte("block"), 0600); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]string{"base": commits.base, "head": commits.head})
	if err := os.WriteFile(state, data, 0600); err != nil {
		t.Fatal(err)
	}
	// JSON string values are valid YAML scalars and avoid path/credential quoting ambiguity.
	quote := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	token := f.client.Transport.(tokenTransport).token
	config := fmt.Sprintf("serverUrl: %s\nserverToken: %s\nworkerId: %s\nworker:\n  repositories:\n    - projectId: %s\n      remote: %s\n      path: %s\n", quote(proxy.URL), quote(token), quote(workerID), quote(projectID), quote("https://github.com/example/integration.git"), quote(commits.checkout))
	if err := os.WriteFile(filepath.Join(configDir, "config.yml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	gitConfig := filepath.Join(root, "gitconfig")
	fileURL := (&url.URL{Scheme: "file", Path: commits.bare}).String()
	gitConfigBody := fmt.Sprintf("[url %s]\n    insteadOf = https://github.com/example/integration.git\n[protocol \"file\"]\n    allow = always\n", quote(fileURL))
	if err := os.WriteFile(gitConfig, []byte(gitConfigBody), 0600); err != nil {
		t.Fatal(err)
	}
	db, err := pgxpool.New(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var before int
	if err := db.QueryRow(f.context, "SELECT count(*) FROM task_sessions WHERE project_id=$1", projectID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	logs := &processLog{}
	var cmd *exec.Cmd
	var exited chan error
	stopped := false
	start := func() {
		cmd = exec.Command(node, cli, "worker", "run")
		cmd.Dir = root
		cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
		cmd.Env = []string{"HOME=" + home, "CODEX_HOME=" + filepath.Join(root, "native"), "DAYNIGHT_WORKER_PEER_LOG=" + peerLog, "TMPDIR=" + root, "PATH=" + binDir + string(os.PathListSeparator) + filepath.Dir(node) + string(os.PathListSeparator) + os.Getenv("PATH"), "DN_CONFIG_DIR=" + configDir, "GIT_CONFIG_GLOBAL=" + gitConfig, "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "NO_PROXY=127.0.0.1,localhost", "REVIEW_FIXTURE_STATE=" + state, "REVIEW_FIXTURE_PUBLICATION=" + publication, "REVIEW_FIXTURE_INPUT=" + input, "REVIEW_FIXTURE_REQUESTS=" + requests, "REVIEW_FIXTURE_BLOCK=" + block, "REVIEW_FIXTURE_STARTS=" + starts, "REVIEW_FIXTURE_STOPPED=" + stoppedReview}
		cmd.Stdout, cmd.Stderr = logs, logs
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		exited = make(chan error, 1)
		process, done := cmd, exited
		go func() { done <- process.Wait() }()
		stopped = false
	}
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case err := <-exited:
			if err != nil {
				t.Errorf("review Worker did not stop cleanly: %v\n%s", err, logs.String())
			}
		case <-time.After(15 * time.Second):
			_ = cmd.Process.Kill()
			<-exited
			t.Error("review Worker did not stop in time")
		}
	}
	start()
	t.Cleanup(stop)
	assignmentPath := "/api/v1/projects/" + projectID + "/pull-requests/1/review-assignment"
	assignmentBefore := requestJSON[reviewAssignmentResponse](t, f, http.MethodGet, assignmentPath, nil, http.StatusOK)
	waitFor := func(description string, predicate func() bool) {
		t.Helper()
		deadline := time.NewTimer(90 * time.Second)
		defer deadline.Stop()
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for !predicate() {
			select {
			case err := <-exited:
				stopped = true
				t.Fatalf("review Worker exited while %s: %v\n%s", description, err, logs.String())
			case <-deadline.C:
				t.Fatalf("timed out %s\n%s", description, logs.String())
			case <-ticker.C:
			}
		}
	}
	waitFor("waiting for the review process to start", func() bool { _, err := os.Stat(starts); return err == nil })
	type participation struct {
		Enabled bool   `json:"enabled"`
		Version string `json:"version"`
	}
	participationPath := "/api/v1/me/workers/" + workerID + "/review-participation"
	disabled := requestJSON[participation](t, f, http.MethodPut, participationPath, map[string]any{"enabled": false, "expectedVersion": enabledVersion}, http.StatusOK)
	if disabled.Enabled {
		t.Fatalf("review was not disabled: %+v", disabled)
	}
	waitFor("waiting for a disabled poll and review termination", func() bool {
		data, err := os.ReadFile(stoppedReview)
		if err != nil || disabledPolls.Load() == 0 {
			return false
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
		return err == nil && syscall.Kill(pid, 0) == syscall.ESRCH
	})
	// Start a normal task only after the running review has stopped. The same
	// Worker must claim it and deliver its input to the controlled native peer.
	task := createTask(t, f, api.Project{ID: projectID}, "Development while review is disabled", map[string]any{"assignedTo": f.userID, "status": "todo"})
	task = requestJSON[api.Task](t, f, http.MethodPatch, taskPath(task), map[string]any{"version": task.Version, "allowAgents": true}, http.StatusOK)
	var active api.Task
	waitFor("waiting for the same Worker to execute the development task", func() bool {
		active = requestJSON[api.Task](t, f, http.MethodGet, taskPath(task), nil, http.StatusOK)
		if active.Status != "in_progress" || active.Properties["worker"] == nil {
			return false
		}
		claim := workerClaim(t, active)
		data, err := os.ReadFile(peerLog)
		return err == nil && claim.WorkerID == workerID && claim.NativeSessionID != nil && strings.Contains(string(data), `"method":"turn/start"`) && strings.Contains(string(data), "Assignment:")
	})
	claim := workerClaim(t, active)
	var completed api.Task
	for attempt := 0; attempt < 3; attempt++ {
		current := requestJSON[api.Task](t, f, http.MethodGet, taskPath(task), nil, http.StatusOK)
		if current.Status != "in_progress" || workerClaim(t, current).ClaimID != claim.ClaimID || workerClaim(t, current).WorkerID != workerID {
			t.Fatalf("development task assignment changed before completion: %+v", current)
		}
		body, err := json.Marshal(api.TaskStatusUpdateRequest{Version: current.Version, Status: "done", ClaimID: &claim.ClaimID})
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequestWithContext(f.context, http.MethodPut, f.origin+taskPath(task)+"/status", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := f.client.Do(request)
		if err != nil {
			t.Fatalf("development completion result unknown: %v", err)
		}
		data, readErr := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if readErr != nil || closeErr != nil {
			t.Fatalf("development completion response: %v %v", readErr, closeErr)
		}
		if response.StatusCode == http.StatusConflict {
			var failure api.ErrorResponse
			if err := json.Unmarshal(data, &failure); err != nil || failure.Error.Code != "version_conflict" {
				t.Fatalf("development completion refused: %s", data)
			}
			continue
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("development completion returned %d: %s", response.StatusCode, data)
		}
		if err := json.Unmarshal(data, &completed); err != nil {
			t.Fatal(err)
		}
		break
	}
	if completed.Status != "done" {
		t.Fatal("development completion conflicted three times")
	}
	if workerClaim(t, completed).State != "completed" {
		t.Fatalf("development task did not complete under its original claim: %+v", completed)
	}
	waitFor("waiting for a second disabled poll", func() bool { return disabledPolls.Load() >= 2 })
	// The coordinator has processed a further poll with review disabled.
	time.Sleep(3 * time.Second)
	started, err := os.ReadFile(starts)
	if err != nil || len(strings.Fields(string(started))) != 1 {
		t.Fatalf("unexpected review starts after disabling: %q, %v", started, err)
	}
	retained := requestJSON[reviewAssignmentResponse](t, f, http.MethodGet, assignmentPath, nil, http.StatusOK)
	if assignmentBefore.Assignment == nil || retained.Assignment == nil || retained.Assignment.WorkerID != workerID || !retained.Assignment.AssignedAt.Equal(assignmentBefore.Assignment.AssignedAt) || retained.Assignment.ReviewEnabled == nil || *retained.Assignment.ReviewEnabled {
		t.Fatalf("assignment was not retained while disabled: before=%+v after=%+v", assignmentBefore, retained)
	}
	if err := os.Remove(block); err != nil {
		t.Fatal(err)
	}
	// Restart the same Worker so the normal publication flow need not wait for a
	// third minute-interval poll after re-enablement.
	stop()
	reenabled := requestJSON[participation](t, f, http.MethodPut, participationPath, map[string]any{"enabled": true, "expectedVersion": disabled.Version}, http.StatusOK)
	if !reenabled.Enabled {
		t.Fatalf("review was not reenabled: %+v", reenabled)
	}
	start()
	t.Logf("Review process stopped after disabled poll; no subsequent start; assignment retained, participation %s -> %s -> %s", enabledVersion, disabled.Version, reenabled.Version)
	sqlite := filepath.Join(configDir, "reviewer", "state.sqlite")
	// Query a separate SQLite connection, so successful process output alone
	// cannot satisfy the publication verification assertion.
	query := `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});const rows=d.prepare("SELECT r.number,r.head_sha,r.status,p.phase,p.outcome,p.remote_review_id FROM reviews r JOIN review_publications p ON p.review_id=r.id").all();d.close();process.stdout.write(JSON.stringify(rows));`
	deadline := time.NewTimer(90 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var observed []struct {
		Number  int    `json:"number"`
		Head    string `json:"head_sha"`
		Status  string `json:"status"`
		Phase   string `json:"phase"`
		Outcome string `json:"outcome"`
		Remote  string `json:"remote_review_id"`
	}
	for {
		if _, err := os.Stat(sqlite); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			result, err := exec.CommandContext(ctx, node, "-e", query, sqlite).Output()
			cancel()
			if err == nil && json.Unmarshal(result, &observed) == nil && len(observed) == 1 && observed[0].Status == "completed" && observed[0].Phase == "verified" {
				break
			}
		}
		select {
		case err := <-exited:
			stopped = true
			t.Fatalf("review Worker exited before confirmation: %v\n%s", err, logs.String())
		case <-deadline.C:
			t.Fatalf("review Worker did not verify publication: state=%+v\n%s", observed, logs.String())
		case <-ticker.C:
		}
	}
	stop()
	if observed[0].Number != 1 || observed[0].Head != commits.head || observed[0].Outcome != "approved" || observed[0].Remote != "fixture-review" {
		t.Fatalf("unexpected SQLite receipt: %+v", observed)
	}
	var received struct{ Prompt, SHA, Session string }
	raw, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &received); err != nil {
		t.Fatal(err)
	}
	if received.SHA != commits.head || !strings.Contains(received.Prompt, prompt) || received.Session == "" {
		t.Fatalf("Copilot input did not retain prompt and checkout: sha=%s session=%q promptPresent=%v", received.SHA, received.Session, strings.Contains(received.Prompt, prompt))
	}
	var published struct {
		ID, Body, State string
		Commit          struct{ OID string }
	}
	raw, err = os.ReadFile(publication)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &published); err != nil {
		t.Fatal(err)
	}
	if published.ID != "fixture-review" || published.State != "APPROVED" || published.Commit.OID != commits.head || !strings.Contains(published.Body, "daynight review=") {
		t.Fatalf("published fixture receipt differs: %+v", published)
	}
	raw, err = os.ReadFile(requests)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(raw), `"type":"reviews"`) < 2 || strings.Contains(string(raw), "pulls/2") {
		t.Fatalf("missing independent review readback or unexpected PR: %s", raw)
	}
	var after int
	if err := db.QueryRow(f.context, "SELECT count(*) FROM task_sessions WHERE project_id=$1", projectID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before+1 || registrations.Load() == 0 {
		t.Fatalf("development Session was not registered: requests=%d before=%d after=%d", registrations.Load(), before, after)
	}
	t.Logf("Reviewer worker=%s project=%s repository=42 PR=1 head=%s publication=%s SQLite=%s/%s; Sessions before=%d after=%d", workerID, projectID, commits.head, published.ID, observed[0].Status, observed[0].Phase, before, after)
	return reenabled.Version
}
