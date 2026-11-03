package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/google/uuid"
)

func TestInstalledCLIThreadAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_thread", []string{"Thread-R1", "Thread-R2", "Thread-R3", "Thread-R4", "Thread-R5", "Thread-R6"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		project := process.project(t, "Installed Thread CLI")
		task := process.task(t, project, "Persistent discussion")
		path := acceptanceTaskPath(task) + "/thread/messages"
		read := func(arguments ...string) string {
			return cli.run(t, cli.caller, append([]string{"task", "thread", "read", task.ID, "--project", project.ID}, arguments...)...)
		}
		post := func(body string, arguments ...string) string {
			return cli.run(t, cli.caller, append([]string{"task", "thread", "post", task.ID, "--project", project.ID, "--body", body}, arguments...)...)
		}
		if output := read(); output != "No messages.\n" {
			t.Fatal("empty installed Thread read did not return its text contract")
		}
		body := "  <>& 中文😀\n\tIndent\r\n\x1b[31m\u2028\u2029\\u001b\nId: forged\nHas more messages after...  "
		firstID := acceptanceThreadPostedID(t, post(body), "")
		firstPage := acceptanceDecode[api.ThreadPage](t, process.request(context.Background(), http.MethodGet, path, nil, "thread-first-read"), http.StatusOK)
		if len(firstPage.Items) != 1 || firstPage.Items[0].ID != firstID || firstPage.Items[0].Body != body || firstPage.Items[0].Author.Agent || firstPage.Items[0].Author.Execution != nil {
			t.Fatal("installed Thread post did not preserve the real server resource")
		}
		first := firstPage.Items[0]
		if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`).MatchString(first.CreatedAt) {
			t.Fatal("real Thread producer did not emit fixed millisecond UTC")
		}
		output := read()
		if !slices.Equal(acceptanceThreadReadIDs(t, output), []string{firstID}) || !strings.Contains(output, "CreatedAt: "+first.CreatedAt+"\n") || !strings.Contains(output, "  \tIndent\\r\n") || !strings.Contains(output, `\u001b[31m\u2028\u2029\\u001b`) || strings.Contains(output, "\x1b") || strings.Contains(output, "\u2028") || strings.Contains(output, "\u2029") || strings.Contains(output, "\nId: forged\n") {
			t.Fatal("installed Thread rendering changed producer time or exposed unsafe controls and forged boundaries")
		}
		replyID := acceptanceThreadPostedID(t, post("A referenced answer", "--reply-to", strings.ToUpper(firstID)), firstID)
		if output := read("--after-id", firstID, "--count=1"); !slices.Equal(acceptanceThreadReadIDs(t, output), []string{replyID}) || !strings.Contains(output, "ReplyTo: "+firstID+"\n") {
			t.Fatal("installed reply or count=1 incremental read lost its actual boundary")
		}
		if output := read("--before-id", replyID, "--count", "1"); !slices.Equal(acceptanceThreadReadIDs(t, output), []string{firstID}) || !strings.Contains(output, "Has more messages after...\n") {
			t.Fatal("installed history read did not exclude its boundary or preserve direction")
		}
		if output := read("--after-id", replyID); output != "No new messages.\n" {
			t.Fatal("empty incremental installed read invented a new boundary")
		}
		fixture.exec(t, `UPDATE users SET name=NULL WHERE id=$1`, first.Author.UserID)
		nullID := acceptanceThreadPostedID(t, post("Name snapshot is nullable"), "")
		page := acceptanceDecode[api.ThreadPage](t, process.request(context.Background(), http.MethodGet, path, nil, "thread-name-snapshot"), http.StatusOK)
		if len(page.Items) != 3 || page.Items[0].Author.DisplayName == nil || page.Items[2].Author.DisplayName != nil {
			t.Fatal("renaming the author changed an immutable snapshot or fabricated a nullable name")
		}
		if output := read("--after-id", replyID); !slices.Equal(acceptanceThreadReadIDs(t, output), []string{nullID}) || !strings.Contains(output, "("+first.Author.UserID+")\n") {
			t.Fatal("nullable author snapshot became unreadable")
		}
		b := acceptanceDecode[api.ThreadMessage](t, process.request(context.Background(), http.MethodPost, path, map[string]any{"body": "B was not yet observed"}, "thread-unseen-b"), http.StatusCreated)
		cID := acceptanceThreadPostedID(t, post("C is locally posted"), "")
		if output := read("--after-id", nullID); !slices.Equal(acceptanceThreadReadIDs(t, output), []string{b.ID, cID}) {
			t.Fatal("a POST receipt skipped the unseen message in subsequent incremental reading")
		}
		if after := process.readTask(t, task); !reflect.DeepEqual(after, task) {
			t.Fatal("Thread CLI changed its Task version, timestamps, state or properties")
		}
		acceptanceThreadAgentCLI(t, fixture, process, cli, project, first.Author.UserID)
		acceptanceThreadPaginationCLI(t, fixture, process, cli, project, first.Author.UserID)
		acceptanceThreadBytesCLI(t, process, cli, project)
		acceptanceThreadRefusalsCLI(t, fixture, process, cli, project, task)
		process.signal(t)
		process.stopped(t, 0)
	})
}

func acceptanceThreadPostedID(t *testing.T, output, replyTo string) string {
	t.Helper()
	lines := strings.Split(strings.TrimSuffix(output, "\n"), "\n")
	if len(lines) < 2 || lines[0] != "Message posted." {
		t.Fatal("installed Thread POST did not return a confirmation receipt")
	}
	id, ok := strings.CutPrefix(lines[1], "Id: ")
	if !ok || uuid.Validate(id) != nil || id != strings.ToLower(id) {
		t.Fatal("installed Thread receipt did not expose a complete canonical database message UUID")
	}
	if replyTo == "" && len(lines) != 2 || replyTo != "" && (len(lines) != 3 || lines[2] != "ReplyTo: "+replyTo) {
		t.Fatal("installed Thread receipt echoed body or lost its reply reference")
	}
	return id
}

func acceptanceThreadReadIDs(t *testing.T, output string) []string {
	t.Helper()
	var ids []string
	for _, line := range strings.Split(output, "\n") {
		if id, found := strings.CutPrefix(line, "Id: "); found {
			if uuid.Validate(id) != nil || slices.Contains(ids, id) {
				t.Fatal("installed Thread output has an invalid or repeated message boundary")
			}
			ids = append(ids, id)
		}
	}
	return ids
}

func acceptanceThreadAgentCLI(t *testing.T, fixture *acceptanceFixture, process *acceptanceProcess, cli *acceptanceCLI, project api.Project, userID string) {
	t.Helper()
	created := process.request(context.Background(), http.MethodPost, acceptanceTasksPath(project.ID), map[string]any{"title": "Explicit Agent source", "assignedTo": userID}, "thread-agent-task")
	task := acceptanceDecode[api.Task](t, created, http.StatusCreated)
	if created.header.Get("Location") != acceptanceTaskPath(task) || task.ProjectID != project.ID || task.Version != 1 || task.Status != "todo" || task.Ready != (len(task.BlockedBy) == 0) || task.AssignedTo == nil || *task.AssignedTo != userID || task.AllowAgents {
		t.Fatal("Agent source task creation lost its metadata, assigned account or disabled initial permission")
	}
	task = process.update(t, task, map[string]any{"allowAgents": true})
	claimID, workerID := uuid.NewString(), uuid.NewString()
	task = acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodPost, acceptanceTaskPath(task)+"/worker-claim", map[string]any{
		"version": task.Version, "claimId": claimID, "workerId": workerID, "machine": map[string]any{"id": uuid.NewString(), "name": "Thread acceptance"},
		"platform": "linux", "agent": "codex", "worktreeId": uuid.NewString(),
	}, "thread-agent-claim"), http.StatusOK)
	id := acceptanceThreadPostedID(t, cli.run(t, cli.caller, "task", "thread", "post", task.ID, "--project", project.ID, "--body", "Agent explicitly replies", "--claim-id", claimID), "")
	path := acceptanceTaskPath(task) + "/thread/messages"
	page := acceptanceDecode[api.ThreadPage](t, process.request(context.Background(), http.MethodGet, path, nil, "thread-agent-default"), http.StatusOK)
	if len(page.Items) != 1 || !page.Items[0].Author.Agent || page.Items[0].Author.Execution != nil {
		t.Fatal("real default producer lost Agent attribution or exposed detailed source")
	}
	plain := cli.run(t, cli.caller, "task", "thread", "read", task.ID, "--project", project.ID)
	details := cli.run(t, cli.caller, "task", "thread", "read", task.ID, "--project", project.ID, "--details")
	if !slices.Equal(acceptanceThreadReadIDs(t, plain), []string{id}) || !strings.Contains(plain, "Agent: True\n") || strings.Contains(plain, claimID) || !strings.Contains(details, "Execution ClaimId: "+claimID+"\n") || !strings.Contains(details, "Execution WorkerId: "+workerID+"\n") || !strings.Contains(details, "Execution Provider: codex\n") {
		t.Fatal("installed default/details Agent presentation disagrees with verified server source")
	}
	if after := process.readTask(t, task); !reflect.DeepEqual(after, task) {
		t.Fatal("Agent Thread posting changed the execution claim")
	}
	acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodPost, acceptanceTaskPath(task)+"/worker-claim/release", map[string]any{"version": task.Version, "claimId": claimID, "stoppedConfirmed": true}, "thread-agent-release"), http.StatusOK)
	acceptanceThreadCLIError(t, cli, "claim_conflict", "task", "thread", "post", task.ID, "--project", project.ID, "--body", "Stale execution must fail", "--claim-id", claimID)
	if output := cli.run(t, cli.caller, "task", "thread", "read", task.ID, "--project", project.ID, "--details"); !strings.Contains(output, claimID) {
		t.Fatal("claim release changed the immutable message execution source")
	}
}

func acceptanceThreadPaginationCLI(t *testing.T, fixture *acceptanceFixture, process *acceptanceProcess, cli *acceptanceCLI, project api.Project, userID string) {
	t.Helper()
	task := process.task(t, project, "More than one page in one millisecond")
	fixture.exec(t, `INSERT INTO task_thread_messages(task_id,created_at,author_user_id,author_agent,body)
		SELECT $1,'2026-11-03T00:00:00.120Z',$2,false,'same millisecond '||n FROM generate_series(1,125) n`, task.ID, userID)
	fixture.exec(t, `INSERT INTO task_threads(task_id,last_created_at,last_message_id)
		SELECT task_id,created_at,message_id FROM task_thread_messages WHERE task_id=$1 ORDER BY created_at DESC,message_id DESC LIMIT 1`, task.ID)
	rows, err := fixture.admin.Query(context.Background(), `SELECT message_id::text FROM task_thread_messages WHERE task_id=$1 ORDER BY created_at,message_id`, task.ID)
	if err != nil {
		t.Fatal("cannot inspect owned same-millisecond fixtures")
	}
	var expected []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal("cannot read owned message boundary")
		}
		expected = append(expected, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(expected) != 125 {
		t.Fatal("same-millisecond source fixture is incomplete")
	}
	read := func(arguments ...string) string {
		return cli.run(t, cli.caller, append([]string{"task", "thread", "read", task.ID, "--project", project.ID}, arguments...)...)
	}
	latest := read()
	if !slices.Equal(acceptanceThreadReadIDs(t, latest), expected[len(expected)-20:]) || !strings.Contains(latest, "CreatedAt: 2026-11-03T00:00:00.120Z\n") {
		t.Fatal("installed default count or fixed-three-digit producer time changed")
	}
	var forward []string
	anchor := expected[0]
	for len(forward) < len(expected)-1 {
		output := read("--after-id", anchor, "--count=17")
		ids := acceptanceThreadReadIDs(t, output)
		if len(ids) == 0 || len(ids) > 17 {
			t.Fatal("installed forward page failed to make bounded progress")
		}
		forward = append(forward, ids...)
		anchor = ids[len(ids)-1]
	}
	if !slices.Equal(forward, expected[1:]) {
		t.Fatal("same-millisecond incremental reading skipped, repeated or reordered a database message")
	}
	var backward []string
	anchor = expected[len(expected)-1]
	for len(backward) < len(expected)-1 {
		output := read("--before-id", anchor, "--count", "19")
		ids := acceptanceThreadReadIDs(t, output)
		if len(ids) == 0 || len(ids) > 19 {
			t.Fatal("installed history page failed to make bounded progress")
		}
		backward = append(ids, backward...)
		anchor = ids[0]
	}
	if !slices.Equal(backward, expected[:len(expected)-1]) {
		t.Fatal("same-millisecond history reading skipped, repeated or reordered a database message")
	}
	t.Logf("Thread producer/compiled CLI: %d equal-millisecond messages; exact forward/backward traversal; latest default=20", len(expected))
}

func acceptanceThreadBytesCLI(t *testing.T, process *acceptanceProcess, cli *acceptanceCLI, project api.Project) {
	t.Helper()
	task := process.task(t, project, "Complete byte-bounded messages")
	path := acceptanceTaskPath(task) + "/thread/messages"
	probe := process.request(context.Background(), http.MethodPost, path, map[string]any{"body": "x"}, "thread-byte-probe")
	probeMessage := acceptanceDecode[api.ThreadMessage](t, probe, http.StatusCreated)
	overhead := len(probe.body) - 1
	available := 65536 - overhead
	body := "x" + strings.Repeat("\n", (available-1)/2)
	if (available-1)%2 != 0 {
		body += "x"
	}
	var expected []string
	for range 4 {
		response := process.request(context.Background(), http.MethodPost, path, map[string]any{"body": body}, "thread-byte-source")
		message := acceptanceDecode[api.ThreadMessage](t, response, http.StatusCreated)
		if len(response.body) != 65536 || message.Body != body {
			t.Fatal("real producer fixture did not reach the exact complete-message JSON byte boundary")
		}
		expected = append(expected, message.ID)
	}
	response := process.request(context.Background(), http.MethodGet, path+"?count=100", nil, "thread-byte-page")
	page := acceptanceDecode[api.ThreadPage](t, response, http.StatusOK)
	if len(response.body) > 262144 || len(page.Items) != 3 || !page.HasMoreBefore || page.HasMoreAfter {
		t.Fatal("real producer did not split complete messages at the exact page budget")
	}
	read := func(arguments ...string) string {
		return cli.run(t, cli.caller, append([]string{"task", "thread", "read", task.ID, "--project", project.ID, "--count=100"}, arguments...)...)
	}
	output := read()
	ids := acceptanceThreadReadIDs(t, output)
	if len(output) > 262144 || len(ids) != 2 || !slices.Equal(ids, expected[2:]) || !strings.HasPrefix(output, "... Has more messages before\n") {
		t.Fatal("compiled CLI did not retain a complete directional suffix within its rendered byte budget")
	}
	history := read("--before-id", ids[0])
	if len(history) > 262144 || !slices.Equal(acceptanceThreadReadIDs(t, history), append([]string{probeMessage.ID}, expected[:2]...)) {
		t.Fatal("rendered-byte pagination skipped the complete messages omitted from the first output")
	}
	incremental := read("--after-id", expected[0])
	if len(incremental) > 262144 || !slices.Equal(acceptanceThreadReadIDs(t, incremental), expected[1:3]) || !strings.HasSuffix(incremental, "Has more messages after...\n") {
		t.Fatal("rendered incremental output did not retain a complete prefix and truthful continuation")
	}
	acceptanceThreadCLIError(t, cli, "payload_too_large", "task", "thread", "post", task.ID, "--project", project.ID, "--body", body+"x")
	acceptanceThreadCLIError(t, cli, "payload_too_large", "task", "thread", "post", task.ID, "--project", project.ID, "--body", strings.Repeat("<", 11000))
	t.Logf("Thread byte bounds: message=%d, server page=%d, rendered tail=%d, history=%d, incremental=%d; no truncation", 65536, len(response.body), len(output), len(history), len(incremental))
}

func acceptanceThreadCLIError(t *testing.T, cli *acceptanceCLI, code string, arguments ...string) acceptanceCLIResult {
	t.Helper()
	result := acceptanceCLIReceive(t, cli.start(t, cli.caller, arguments...))
	acceptanceThreadAssertCLIError(t, result, code)
	return result
}

func acceptanceThreadAssertCLIError(t *testing.T, result acceptanceCLIResult, code string) {
	t.Helper()
	if result.status == 0 || result.stdout != "" || !strings.Contains(result.stderr, "code="+code) || strings.Contains(result.stderr, `{"error"`) || strings.Contains(result.stderr, "Caused by:") || strings.Contains(result.stderr, "Bearer ") {
		metadata := regexp.MustCompile(`(?:source|operation|phase|status|code|requestId)=[A-Za-z0-9_.-]+`).FindAllString(result.stderr, -1)
		t.Fatalf("installed Thread refusal lost its controlled code or printed internal diagnostics (exit=%d expected=%s stdout_bytes=%d stderr_bytes=%d metadata=%v unknown=%t raw_envelope=%t cause_chain=%t bearer=%t)", result.status, code, len(result.stdout), len(result.stderr), metadata, strings.Contains(result.stderr, "outcome is unknown"), strings.Contains(result.stderr, `{"error"`), strings.Contains(result.stderr, "Caused by:"), strings.Contains(result.stderr, "Bearer "))
	}
}

func acceptanceThreadClockCLI(t *testing.T, fixture *acceptanceFixture, process *acceptanceProcess, cli *acceptanceCLI, project api.Project, task api.Task) {
	t.Helper()
	var before int
	var userID string
	if err := fixture.admin.QueryRow(context.Background(), `SELECT count(*),min(author_user_id::text) FROM task_thread_messages WHERE task_id=$1`, task.ID).Scan(&before, &userID); err != nil {
		t.Fatal("cannot inspect owned clock-refusal source")
	}
	posts := func() int {
		process.logs.mu.Lock()
		defer process.logs.mu.Unlock()
		count := 0
		for _, event := range process.logs.events {
			route, _ := event["route"].(string)
			if event["type"] == "http_request" && event["method"] == http.MethodPost && strings.HasSuffix(route, "/thread/messages") {
				count++
			}
		}
		return count
	}
	beforePosts := posts()
	fixture.exec(t, `UPDATE task_threads SET last_created_at=clock_timestamp()+interval '1 hour' WHERE task_id=$1`, task.ID)
	result := acceptanceCLIReceive(t, cli.start(t, cli.caller, "task", "thread", "post", task.ID, "--project", project.ID, "--body", "Clock failure does not append"))
	id := regexp.MustCompile(`requestId=([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(?:\s|$)`).FindStringSubmatch(result.stderr)
	if len(id) != 2 {
		t.Fatal("clock-refusal diagnostic omitted its verified request correlation")
	}
	code, phase, status := "clock_not_advanced", "clock", http.StatusServiceUnavailable
	if strings.Contains(result.stderr, "status=500 code=internal_error ") {
		code, phase, status = "internal_error", "rollback", http.StatusInternalServerError
	}
	acceptanceThreadAssertCLIError(t, result, code)
	if !strings.Contains(result.stderr, "status="+strconv.Itoa(status)+" ") || strings.Contains(result.stderr, "outcome is unknown") != (status == http.StatusInternalServerError) {
		t.Fatal("clock-refusal output did not distinguish proven rollback from failed cleanup")
	}
	if !process.logs.matches(map[string]any{"type": "operation_error", "component": "task_thread", "phase": phase, "cause": "deadline", "error_code": code, "request_id": id[1]}) {
		t.Fatal("clock refusal has no matching producer clock or rollback evidence")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := acceptanceEventually(ctx, func() (bool, error) { return posts() >= beforePosts+1, nil }); err != nil || posts() != beforePosts+1 || !process.logs.matches(map[string]any{"type": "http_request", "request_id": id[1], "method": http.MethodPost, "status": float64(status)}) {
		t.Fatal("clock-refusal invocation repeated its POST or lost response correlation")
	}
	var after int
	if err := fixture.admin.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1`, task.ID).Scan(&after); err != nil || after != before {
		t.Fatal("clock refusal committed a message")
	}
	fixture.exec(t, `UPDATE task_threads h SET last_created_at=m.created_at,last_message_id=m.message_id FROM
		(SELECT created_at,message_id FROM task_thread_messages WHERE task_id=$1 ORDER BY created_at DESC,message_id DESC LIMIT 1) m WHERE h.task_id=$1`, task.ID)
	var fixturePosts atomic.Int32
	known := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != acceptanceTaskPath(task)+"/thread/messages" || request.Header.Get("Authorization") != "Bearer "+process.token {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		fixturePosts.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Daynight-User-ID", userID)
		w.Header().Set("X-Request-ID", "thread-known-clock-refusal")
		w.WriteHeader(http.StatusServiceUnavailable)
		if err := json.NewEncoder(w).Encode(api.ErrorResponse{Error: api.Error{Code: "clock_not_advanced", Message: "A reliable forward clock position was not obtained within budget.", RequestID: "thread-known-clock-refusal"}}); err != nil {
			t.Error("cannot write the deterministic known-clock refusal")
		}
	}))
	t.Cleanup(known.Close)
	cli.configure(t, &acceptanceProcess{origin: known.URL, token: process.token})
	knownResult := acceptanceThreadCLIError(t, cli, "clock_not_advanced", "task", "thread", "post", task.ID, "--project", project.ID, "--body", "Known rollback refusal")
	if strings.Contains(knownResult.stderr, "outcome is unknown") || !strings.Contains(knownResult.stderr, "status=503 ") || fixturePosts.Load() != 1 {
		t.Fatal("known clock rollback was reported as uncertain or automatically retried")
	}
	cli.configure(t, process)
	t.Logf("Thread clock refusal: producer status=%d phase=%s cause=deadline; one POST and no append; deterministic503 is definite failure", status, phase)
}

func acceptanceThreadRefusalsCLI(t *testing.T, fixture *acceptanceFixture, process *acceptanceProcess, cli *acceptanceCLI, project api.Project, task api.Task) {
	t.Helper()
	path := acceptanceTaskPath(task) + "/thread/messages"
	acceptanceThreadCLIError(t, cli, "message_not_found", "task", "thread", "read", task.ID, "--project", project.ID, "--after-id", uuid.NewString())
	acceptanceThreadCLIError(t, cli, "message_not_found", "task", "thread", "post", task.ID, "--project", project.ID, "--body", "Missing reply", "--reply-to", uuid.NewString())
	acceptanceThreadClockCLI(t, fixture, process, cli, project, task)
	browser := testauth.Browser(t)
	testauth.Login(t, browser, process.origin, "bob")
	otherToken := testauth.CreatePAT(t, browser, process.origin)
	browser.CloseIdleConnections()
	cli.configure(t, &acceptanceProcess{origin: process.origin, token: otherToken})
	acceptanceThreadCLIError(t, cli, "forbidden", "task", "thread", "read", task.ID, "--project", project.ID)
	acceptanceThreadCLIError(t, cli, "forbidden", "task", "thread", "post", task.ID, "--project", project.ID, "--body", "An unrelated principal must not post")
	cli.configure(t, process)
	before := acceptanceDecode[api.ThreadPage](t, process.request(context.Background(), http.MethodGet, path, nil, "thread-before-wire-loss"), http.StatusOK)
	target, err := url.Parse(process.origin)
	if err != nil {
		t.Fatal("owned loopback service origin is invalid")
	}
	var posts atomic.Int32
	var mismatch atomic.Bool
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = func(response *http.Response) error {
		if response.Request.Method == http.MethodPost && response.Request.URL.Path == path && response.StatusCode == http.StatusCreated {
			posts.Add(1)
			if mismatch.Load() {
				response.Header.Set("Daynight-User-ID", "00000000-0000-4000-8000-000000000099")
				return nil
			}
			response.Body.Close()
			return errors.New("injected lost response after real commit")
		}
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) { w.WriteHeader(http.StatusBadGateway) }
	lost := httptest.NewServer(proxy)
	t.Cleanup(lost.Close)
	cli.configure(t, &acceptanceProcess{origin: lost.URL, token: process.token})
	unknown := acceptanceCLIReceive(t, cli.start(t, cli.caller, "task", "thread", "post", task.ID, "--project", project.ID, "--body", "A committed message whose HTTP result was lost"))
	if unknown.status == 0 || unknown.stdout != "" || !strings.Contains(unknown.stderr, "The posting outcome is unknown.") || posts.Load() != 1 {
		t.Fatal("installed Thread CLI retried an uncertain POST or falsely confirmed its result")
	}
	cli.configure(t, process)
	after := acceptanceDecode[api.ThreadPage](t, process.request(context.Background(), http.MethodGet, path, nil, "thread-after-wire-loss"), http.StatusOK)
	if len(after.Items) != len(before.Items)+1 || after.Items[len(after.Items)-1].Body != "A committed message whose HTTP result was lost" {
		t.Fatal("real wire-loss probe did not prove exactly one durable append")
	}
	mismatch.Store(true)
	cli.configure(t, &acceptanceProcess{origin: lost.URL, token: process.token})
	principal := acceptanceCLIReceive(t, cli.start(t, cli.caller, "task", "thread", "post", task.ID, "--project", project.ID, "--body", "A committed response with mismatched principal metadata"))
	if principal.status == 0 || principal.stdout != "" || !strings.Contains(principal.stderr, "The posting outcome is unknown.") || posts.Load() != 2 {
		t.Fatal("installed Thread CLI accepted a mismatched response principal or repeated its POST")
	}
	cli.configure(t, process)
	final := acceptanceDecode[api.ThreadPage](t, process.request(context.Background(), http.MethodGet, path, nil, "thread-after-principal-mismatch"), http.StatusOK)
	if len(final.Items) != len(after.Items)+1 || final.Items[len(final.Items)-1].Body != "A committed response with mismatched principal metadata" {
		t.Fatal("principal mismatch probe lost its real committed resource")
	}
	deleted := process.task(t, project, "Deleted Thread parent")
	response := process.request(context.Background(), http.MethodDelete, acceptanceTaskPath(deleted), map[string]any{"version": deleted.Version}, "thread-delete-parent")
	if response.err != nil || response.status != http.StatusNoContent {
		t.Fatal("cannot delete the owned Thread parent")
	}
	acceptanceThreadCLIError(t, cli, "task_deleted", "task", "thread", "read", deleted.ID, "--project", project.ID)
	acceptanceThreadCLIError(t, cli, "task_deleted", "task", "thread", "post", deleted.ID, "--project", project.ID, "--body", "Deleted parent must fail")
	for _, count := range []string{"0", "101", "1.5"} {
		invalid := acceptanceCLIReceive(t, cli.start(t, cli.caller, "task", "thread", "read", task.ID, "--project", project.ID, "--count="+count))
		if invalid.status != 2 || invalid.stdout != "" || strings.Contains(invalid.stderr, "Caused by:") {
			t.Fatal("invalid installed Thread count did not remain a controlled usage error")
		}
	}
	t.Logf("Thread actual-commit wire-loss: durable count %s→%s; forwarded POSTs=%d; client outcome=unknown", strconv.Itoa(len(before.Items)), strconv.Itoa(len(after.Items)), posts.Load())
}
