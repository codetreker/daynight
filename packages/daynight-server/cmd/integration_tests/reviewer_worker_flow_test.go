//go:build integration

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

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
func serverAPIReviewerWorkerFlow(t *testing.T, f *fixture, projectID, workerID string, commits reviewerFixtureCommits) {
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
	target, err := url.Parse(f.origin)
	if err != nil {
		t.Fatal(err)
	}
	forward := httputil.NewSingleHostReverseProxy(target)
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
	state, publication, input, requests := filepath.Join(root, "state.json"), filepath.Join(root, "publication.json"), filepath.Join(root, "input.json"), filepath.Join(root, "requests.jsonl")
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
	cmd := exec.Command(node, cli, "worker", "run")
	cmd.Dir = root
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}

	cmd.Env = append(cmd.Env, "HOME="+home, "TMPDIR="+root, "PATH="+binDir+string(os.PathListSeparator)+filepath.Dir(node)+string(os.PathListSeparator)+os.Getenv("PATH"), "DN_CONFIG_DIR="+configDir, "GIT_CONFIG_GLOBAL="+gitConfig, "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "NO_PROXY=127.0.0.1,localhost", "REVIEW_FIXTURE_STATE="+state, "REVIEW_FIXTURE_PUBLICATION="+publication, "REVIEW_FIXTURE_INPUT="+input, "REVIEW_FIXTURE_REQUESTS="+requests)
	logs := &processLog{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	stopped := false
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
	t.Cleanup(stop)
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
	if before != after || registrations.Load() != 0 {
		t.Fatalf("Reviewer attempted or registered a Daynight Session: requests=%d before=%d after=%d", registrations.Load(), before, after)
	}
	t.Logf("Reviewer worker=%s project=%s repository=42 PR=1 head=%s publication=%s SQLite=%s/%s; Sessions before=%d after=%d", workerID, projectID, commits.head, published.ID, observed[0].Status, observed[0].Phase, before, after)
}
