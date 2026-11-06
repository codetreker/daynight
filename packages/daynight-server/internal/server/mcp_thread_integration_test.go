package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
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
	integration := newIdentityIntegration(t)
	alice, bob := identityBrowser(t), identityBrowser(t)
	user := integration.login(t, alice, "alice")
	integration.login(t, bob, "bob")
	origin := map[string]string{"Origin": integration.server.URL}
	request := func(browser *http.Client, method, path string, body any, status int) []byte {
		t.Helper()
		text := ""
		if body != nil {
			text = jsonBody(t, body)
		}
		_, data := identityRequest(t, browser, method, integration.server.URL+path, text, origin, status)
		return data
	}
	project := identityDecode[api.Project](t, request(alice, "POST", "/api/v1/projects", api.CreateProjectRequest{Name: "MCP discussion", RepoURL: "https://example.com/mcp-thread", ExpectedUserID: user.ID}, 201))
	task := identityDecode[api.Task](t, request(alice, "POST", taskCollection(project.ID), map[string]any{"title": "Thread", "assignedTo": user.ID}, 201))
	other := identityDecode[api.Task](t, request(alice, "POST", taskCollection(project.ID), map[string]any{"title": "Other"}, 201))
	token := identityDecode[api.CreatedPersonalAccessToken](t, request(alice, "POST", "/api/v1/me/tokens", map[string]any{"name": "MCP Thread", "expiresAt": nil}, 201))
	outsider := identityDecode[api.CreatedPersonalAccessToken](t, request(bob, "POST", "/api/v1/me/tokens", map[string]any{"name": "Outsider", "expiresAt": nil}, 201))
	client := mcpPATClient(t, integration.server.URL, token.Token)
	denied := mcpPATClient(t, integration.server.URL, outsider.Token)
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
	args := func(id string) map[string]any { return map[string]any{"projectId": project.ID, "taskId": id} }
	post := func(id, body string, reply string) map[string]any {
		t.Helper()
		a := args(id)
		a["body"] = body
		if reply != "" {
			a["replyTo"] = reply
		}
		result, value := call(client, "task_thread_post", a)
		if result.IsError {
			t.Fatalf("post: %+v", value)
		}
		return value["data"].(map[string]any)
	}
	first := post(task.ID, "first", "")
	firstID := first["id"].(string)
	second := post(task.ID, "reply", firstID)
	secondID := second["id"].(string)
	if second["replyTo"] != firstID {
		t.Fatalf("reply: %+v", second)
	}
	cross := args(other.ID)
	cross["body"] = "cross"
	cross["replyTo"] = firstID
	result, value := call(client, "task_thread_post", cross)
	if !result.IsError {
		t.Fatalf("cross-task reply: %+v", value)
	}
	result, value = call(denied, "task_thread_read", args(task.ID))
	if !result.IsError || value["error"].(map[string]any)["code"] != "forbidden" {
		t.Fatalf("unauthorized read: %+v", value)
	}
	for _, tc := range []struct{ field, boundary, expected string }{{"beforeId", secondID, firstID}, {"afterId", firstID, secondID}} {
		a := args(task.ID)
		a[tc.field] = tc.boundary
		a["count"] = 1
		result, value = call(client, "task_thread_read", a)
		if result.IsError {
			t.Fatalf("read: %+v", value)
		}
		items := value["data"].(map[string]any)["items"].([]any)
		if len(items) != 1 || items[0].(map[string]any)["id"] != tc.expected {
			t.Fatalf("page: %+v", value)
		}
		if tc.expected == firstID && items[0].(map[string]any)["body"] != first["body"] {
			t.Fatal("message truncated")
		}
	}
	// Capacity fixtures run separately from the routine CI suite.
	if os.Getenv("DAYNIGHT_MCP_THREAD_CAPACITY") == "1" {
		probe := post(other.ID, "x", "")
		encoded, err := json.Marshal(probe)
		if err != nil {
			t.Fatal(err)
		}
		exactBody := strings.Repeat("x", 65536-(len(encoded)-1))
		ids := make([]string, 0, 4)
		for range 4 {
			message := post(other.ID, exactBody, "")
			encoded, err := json.Marshal(message)
			if err != nil || len(encoded) != 65536 {
				t.Fatalf("message size %d: %v", len(encoded), err)
			}
			ids = append(ids, message["id"].(string))
		}
		a := args(other.ID)
		a["body"] = exactBody + "x"
		result, value := call(client, "task_thread_post", a)
		if !result.IsError || value["error"].(map[string]any)["code"] != "payload_too_large" {
			t.Fatalf("oversize: %+v", value)
		}
		a = args(other.ID)
		a["count"] = 100
		result, value = call(client, "task_thread_read", a)
		if result.IsError {
			t.Fatalf("capacity page: %+v", value)
		}
		page := value["data"].(map[string]any)
		encoded, err = json.Marshal(page)
		items := page["items"].([]any)
		if err != nil || len(encoded) > 262144 || len(items) != 3 || items[0].(map[string]any)["id"] != ids[1] || items[2].(map[string]any)["id"] != ids[3] || page["hasMoreBefore"] != true || page["hasMoreAfter"] != false {
			t.Fatalf("capacity tail: bytes=%d page=%+v", len(encoded), page)
		}
		a = args(other.ID)
		a["beforeId"] = ids[1]
		result, value = call(client, "task_thread_read", a)
		if result.IsError {
			t.Fatalf("capacity preceding page: %+v", value)
		}
		page = value["data"].(map[string]any)
		items = page["items"].([]any)
		if len(items) != 2 || items[1].(map[string]any)["id"] != ids[0] || page["hasMoreAfter"] != true {
			t.Fatal("capacity pagination skipped messages")
		}
	}
	// An explicit claim is the only source of agent attribution.
	task = identityDecode[api.Task](t, request(alice, "PATCH", taskPath(task), map[string]any{"version": task.Version, "allowAgents": true}, 200))
	claim := workerClaimBody(task.Version)
	task = identityDecode[api.Task](t, request(alice, "POST", taskPath(task)+"/worker-claim", claim, 200))
	a := args(task.ID)
	a["body"] = "agent message"
	a["claimId"] = claim["claimId"]
	result, value = call(client, "task_thread_post", a)
	if result.IsError || value["data"].(map[string]any)["author"].(map[string]any)["Agent"] != true {
		t.Fatalf("claim post: %+v", value)
	}
	a = args(task.ID)
	a["details"] = true
	result, value = call(client, "task_thread_read", a)
	if result.IsError {
		t.Fatalf("details: %+v", value)
	}
	items := value["data"].(map[string]any)["items"].([]any)
	author := items[len(items)-1].(map[string]any)["author"].(map[string]any)
	if author["execution"].(map[string]any)["claimId"] != claim["claimId"] {
		t.Fatalf("claim attribution: %+v", author)
	}

	transport := &dropMCPResponse{token: token.Token}
	sdkClient := sdk.NewClient(&sdk.Implementation{Name: "mcp-drop-test", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	lost, err := sdkClient.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: integration.server.URL + "/mcp", HTTPClient: &http.Client{Transport: transport}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	defer lost.Close()
	transport.drop = true
	a = args(task.ID)
	a["body"] = "lost response"
	if _, err = lost.CallTool(ctx, &sdk.CallToolParams{Name: "task_thread_post", Arguments: a}); err == nil {
		t.Fatal("expected lost response")
	}
	result, value = call(client, "task_thread_read", args(task.ID))
	if result.IsError {
		t.Fatalf("read after loss: %+v", value)
	}
	items = value["data"].(map[string]any)["items"].([]any)
	count := 0
	for _, item := range items {
		if item.(map[string]any)["body"] == "lost response" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected one committed message after loss, got %d", count)
	}
}
