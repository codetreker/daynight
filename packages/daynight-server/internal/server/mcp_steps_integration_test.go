package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPStepsProductionLifecycle(t *testing.T) {
	database := projectTestStore(t)
	production := httptest.NewUnstartedServer(nil)
	origin := "http://" + production.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthCallbackURL, config.UniAuthURL = origin, callback, gateway.Origin
	config.UniAuthAppID, config.UniAuthAppSecret = gateway.AppID, gateway.AppSecret
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler, err := newTestHandler(Dependencies{Store: database, Files: attachmentTestFiles(t)}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	app := handler.(*sessionApplication)
	production.Config.Handler = httpx.RequestLogging(logger, app)
	production.Start()
	t.Cleanup(func() {
		production.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
	})
	identityClient, err := service.NewIdentityClient(config)
	if err != nil {
		t.Fatal(err)
	}
	identity := identityservice.New(database, identityClient, callback)
	var principal model.Principal
	var tokens []string
	for _, user := range []string{"alice", "bob"} {
		browser := testauth.Browser(t)
		testauth.Login(t, browser, origin, user)
		token := testauth.CreatePAT(t, browser, origin)
		p, err := identity.Authenticate(t.Context(), model.PATCredential, token)
		if err != nil {
			t.Fatal(err)
		}
		if user == "alice" {
			principal = p
		}
		tokens = append(tokens, token)
	}
	for index, protocol := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(protocol, func(t *testing.T) {
			connect := func(token string) *sdk.ClientSession {
				t.Helper()
				client := sdk.NewClient(&sdk.Implementation{Name: "mcp-steps-integration", Version: "1"}, nil)
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: origin + "/mcp", HTTPClient: &http.Client{Transport: mcpPATTransport{token: token}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: protocol})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = session.Close() })
				return session
			}
			alice, bob := connect(tokens[0]), connect(tokens[1])
			call := func(client *sdk.ClientSession, name string, args map[string]any) (map[string]any, bool) {
				t.Helper()
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
				if err != nil {
					t.Fatal(err)
				}
				encoded, err := json.Marshal(result.StructuredContent)
				if err != nil {
					t.Fatal(err)
				}
				var value map[string]any
				if err = json.Unmarshal(encoded, &value); err != nil {
					t.Fatal(err)
				}
				return value, result.IsError
			}
			obj := func(value any) map[string]any {
				t.Helper()
				out, ok := value.(map[string]any)
				if !ok {
					t.Fatalf("expected object: %#v", value)
				}
				return out
			}
			project, failed := call(alice, "project_create", map[string]any{"name": "Steps MCP", "repoUrl": fmt.Sprintf("https://example.com/steps-%d", index), "team": "personal", "confirm": true})
			if failed {
				t.Fatalf("create project: %+v", project)
			}
			projectID := obj(obj(project["data"])["project"])["id"].(string)
			parent, err := taskservice.NewTasks(database).Create(t.Context(), principal, projectID, taskcore.CreateTask{Title: "Steps parent"})
			if err != nil {
				t.Fatal(err)
			}
			args := func(extra map[string]any) map[string]any {
				m := map[string]any{"projectId": projectID, "taskId": parent.ID}
				for k, v := range extra {
					m[k] = v
				}
				return m
			}
			success := func(name string, extra map[string]any) map[string]any {
				t.Helper()
				out, failed := call(alice, name, args(extra))
				if failed {
					t.Fatalf("%s: %+v", name, out)
				}
				return obj(out["data"])
			}
			failure := func(client *sdk.ClientSession, name string, extra map[string]any, code string) map[string]any {
				t.Helper()
				out, failed := call(client, name, args(extra))
				if !failed || obj(out["error"])["code"] != code {
					t.Fatalf("%s wanted %s: %+v", name, code, out)
				}
				return obj(out["error"])
			}
			denied := failure(bob, "task_step_list", nil, "not_found")
			if _, exists := denied["refs"]; exists {
				t.Fatalf("unauthorized list leaks refs: %+v", denied)
			}
			failure(bob, "task_step_add", map[string]any{"id": "00000001", "title": "blocked"}, "not_found")
			first := success("task_step_add", map[string]any{"id": "ABCDEF01", "title": "First", "description": "first body"})
			if first["stepId"] != "abcdef01" || first["version"] != "2" || first["changed"] != true || obj(first["step"])["status"] != "todo" {
				t.Fatalf("first receipt: %+v", first)
			}
			success("task_step_add", map[string]any{"id": "abcdef02", "title": "Second", "before": "abcdef01"})
			success("task_step_add", map[string]any{"id": "abcdef03", "title": "Third", "after": "abcdef01"})
			page := success("task_step_list", map[string]any{"limit": 2})
			items := page["items"].([]any)
			if page["version"] != "4" || page["projection"] != "summary" || len(items) != 2 || obj(items[0])["id"] != "abcdef02" || obj(items[1])["id"] != "abcdef01" || obj(items[1])["position"] != float64(1) {
				t.Fatalf("first page: %+v", page)
			}
			cursor, ok := page["nextCursor"].(string)
			if !ok || cursor == "" {
				t.Fatalf("missing cursor: %+v", page)
			}
			tail := success("task_step_list", map[string]any{"limit": 2, "cursor": cursor})
			if len(tail["items"].([]any)) != 1 || obj(tail["items"].([]any)[0])["id"] != "abcdef03" || tail["nextCursor"] != nil {
				t.Fatalf("tail: %+v", tail)
			}
			full := success("task_step_show", map[string]any{"stepId": "abcdef01", "view": "full"})
			if full["version"] != "4" || obj(full["step"])["description"] != "first body" {
				t.Fatalf("full show: %+v", full)
			}
			update := success("task_step_update", map[string]any{"stepId": "abcdef01", "description": "revised", "ifVersion": "4", "returnView": "full"})
			if update["version"] != "5" || len(update["steps"].([]any)) != 3 || obj(update["steps"].([]any)[1])["description"] != "revised" {
				t.Fatalf("full update: %+v", update)
			}
			conflict := failure(alice, "task_step_list", map[string]any{"limit": 2, "cursor": cursor}, "version_conflict")
			if _, exists := conflict["writeOutcome"]; exists {
				t.Fatalf("read conflict claimed a write outcome: %+v", conflict)
			}
			failure(alice, "task_step_update", map[string]any{"stepId": "abcdef01", "description": "revised", "ifVersion": "4"}, "version_conflict")
			noop := success("task_step_update", map[string]any{"stepId": "abcdef01", "description": "revised", "ifVersion": "5"})
			if noop["changed"] != false || noop["version"] != "5" {
				t.Fatalf("noop: %+v", noop)
			}
			failure(alice, "task_step_move", map[string]any{"stepId": "abcdef01", "before": "ABCDEF01", "ifVersion": "5"}, "invalid_input")
			for _, status := range []string{"todo", "in_progress", "done", "skipped"} {
				out := success("task_step_set_status", map[string]any{"stepId": "abcdef02", "status": status})
				if obj(out["step"])["status"] != status {
					t.Fatalf("status %s: %+v", status, out)
				}
			}
			success("task_step_move", map[string]any{"stepId": "abcdef03", "position": "first"})
			ordered := success("task_step_list", map[string]any{"view": "full"})
			values := ordered["items"].([]any)
			if len(values) != 3 || obj(values[0])["id"] != "abcdef03" || obj(values[1])["id"] != "abcdef02" || obj(values[2])["id"] != "abcdef01" {
				t.Fatalf("order: %+v", ordered)
			}
			for _, id := range []string{"abcdef03", "abcdef02", "abcdef01"} {
				deleted := success("task_step_delete", map[string]any{"stepId": id})
				if id == "abcdef01" {
					steps, ok := deleted["steps"].([]any)
					if !ok || len(steps) != 0 {
						t.Fatalf("last delete receipt: %+v", deleted)
					}
				}
			}
			empty := success("task_step_list", nil)
			if len(empty["items"].([]any)) != 0 || empty["nextCursor"] != nil {
				t.Fatalf("empty: %+v", empty)
			}
			absence := failure(alice, "task_step_show", map[string]any{"stepId": "abcdef01"}, "not_found")
			if obj(absence["refs"])["version"] != empty["version"] {
				t.Fatalf("absence version: %+v, empty: %+v", absence, empty)
			}
		})
	}
}
