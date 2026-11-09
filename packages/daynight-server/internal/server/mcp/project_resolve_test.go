package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestProjectResolveForwardsContextAndMapsProject(t *testing.T) {
	ctx := t.Context()
	actor := projectActor()
	address := "git@example.com:Group/Repo.git"
	project := sampleProject(testProjectID)
	calls := 0
	ops := &fakeProjectOperations{resolve: func(got context.Context, principal model.Principal, input string) (model.Project, error) {
		calls++
		if got != ctx || principal != actor.Principal || input != address {
			t.Fatalf("resolve context/principal/address: %v %+v %q", got == ctx, principal, input)
		}
		return project, nil
	}}
	result, err := (&projectTools{projects: ops}).resolve(ctx, actor, projectResolveInput{RepoURL: address})
	if err != nil || calls != 1 || !reflect.DeepEqual(result.Data, MapProject(project)) || result.Outcome != "" || result.WriteOutcome != "" || result.Phase != "" || result.Refs != nil {
		t.Fatalf("result=%+v calls=%d err=%v", result, calls, err)
	}
}

func TestProjectResolveProtocol(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			f := newEntryFixture(t)
			var logs bytes.Buffer
			f.entry.logger = slog.New(slog.NewJSONHandler(&logs, nil))
			project := sampleProject(testProjectID)
			project.CreatedAt = time.Date(2026, 11, 9, 12, 0, 0, 0, time.FixedZone("local", 8*60*60))
			project.UpdatedAt = project.CreatedAt.Add(time.Minute)
			project.Settings.ExecutionWarningMinutes = 17
			project.Ownership.UpdatedAt = project.CreatedAt.Add(2 * time.Minute)
			var calls int
			var seen string
			var failure error
			ops := &fakeProjectOperations{resolve: func(_ context.Context, principal model.Principal, address string) (model.Project, error) {
				calls++
				seen = address
				if principal.UserID != "alice" {
					t.Fatalf("principal=%+v", principal)
				}
				if failure != nil {
					return model.Project{}, failure
				}
				if _, err := coreproject.NewRepositoryMatch(address); err != nil {
					return model.Project{}, err
				}
				return project, nil
			}}
			if err := RegisterProjectTools(f.entry, ops, nil, "https://daynight.test"); err != nil {
				t.Fatal(err)
			}
			client := f.client(t, version, "alice")
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			listing, err := client.ListTools(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			var tool *sdk.Tool
			for _, candidate := range listing.Tools {
				if candidate.Name == "project_resolve" {
					tool = candidate
				}
			}
			if tool == nil || tool.Annotations == nil || !tool.Annotations.ReadOnlyHint || tool.Annotations.DestructiveHint == nil || *tool.Annotations.DestructiveHint || tool.Annotations.OpenWorldHint == nil || *tool.Annotations.OpenWorldHint {
				t.Fatalf("annotations: %+v", tool)
			}
			inputBytes, err := json.Marshal(tool.InputSchema)
			if err != nil {
				t.Fatal(err)
			}
			var schema map[string]any
			if err := json.Unmarshal(inputBytes, &schema); err != nil {
				t.Fatal(err)
			}
			if schema["additionalProperties"] != false || !requiredExactly(schema["required"], "repoUrl") || len(object(t, schema["properties"])) != 1 {
				t.Fatalf("input schema: %s", inputBytes)
			}
			call := func(args any) *sdk.CallToolResult {
				t.Helper()
				result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "project_resolve", Arguments: args})
				if err != nil {
					t.Fatal(err)
				}
				return result
			}
			prefix := "https://example.com/"
			remaining := 4096 - len(prefix)
			address := prefix + strings.Repeat("é", remaining/2) + strings.Repeat("x", remaining%2)
			result := call(map[string]any{"repoUrl": address})
			doc := structured(t, result)
			data := object(t, doc["data"])
			want := map[string]any{
				"id": project.ID, "name": project.Name, "repoUrl": project.RepoURL,
				"createdAt": "2026-11-09T04:00:00Z", "updatedAt": "2026-11-09T04:01:00Z",
				"settings":  map[string]any{"version": "9007199254740993", "executionWarningMinutes": float64(17)},
				"ownership": map[string]any{"teamId": testTeamID, "version": "9007199254740994", "updatedAt": "2026-11-09T04:02:00Z"},
			}
			if result.IsError || seen != address || !reflect.DeepEqual(data, want) || object(t, doc["meta"])["outcome"] != nil {
				t.Fatalf("success: %+v", doc)
			}
			outputSchema, err := resolveSchema(tool.OutputSchema)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateJSON(outputSchema, encoded); err != nil {
				t.Fatalf("success does not satisfy advertised output schema: %v", err)
			}
			result = call(map[string]any{"repoUrl": address + "é"})
			if !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" {
				t.Fatalf("byte limit: %+v", result)
			}
			before := calls
			for _, args := range []any{map[string]any{}, map[string]any{"repoUrl": "x", "extra": true}} {
				result = call(args)
				if !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" {
					t.Fatalf("invalid schema: %+v", result)
				}
			}
			if calls != before {
				t.Fatalf("invalid schema reached use case: %d -> %d", before, calls)
			}
			for _, code := range []string{"not_found", "resource_conflict", "invalid_input"} {
				failure = &model.Fault{Code: code, Message: "refused"}
				result = call(map[string]any{"repoUrl": "https://example.com/repo"})
				doc = structured(t, result)
				e := object(t, doc["error"])
				if !result.IsError || e["code"] != code || e["writeOutcome"] != nil || doc["data"] != nil {
					t.Fatalf("%s: %+v", code, doc)
				}
			}
			failure = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("secret repository address")}
			result = call(map[string]any{"repoUrl": "https://example.com/private"})
			doc = structured(t, result)
			if e := object(t, doc["error"]); !result.IsError || e["code"] != "internal_error" || e["writeOutcome"] != nil || doc["data"] != nil {
				t.Fatalf("snapshot failure: %+v", doc)
			}
			if strings.Contains(logs.String(), "example.com/private") || strings.Contains(logs.String(), "secret repository address") || !strings.Contains(logs.String(), `"operation":"project_resolve"`) || !strings.Contains(logs.String(), `"phase":"tool_call"`) || !strings.Contains(logs.String(), `"request_id":"test-request"`) {
				t.Fatalf("unsafe or incomplete logs: %s", logs.String())
			}
			failure = nil
			release, err := f.entry.budget.Acquire(ctx, BudgetLarge)
			if err != nil {
				t.Fatal(err)
			}
			before = calls
			result = call(map[string]any{"repoUrl": "https://example.com/repo"})
			if !result.IsError || object(t, structured(t, result)["error"])["code"] != "resource_busy" || calls != before {
				t.Fatalf("admission: %+v calls=%d", result, calls)
			}
			release()
			result = call(map[string]any{"repoUrl": "https://example.com/repo"})
			if result.IsError || calls != before+1 {
				t.Fatalf("budget not released: %+v", result)
			}
		})
	}
}

func TestCanceledProjectResolveHoldsLargeBudgetUntilCallbackAndHTTPFinish(t *testing.T) {
	entered, canceled, releaseHandler, exited := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	httpDone := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(releaseHandler) }) }
	var calls atomic.Int64
	ops := &fakeProjectOperations{resolve: func(ctx context.Context, _ model.Principal, _ string) (model.Project, error) {
		if calls.Add(1) == 1 {
			defer close(exited)
			close(entered)
			<-ctx.Done()
			close(canceled)
			<-releaseHandler
			return model.Project{}, ctx.Err()
		}
		return sampleProject(testProjectID), nil
	}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := RegisterProjectTools(entry, ops, nil, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	server := httptest.NewServer(httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Request-ID") == "cancel-resolve" {
			defer close(httpDone)
		}
		entry.ServeHTTP(w, r)
	})))
	t.Cleanup(server.Close)
	t.Cleanup(unblock)
	call := func(ctx context.Context, requestID string) (materializationResult, error) {
		var result materializationResult
		body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"project_resolve","arguments":{"repoUrl":"https://example.com/repo"}}}`
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL, strings.NewReader(body))
		if err != nil {
			return result, err
		}
		req.Header.Set("Authorization", "Bearer alice")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2025-11-25")
		req.Header.Set("X-Request-ID", requestID)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return result, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return result, errors.New("unexpected HTTP status")
		}
		err = json.NewDecoder(resp.Body).Decode(&result)
		return result, err
	}
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	defer cancelFirst()
	firstDone := make(chan error, 1)
	go func() { _, err := call(firstCtx, "cancel-resolve"); firstDone <- err }()
	waitMaterialization(t, entered, "resolve callback")
	cancelFirst()
	waitMaterialization(t, canceled, "resolve cancellation")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	busy, err := call(ctx, "resolve-busy")
	if err != nil || !busy.Result.IsError || busy.Result.StructuredContent.Error.Code != "resource_busy" || calls.Load() != 1 {
		t.Fatalf("canceled callback did not retain Large permit: %+v calls=%d err=%v", busy, calls.Load(), err)
	}
	unblock()
	waitMaterialization(t, exited, "resolve callback exit")
	waitMaterialization(t, httpDone, "canceled resolve HTTP completion")
	select {
	case <-firstDone:
	case <-time.After(5 * time.Second):
		t.Fatal("canceled client did not finish")
	}
	after, err := call(ctx, "resolve-after")
	if err != nil || after.Result.IsError || after.Result.StructuredContent.Data["id"] != testProjectID || calls.Load() != 2 {
		t.Fatalf("Large permit not released after callback and HTTP: %+v calls=%d err=%v", after, calls.Load(), err)
	}
}

func TestMCPOutputConstructionFailureLog(t *testing.T) {
	f := newEntryFixture(t)
	var logs bytes.Buffer
	f.entry.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	client := f.client(t, "2026-07-28", "alice")
	result, err := callTest(t, client, map[string]any{"mode": "bad_output"})
	if err != nil || !result.IsError {
		t.Fatalf("output failure: %+v %v", result, err)
	}
	var record map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &record); err != nil {
		t.Fatalf("output log %q: %v", logs.String(), err)
	}
	for key, want := range map[string]string{"type": "operation_error", "component": "mcp", "operation": "test_only", "phase": "output", "cause": "output_invalid", "error_code": "internal_error", "request_id": "test-request"} {
		if record[key] != want {
			t.Fatalf("output log %s = %v; want %s", key, record[key], want)
		}
	}
}
