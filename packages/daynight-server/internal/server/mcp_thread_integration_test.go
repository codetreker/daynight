package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
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
	ops := &mcpThreadOperations{t: t}
	production, _ := newMCPOperationServer(t, map[string]model.Principal{token: principal, otherToken: outsider}, attachmentTestFiles(t), func(app *service.App) { app.TaskThreads = ops })
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
	planPost := func(expected model.ThreadMessage, finalError error) *mcpThreadOperationPlan {
		input := taskservice.CreateThreadMessage{Body: expected.Body, ReplyTo: botExpiryClonePointer(expected.ReplyTo)}
		if expected.Author.Execution != nil {
			input.ClaimID = botExpiryClonePointer(&expected.Author.Execution.ClaimID)
		}
		return ops.expectPost(principal, mcpStepsProjectID, expected.TaskID, input, expected, finalError)
	}
	post := func(expected model.ThreadMessage) map[string]any {
		t.Helper()
		p := planPost(expected, nil)
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
		p.Verify()
		data := value["data"].(map[string]any)
		if data["id"] != expected.ID || data["body"] != expected.Body || data["author"].(map[string]any)["userId"] != principal.UserID || data["author"].(map[string]any)["Agent"] != expected.Author.Agent {
			t.Fatalf("message receipt: %+v", data)
		}
		return data
	}
	firstModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111110", "first", now, nil)
	first := post(firstModel)
	firstID := firstModel.ID
	secondModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111112", "reply", now.Add(time.Second), &firstID)
	second := post(secondModel)
	secondID := secondModel.ID
	if second["replyTo"] != firstID {
		t.Fatalf("reply: %+v", second)
	}
	crossModel := message(otherID, "a1111111-1111-4111-8111-111111111113", "cross", now.Add(2*time.Second), &firstID)
	crossPlan := planPost(crossModel, &model.Fault{Code: "message_not_found", Message: "Message was not found in this task.", Cause: model.ErrNotFound})
	cross := args(otherID)
	cross["body"] = "cross"
	cross["replyTo"] = firstID
	result, value := call(client, "task_thread_post", cross)
	if !result.IsError || value["error"].(map[string]any)["code"] != "message_not_found" {
		t.Fatalf("cross-task reply: %+v", value)
	}
	crossPlan.Verify()
	deniedPlan := ops.expectList(outsider, mcpStepsProjectID, mcpStepsTaskID, taskservice.ThreadListRequest{Count: 20}, model.ThreadPage{}, &model.Fault{Code: "forbidden", Message: "Project access is required.", Cause: model.ErrNotFound})
	result, value = call(denied, "task_thread_read", args(mcpStepsTaskID))
	if !result.IsError || value["error"].(map[string]any)["code"] != "forbidden" {
		t.Fatalf("unauthorized read: %+v", value)
	}
	deniedPlan.Verify()
	for _, tc := range []struct {
		field, boundary, expected     string
		row                           model.ThreadMessage
		before, moreBefore, moreAfter bool
	}{{"beforeId", secondID, firstID, firstModel, true, false, true}, {"afterId", firstID, secondID, secondModel, false, true, false}} {
		request := taskservice.ThreadListRequest{Count: 1}
		if tc.before {
			request.BeforeID = botExpiryClonePointer(&tc.boundary)
		} else {
			request.AfterID = botExpiryClonePointer(&tc.boundary)
		}
		p := ops.expectList(principal, mcpStepsProjectID, mcpStepsTaskID, request, model.ThreadPage{Items: []model.ThreadMessage{tc.row}, HasMoreBefore: tc.moreBefore, HasMoreAfter: tc.moreAfter}, nil)
		a := args(mcpStepsTaskID)
		a[tc.field] = tc.boundary
		a["count"] = 1
		result, value = call(client, "task_thread_read", a)
		if result.IsError {
			t.Fatalf("read: %+v", value)
		}
		p.Verify()
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
		probe := post(probeModel)
		encoded, err := json.Marshal(probe)
		if err != nil {
			t.Fatal(err)
		}
		exactBody := strings.Repeat("x", 65536-(len(encoded)-1))
		maxMessages := make([]model.ThreadMessage, 0, 4)
		for i := range 4 {
			expected := message(otherID, fmt.Sprintf("a1111111-1111-4111-8111-%012d", 20+i), exactBody, now.Add(time.Duration(4+i)*time.Second), nil)
			value := post(expected)
			encoded, err = json.Marshal(value)
			if err != nil || len(encoded) != 65536 {
				t.Fatalf("message size %d: %v", len(encoded), err)
			}
			maxMessages = append(maxMessages, expected)
		}
		excess := message(otherID, "a1111111-1111-4111-8111-111111111115", exactBody+"x", now.Add(9*time.Second), nil)
		p := ops.expectPost(principal, mcpStepsProjectID, otherID, taskservice.CreateThreadMessage{Body: excess.Body}, excess, &model.Fault{Code: "payload_too_large", Message: "Complete encoded message exceeds 64 KiB."})
		a := args(otherID)
		a["body"] = excess.Body
		result, value = call(client, "task_thread_post", a)
		if !result.IsError || value["error"].(map[string]any)["code"] != "payload_too_large" {
			t.Fatalf("oversize: %+v", value)
		}
		p.Verify()
		tailCandidates := []model.ThreadMessage{probeModel, maxMessages[0], maxMessages[1], maxMessages[2], maxMessages[3]}
		read := ops.expectList(principal, mcpStepsProjectID, otherID, taskservice.ThreadListRequest{Count: 100}, model.ThreadPage{Items: tailCandidates}, nil)
		a = args(otherID)
		a["count"] = 100
		result, value = call(client, "task_thread_read", a)
		if result.IsError {
			t.Fatalf("capacity page: %+v", value)
		}
		read.Verify()
		page := value["data"].(map[string]any)
		encoded, err = json.Marshal(page)
		items := page["items"].([]any)
		if err != nil || len(items) != 5 || items[0].(map[string]any)["id"] != probeModel.ID || items[4].(map[string]any)["id"] != maxMessages[3].ID || page["hasMoreBefore"] != false || page["hasMoreAfter"] != false {
			t.Fatalf("capacity tail: bytes=%d page=%+v", len(encoded), page)
		}
		read = ops.expectList(principal, mcpStepsProjectID, otherID, taskservice.ThreadListRequest{Count: 20, BeforeID: botExpiryClonePointer(&maxMessages[1].ID)}, model.ThreadPage{Items: []model.ThreadMessage{probeModel, maxMessages[0]}, HasMoreAfter: true}, nil)
		a = args(otherID)
		a["beforeId"] = maxMessages[1].ID
		result, value = call(client, "task_thread_read", a)
		if result.IsError {
			t.Fatalf("capacity preceding page: %+v", value)
		}
		read.Verify()
		page = value["data"].(map[string]any)
		items = page["items"].([]any)
		if len(items) != 2 || items[1].(map[string]any)["id"] != maxMessages[0].ID || page["hasMoreAfter"] != true {
			t.Fatal("capacity pagination skipped messages")
		}
	}
	claimID := "b2222222-2222-4222-8222-222222222220"
	workerID := "b2222222-2222-4222-8222-222222222221"
	agentModel := message(mcpStepsTaskID, "a1111111-1111-4111-8111-111111111116", "agent message", now.Add(10*time.Second), nil)
	agentModel.Author.Agent = true
	agentModel.Author.Execution = &model.ThreadExecution{ClaimID: claimID, WorkerID: workerID, Provider: "codex"}
	posted := post(agentModel)
	if posted["author"].(map[string]any)["Agent"] != true {
		t.Fatalf("claim post: %+v", posted)
	}
	detailsPlan := ops.expectList(principal, mcpStepsProjectID, mcpStepsTaskID, taskservice.ThreadListRequest{Count: 20, Details: true}, model.ThreadPage{Items: []model.ThreadMessage{firstModel, secondModel, agentModel}}, nil)
	a := args(mcpStepsTaskID)
	a["details"] = true
	result, value = call(client, "task_thread_read", a)
	if result.IsError {
		t.Fatalf("details: %+v", value)
	}
	detailsPlan.Verify()
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
	lostPlan := planPost(lostModel, nil)
	transport.drop = true
	a = args(mcpStepsTaskID)
	a["body"] = "lost response"
	if _, err = lost.CallTool(ctx, &sdk.CallToolParams{Name: "task_thread_post", Arguments: a}); err == nil {
		t.Fatal("expected lost response")
	}
	lostPlan.Verify()
	readAfterLoss := ops.expectList(principal, mcpStepsProjectID, mcpStepsTaskID, taskservice.ThreadListRequest{Count: 20}, model.ThreadPage{Items: []model.ThreadMessage{firstModel, secondModel, agentModel, lostModel}}, nil)
	result, value = call(client, "task_thread_read", args(mcpStepsTaskID))
	if result.IsError {
		t.Fatalf("read after loss: %+v", value)
	}
	readAfterLoss.Verify()
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
