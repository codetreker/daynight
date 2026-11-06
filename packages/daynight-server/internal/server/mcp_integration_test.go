package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpPATTransport struct{ token string }

func (t mcpPATTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+t.token)
	return http.DefaultTransport.RoundTrip(r)
}

func mcpPATClient(t *testing.T, address, token string) *sdk.ClientSession {
	t.Helper()
	client := sdk.NewClient(&sdk.Implementation{Name: "mcp-integration", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: address + "/mcp", HTTPClient: &http.Client{Transport: mcpPATTransport{token: token}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatalf("connect MCP: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func TestMCPProductionPATIsolationAndRevocation(t *testing.T) {
	database := projectTestStore(t)
	files := attachmentTestFiles(t)
	production := httptest.NewUnstartedServer(nil)
	origin := "http://" + production.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthCallbackURL, config.UniAuthURL = origin, callback, gateway.Origin
	config.UniAuthAppID, config.UniAuthAppSecret = gateway.AppID, gateway.AppSecret
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	newApp := func() *sessionApplication {
		t.Helper()
		h, err := newTestHandler(Dependencies{Store: database, Files: files}, config, logger)
		if err != nil {
			t.Fatal(err)
		}
		app := h.(*sessionApplication)
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := app.Shutdown(ctx); err != nil {
				t.Errorf("shutdown: %v", err)
			}
		})
		return app
	}
	app := newApp()
	production.Config.Handler = httpx.RequestLogging(logger, app)
	production.Start()
	t.Cleanup(production.Close)
	alice := testauth.Browser(t)
	bob := testauth.Browser(t)
	testauth.Login(t, alice, origin, "alice")
	testauth.Login(t, bob, origin, "bob")
	tokens := []string{testauth.CreatePAT(t, alice, origin), testauth.CreatePAT(t, bob, origin)}
	client, err := service.NewIdentityClient(config)
	if err != nil {
		t.Fatal(err)
	}
	identity := identityservice.New(database, client, callback)
	principals := make([]model.Principal, len(tokens))
	for i, token := range tokens {
		principals[i], err = identity.Authenticate(t.Context(), model.PATCredential, token)
		if err != nil {
			t.Fatal(err)
		}
	}
	if principals[0].UserID == principals[1].UserID || principals[0].CredentialID == principals[1].CredentialID {
		t.Fatal("fixture PATs do not identify distinct accounts and credentials")
	}
	productionClient := mcpPATClient(t, production.URL, tokens[0])
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	list, err := productionClient.ListTools(ctx, nil)
	cancel()
	if err != nil {
		t.Fatalf("production tools: %#v, %v", list, err)
	}
	assertMCPProductionTools(t, list.Tools)
	project, err := projectservice.NewProjects(database).Create(t.Context(), principals[0], projectcore.CreateProject{ExpectedUserID: principals[0].UserID, Name: "MCP queries", RepoURL: "host:mcp-queries"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := taskservice.NewTasks(database).Create(t.Context(), principals[0], project.ID, taskcore.CreateTask{Title: "Ready task", Description: "Complete description"})
	if err != nil {
		t.Fatal(err)
	}
	call := func(session *sdk.ClientSession, name string, args map[string]any, wantError bool) map[string]any {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		result, err := session.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError != wantError {
			t.Fatalf("%s: %#v, %v", name, result, err)
		}
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err := json.Unmarshal(encoded, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	for _, name := range []string{"task_list", "task_ready"} {
		for _, view := range []string{"summary", "full"} {
			value := call(productionClient, name, map[string]any{"projectId": project.ID, "view": view}, false)
			data := value["data"].(map[string]any)
			items := data["items"].([]any)
			if data["projection"] != view || len(items) != 1 || items[0].(map[string]any)["id"] != created.ID || items[0].(map[string]any)["version"] != "1" {
				t.Fatalf("%s %s: %#v", name, view, value)
			}
			if name == "task_ready" && view == "full" && items[0].(map[string]any)["description"] != "Complete description" {
				t.Fatalf("ready full: %#v", value)
			}
		}
	}
	for _, view := range []string{"summary", "full"} {
		value := call(productionClient, "task_graph", map[string]any{"projectId": project.ID, "taskId": created.ID, "view": view}, false)
		data := value["data"].(map[string]any)
		if data["projection"] != view || len(data["tasks"].([]any)) != 1 {
			t.Fatalf("graph %s: %#v", view, value)
		}
	}
	bobQueries := mcpPATClient(t, production.URL, tokens[1])
	if value := call(bobQueries, "task_list", map[string]any{"projectId": project.ID}, true); value["error"] == nil {
		t.Fatalf("unauthorized project: %#v", value)
	}

	exerciseMCPTeams(t, database, productionClient, mcpPATClient(t, production.URL, tokens[1]), principals)

	// A separate production router with an explicitly test-only tool exposes the
	// authenticated request actor without adding a discoverable production tool.
	instrumented := newApp()
	entry := instrumented.mcp
	input := map[string]any{"type": "object"}
	output := map[string]any{"type": "object"}
	err = entry.RegisterTool(&sdk.Tool{Name: "test_actor", InputSchema: input, OutputSchema: output}, mcphttp.BudgetControl, func(_ context.Context, actor mcphttp.RequestActor, _ json.RawMessage) (mcphttp.ToolResult, error) {
		return mcphttp.ToolResult{Data: map[string]any{"user": actor.Principal.UserID, "credential": actor.AuthorityRef.ID, "kind": actor.AuthorityRef.Kind}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(logger, instrumented))
	t.Cleanup(server.Close)
	sessions := []*sdk.ClientSession{mcpPATClient(t, server.URL, tokens[0]), mcpPATClient(t, server.URL, tokens[1])}
	var wg sync.WaitGroup
	failures := make(chan error, 2)
	for i := range sessions {
		wg.Go(func() {
			for range 12 {
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				result, err := sessions[i].CallTool(ctx, &sdk.CallToolParams{Name: "test_actor", Arguments: map[string]any{}})
				cancel()
				if err != nil || result.IsError {
					failures <- fmt.Errorf("tool call %d: %v", i, err)
					return
				}
				encoded, err := json.Marshal(result.StructuredContent)
				if err != nil {
					failures <- err
					return
				}
				var envelope struct {
					Data struct{ User, Credential, Kind string }
				}
				if err := json.Unmarshal(encoded, &envelope); err != nil || envelope.Data.User != principals[i].UserID || envelope.Data.Credential != principals[i].CredentialID || envelope.Data.Kind != "pat" {
					failures <- fmt.Errorf("unexpected actor for client %d: %s (%v)", i, encoded, err)
					return
				}
			}
		})
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}

	assertStatus := func(token string, expected int) {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, production.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2026-07-28")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != expected {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			t.Errorf("MCP status: got %d, want %d: %s", resp.StatusCode, expected, body)
		}
	}
	assertStatus("invalid", http.StatusUnauthorized)
	revoke, err := http.NewRequestWithContext(t.Context(), http.MethodDelete, origin+"/api/v1/me/tokens/"+principals[0].CredentialID, nil)
	if err != nil {
		t.Fatal(err)
	}
	revoke.Header.Set("Origin", origin)
	resp, err := alice.Do(revoke)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: HTTP %d", resp.StatusCode)
	}
	assertStatus(tokens[0], http.StatusUnauthorized)
	bobProduction := mcpPATClient(t, production.URL, tokens[1])
	ctx, cancel = context.WithTimeout(t.Context(), 5*time.Second)
	list, err = bobProduction.ListTools(ctx, nil)
	cancel()
	if err != nil {
		t.Fatalf("remaining PAT discovery: %#v, %v", list, err)
	}
	assertMCPProductionTools(t, list.Tools)
}

func assertMCPProductionTools(t *testing.T, tools []*sdk.Tool) {
	t.Helper()
	want := map[string]bool{
		"project_create": true, "project_transfer": true, "project_list": true, "project_show": true,
		"team_create": true, "team_rename": true, "team_delete": true, "team_leave": true,
		"team_list": true, "team_show": true, "team_projects": true, "team_member_list": true,
		"team_member_set_role": true, "team_member_remove": true,
		"team_invitation_create": true, "team_invitation_list": true, "team_invitation_revoke": true,
		"invitation_inspect": true, "invitation_accept": true,
		"bot_list": true, "bot_show": true, "bot_create": true, "bot_delete": true,
		"task_thread_read": true, "task_thread_post": true,
		"task_step_list": true, "task_step_show": true, "task_step_add": true, "task_step_update": true,
		"task_step_set_status": true, "task_step_move": true, "task_step_delete": true,
		"task_create": true, "task_show": true, "task_update": true, "task_set_status": true,
		"task_delete": true, "task_properties": true, "task_set_property": true, "task_remove_property": true,
		"task_list": true, "task_ready": true, "task_graph": true,
	}
	for _, tool := range tools {
		if !want[tool.Name] {
			t.Errorf("unexpected or duplicate production tool %s", tool.Name)
			continue
		}
		delete(want, tool.Name)
	}
	for name := range want {
		t.Errorf("missing production tool %s", name)
	}
}
