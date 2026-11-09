package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type dropMCPResponse struct {
	token string
	drop  bool
}

func (d *dropMCPResponse) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+d.token)
	response, err := http.DefaultTransport.RoundTrip(r)
	if err == nil && d.drop {
		d.drop = false
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		return nil, errors.New("test: response lost after server completion")
	}
	return response, err
}

func TestMCPThreadProduction(t *testing.T) {
	principal := defaultHTTPPrincipal()
	outsider := principal
	outsider.UserID = "e5555555-5555-4555-8555-555555555555"
	outsider.CredentialID = "f6666666-6666-4666-8666-666666666666"
	token, otherToken := defaultHTTPToken(), "dnpat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
	tx := newHTTPTestStoreForPrincipal(t, principal)
	configureMCPPrincipals(t, tx, map[string]model.Principal{token: principal, otherToken: outsider})
	production, _ := newMCPHTTPServer(t, tx, attachmentTestFiles(t))
	client, denied := mcpPATClient(t, production.URL, token), mcpPATClient(t, production.URL, otherToken)
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	name := "Alice"
	otherID := "a7777777-7777-4777-8777-777777777777"
	call := func(session *sdk.ClientSession, name string, args map[string]any) (*sdk.CallToolResult, map[string]any) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		raw, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var envelope map[string]any
		if err = json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		return result, envelope
	}
	args := func(id string) map[string]any { return map[string]any{"projectId": mcpStepsProjectID, "taskId": id} }
	message := func(taskID, id, body string, at time.Time, reply *string) model.ThreadMessage {
		return model.ThreadMessage{TaskID: taskID, ID: id, Author: model.ThreadAuthor{UserID: principal.UserID, DisplayName: &name}, Body: body, CreatedAt: at, ReplyTo: reply}
	}
	head := func(m model.ThreadMessage) *model.ThreadPosition { p := m.Position(); return &p }
	planPost := func(expected model.ThreadMessage, previous *model.ThreadPosition, reply model.ThreadMessage, replyErr error, source model.Task) *mcpThreadWritePlan {
		t.Helper()
		want := map[string]int{"write": 1, "presence": 1, "credential": 1, "access": 1, "name": 1, "head": 1}
		if expected.ReplyTo != nil {
			want["reply"] = 1
		}
		if expected.Author.Agent {
			want["source"] = 1
		}
		outcome := store.TransactionCommitted
		if replyErr == nil {
			want["insert"] = 1
			want["clock"] = 1
			want["valid"] = 1
			want["advance"] = 1
			want["capture"] = 1
		} else {
			outcome = store.TransactionNotCommitted
		}
		input := expected
		input.ID = ""
		input.CreatedAt = time.Time{}
		p := &mcpThreadWritePlan{t: t, plan: newHTTPCallPlan(t, want), Principal: principal, TaskID: expected.TaskID, Source: source, Head: previous, Reply: reply, ReplyError: replyErr, Input: input, Inserted: expected, Completion: store.Completion{Outcome: outcome}}
		if expected.ReplyTo != nil {
			p.ReplyID = *expected.ReplyTo
		}
		p.write(tx)
		tx.ReadSnapshotCall = nil
		return p
	}
	verifyPost := func(p *mcpThreadWritePlan) {
		t.Helper()
		p.plan.Verify()
		want := []string{"write", "presence", "credential", "access", "name"}
		if p.Input.Author.Agent {
			want = append(want, "source")
		}
		want = append(want, "head")
		if p.ReplyID != "" {
			want = append(want, "reply")
		}
		if p.ReplyError == nil {
			want = append(want, "insert", "clock", "valid", "advance", "capture")
		}
		if !reflect.DeepEqual(p.order, want) {
			t.Fatalf("Thread append order: %v want %v", p.order, want)
		}
	}
	post := func(expected model.ThreadMessage, previous *model.ThreadPosition, reply model.ThreadMessage, source model.Task) map[string]any {
		t.Helper()
		p := planPost(expected, previous, reply, nil, source)
		a := args(expected.TaskID)
		a["body"] = expected.Body
		if expected.ReplyTo != nil {
			a["replyTo"] = *expected.ReplyTo
		}
		if expected.Author.Agent {
			a["claimId"] = expected.Author.Execution.ClaimID
		}
		result, value := call(client, "task_thread_post", a)
		if result.IsError {
			t.Fatalf("post: %+v", value)
		}
		verifyPost(p)
		data := value["data"].(map[string]any)
		if data["id"] != expected.ID || data["body"] != expected.Body || data["author"].(map[string]any)["userId"] != principal.UserID || data["author"].(map[string]any)["Agent"] != expected.Author.Agent {
			t.Fatalf("message receipt: %+v", data)
		}
		return data
	}
	planRead := func(actor model.Principal, taskID string, anchor model.ThreadMessage, before bool, limit int, candidates []model.ThreadMessage, first, last model.ThreadPosition, moreBefore, moreAfter bool, accessErr error) *mcpThreadReadPlan {
		t.Helper()
		want := map[string]int{"snapshot": 1, "credential": 1, "access": 1}
		if accessErr == nil {
			want["presence"] = 1
			want["candidates"] = 1
			if len(candidates) > 0 {
				want["sides"] = 1
			}
			if anchor.ID != "" {
				want["anchor"] = 1
			}
		}
		p := &mcpThreadReadPlan{t: t, plan: newHTTPCallPlan(t, want), Principal: actor, TaskID: taskID, AccessError: accessErr, AnchorID: anchor.ID, Anchor: anchor, Before: before, Limit: limit, Candidates: candidates, First: first, Last: last, MoreBefore: moreBefore, MoreAfter: moreAfter}
		p.snapshot(tx)
		tx.WriteThreadCall = nil
		return p
	}
	firstModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111110", "first", now, nil)
	first := post(firstModel, nil, model.ThreadMessage{}, model.Task{})
	firstID := firstModel.ID
	secondModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111112", "reply", now.Add(time.Second), &firstID)
	second := post(secondModel, head(firstModel), firstModel, model.Task{})
	secondID := secondModel.ID
	if second["replyTo"] != firstID {
		t.Fatalf("reply: %+v", second)
	}
	crossModel := message(otherID, "a1111111-1111-4111-8111-111111111113", "cross", now.Add(2*time.Second), &firstID)
	crossPlan := planPost(crossModel, nil, model.ThreadMessage{}, model.ErrNotFound, model.Task{})
	cross := args(otherID)
	cross["body"] = "cross"
	cross["replyTo"] = firstID
	result, value := call(client, "task_thread_post", cross)
	if !result.IsError || value["error"].(map[string]any)["code"] != "message_not_found" {
		t.Fatalf("cross-task reply: %+v", value)
	}
	verifyPost(crossPlan)
	deniedPlan := planRead(outsider, mcpStepsTaskID, model.ThreadMessage{}, true, 21, nil, model.ThreadPosition{}, model.ThreadPosition{}, false, false, model.ErrNotFound)
	result, value = call(denied, "task_thread_read", args(mcpStepsTaskID))
	if !result.IsError || value["error"].(map[string]any)["code"] != "forbidden" {
		t.Fatalf("unauthorized read: %+v", value)
	}
	deniedPlan.plan.Verify()
	for _, tc := range []struct {
		field, boundary, expected     string
		anchor, row                   model.ThreadMessage
		before, moreBefore, moreAfter bool
	}{{"beforeId", secondID, firstID, secondModel, firstModel, true, false, true}, {"afterId", firstID, secondID, firstModel, secondModel, false, true, false}} {
		p := planRead(principal, mcpStepsTaskID, tc.anchor, tc.before, 2, []model.ThreadMessage{tc.row}, tc.row.Position(), tc.row.Position(), tc.moreBefore, tc.moreAfter, nil)
		a := args(mcpStepsTaskID)
		a[tc.field] = tc.boundary
		a["count"] = 1
		result, value = call(client, "task_thread_read", a)
		if result.IsError {
			t.Fatalf("read: %+v", value)
		}
		p.plan.Verify()
		items := value["data"].(map[string]any)["items"].([]any)
		if len(items) != 1 || items[0].(map[string]any)["id"] != tc.expected {
			t.Fatalf("page: %+v", value)
		}
		if tc.expected == firstID && items[0].(map[string]any)["body"] != first["body"] {
			t.Fatal("message truncated")
		}
	}
	// Exact message admission remains opt-in.
	if os.Getenv("DAYNIGHT_MCP_THREAD_CAPACITY") == "1" {
		probeModel := message(otherID, "a1111111-1111-4111-8111-111111111114", "x", now.Add(3*time.Second), nil)
		probe := post(probeModel, nil, model.ThreadMessage{}, model.Task{})
		encoded, err := json.Marshal(probe)
		if err != nil {
			t.Fatal(err)
		}
		exactBody := strings.Repeat("x", 65536-(len(encoded)-1))
		maxMessages := make([]model.ThreadMessage, 0, 4)
		previous := probeModel
		for i := range 4 {
			expected := message(otherID, fmt.Sprintf("a1111111-1111-4111-8111-%012d", 20+i), exactBody, now.Add(time.Duration(4+i)*time.Second), nil)
			value := post(expected, head(previous), model.ThreadMessage{}, model.Task{})
			encoded, err = json.Marshal(value)
			if err != nil || len(encoded) != 65536 {
				t.Fatalf("message size %d: %v", len(encoded), err)
			}
			maxMessages = append(maxMessages, expected)
			previous = expected
		}
		excess := message(otherID, "a1111111-1111-4111-8111-111111111115", exactBody+"x", now.Add(9*time.Second), nil)
		input := excess
		input.ID, input.CreatedAt = "", time.Time{}
		p := &mcpThreadWritePlan{t: t, plan: newHTTPCallPlan(t, map[string]int{"write": 1, "presence": 1, "credential": 1, "access": 1, "name": 1, "head": 1, "insert": 1, "clock": 1}), Principal: principal, TaskID: otherID, Head: head(previous), Input: input, Inserted: excess, Completion: store.Completion{Outcome: store.TransactionNotCommitted}}
		p.write(tx)
		tx.ReadSnapshotCall = nil
		a := args(otherID)
		a["body"] = excess.Body
		result, value = call(client, "task_thread_post", a)
		if !result.IsError || value["error"].(map[string]any)["code"] != "payload_too_large" {
			t.Fatalf("oversize: %+v", value)
		}
		p.plan.Verify()
		tailCandidates := []model.ThreadMessage{maxMessages[3], maxMessages[2], maxMessages[1], maxMessages[0], probeModel}
		read := planRead(principal, otherID, model.ThreadMessage{}, true, 101, tailCandidates, probeModel.Position(), maxMessages[3].Position(), false, false, nil)
		a = args(otherID)
		a["count"] = 100
		result, value = call(client, "task_thread_read", a)
		if result.IsError {
			t.Fatalf("capacity page: %+v", value)
		}
		read.plan.Verify()
		page := value["data"].(map[string]any)
		encoded, err = json.Marshal(page)
		items := page["items"].([]any)
		if err != nil || len(items) != 5 || items[0].(map[string]any)["id"] != probeModel.ID || items[4].(map[string]any)["id"] != maxMessages[3].ID || page["hasMoreBefore"] != false || page["hasMoreAfter"] != false {
			t.Fatalf("capacity tail: bytes=%d page=%+v", len(encoded), page)
		}
		read = planRead(principal, otherID, maxMessages[1], true, 21, []model.ThreadMessage{maxMessages[0], probeModel}, probeModel.Position(), maxMessages[0].Position(), false, true, nil)
		a = args(otherID)
		a["beforeId"] = maxMessages[1].ID
		result, value = call(client, "task_thread_read", a)
		if result.IsError {
			t.Fatalf("capacity preceding page: %+v", value)
		}
		read.plan.Verify()
		page = value["data"].(map[string]any)
		items = page["items"].([]any)
		if len(items) != 2 || items[1].(map[string]any)["id"] != maxMessages[0].ID || page["hasMoreAfter"] != true {
			t.Fatal("capacity pagination skipped messages")
		}
	}
	// The declared current claim is read only when explicit attribution is requested.
	claimID := "b2222222-2222-4222-8222-222222222220"
	workerID := "b2222222-2222-4222-8222-222222222221"
	worker := &model.WorkerClaim{ClaimID: claimID, State: model.WorkerActive, UserID: principal.UserID, WorkerID: workerID, Machine: model.WorkerMachine{ID: "b2222222-2222-4222-8222-222222222223", Name: "MCP host"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: "b2222222-2222-4222-8222-222222222224", Phase: model.WorkerExecuting, ClaimedAt: now}
	workerRaw, err := taskproperty.EncodeWorker(worker)
	if err != nil {
		t.Fatal(err)
	}
	source := model.Task{ID: mcpStepsTaskID, ProjectID: mcpStepsProjectID, Status: model.TaskInProgress, Version: 3, Properties: model.TaskProperties{"worker": workerRaw}}
	agentModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111116", "agent message", now.Add(10*time.Second), nil)
	agentModel.Author.Agent = true
	agentModel.Author.Execution = &model.ThreadExecution{ClaimID: claimID, WorkerID: workerID, Provider: "codex"}
	posted := post(agentModel, head(secondModel), model.ThreadMessage{}, source)
	if posted["author"].(map[string]any)["Agent"] != true {
		t.Fatalf("claim post: %+v", posted)
	}
	detailsPlan := planRead(principal, mcpStepsTaskID, model.ThreadMessage{}, true, 21, []model.ThreadMessage{agentModel, secondModel, firstModel}, firstModel.Position(), agentModel.Position(), false, false, nil)
	a := args(mcpStepsTaskID)
	a["details"] = true
	result, value = call(client, "task_thread_read", a)
	if result.IsError {
		t.Fatalf("details: %+v", value)
	}
	detailsPlan.plan.Verify()
	items := value["data"].(map[string]any)["items"].([]any)
	author := items[len(items)-1].(map[string]any)["author"].(map[string]any)
	if author["execution"].(map[string]any)["claimId"] != claimID {
		t.Fatalf("claim attribution: %+v", author)
	}

	transport := &dropMCPResponse{token: token}
	sdkClient := sdk.NewClient(&sdk.Implementation{Name: "mcp-drop-test", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	lost, err := sdkClient.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: production.URL + "/mcp", HTTPClient: &http.Client{Transport: transport}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	defer lost.Close()
	lostModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111117", "lost response", now.Add(11*time.Second), nil)
	lostPlan := planPost(lostModel, head(agentModel), model.ThreadMessage{}, nil, model.Task{})
	transport.drop = true
	a = args(mcpStepsTaskID)
	a["body"] = "lost response"
	if _, err = lost.CallTool(ctx, &sdk.CallToolParams{Name: "task_thread_post", Arguments: a}); err == nil {
		t.Fatal("expected lost response")
	}
	verifyPost(lostPlan)
	readAfterLoss := planRead(principal, mcpStepsTaskID, model.ThreadMessage{}, true, 21, []model.ThreadMessage{lostModel, agentModel, secondModel, firstModel}, firstModel.Position(), lostModel.Position(), false, false, nil)
	result, value = call(client, "task_thread_read", args(mcpStepsTaskID))
	if result.IsError {
		t.Fatalf("read after loss: %+v", value)
	}
	readAfterLoss.plan.Verify()
	items = value["data"].(map[string]any)["items"].([]any)
	count := 0
	for _, item := range items {
		if item.(map[string]any)["body"] == "lost response" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected one returned message after loss, got %d", count)
	}
}
