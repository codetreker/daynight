package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type taskResourceAuthenticator struct{ principal model.Principal }

func (a taskResourceAuthenticator) Authenticate(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	if kind != model.PATCredential || token != "alice" {
		return model.Principal{}, &model.Fault{Code: "unauthenticated", Message: "invalid credential"}
	}
	return a.principal, nil
}

func taskResourceClient(t *testing.T) (*sdk.ClientSession, string, model.Principal, *taskservice.Tasks, *postgres.Store, *Entry, *httptest.Server) {
	t.Helper()
	tasks, database, project, _, principal := testsupport.TaskService(t)
	principal.Kind = model.PATCredential
	principal.CredentialID = uuid.NewString()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(taskResourceAuthenticator{principal}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := RegisterTaskTools(entry, tasks); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(logger, entry))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
		server.Close()
	})
	fixture := &entryFixture{entry: entry, server: server}
	return fixture.client(t, "2026-07-28", "alice"), project.ID, principal, tasks, database, entry, server
}

func callTaskResource(t *testing.T, client *sdk.ClientSession, name string, args map[string]any) (*sdk.CallToolResult, map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return result, structured(t, result)
}

func taskData(t *testing.T, client *sdk.ClientSession, name string, args map[string]any) map[string]any {
	t.Helper()
	result, envelope := callTaskResource(t, client, name, args)
	if result.IsError {
		t.Fatalf("%s rejected: %#v", name, envelope)
	}
	return object(t, envelope["data"])
}

func taskError(t *testing.T, client *sdk.ClientSession, name string, args map[string]any, code string) {
	t.Helper()
	result, envelope := callTaskResource(t, client, name, args)
	if !result.IsError || object(t, envelope["error"])["code"] != code {
		t.Fatalf("%s expected %s: %#v", name, code, envelope)
	}
}

func TestMCPTaskResourcesDependenciesVersionsAndDeletion(t *testing.T) {
	client, project, principal, _, database, _, _ := taskResourceClient(t)
	prerequisite := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Prerequisite", "returnView": "full"})
	preID := prerequisite["id"].(string)
	task := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Dependent", "externalDependsOn": []string{preID}, "returnView": "full"})
	id := task["id"].(string)
	if task["assignedTo"] != principal.UserID || task["status"] != "todo" || task["allowAgents"] != false || task["projection"] != "full" || !reflect.DeepEqual(task["dependsOn"], []any{preID}) || !reflect.DeepEqual(task["externalDependsOn"], []any{preID}) {
		t.Fatalf("create defaults and external dependency: %#v", task)
	}
	key := map[string]any{"projectId": project, "taskId": id}
	show := taskData(t, client, "task_show", key)
	if show["projection"] != "summary" || show["version"] != "1" {
		t.Fatalf("default projection: %#v", show)
	}
	if _, present := show["description"]; present {
		t.Fatalf("summary included full content: %#v", show)
	}
	full := taskData(t, client, "task_show", map[string]any{"projectId": project, "taskId": id, "view": "full"})
	if full["projection"] != "full" || full["description"] != "" {
		t.Fatalf("explicit full view: %#v", full)
	}
	taskError(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "title": "Dependent", "ifVersion": "9223372036854775808"}, "invalid_input")
	taskError(t, client, "task_set_status", map[string]any{"projectId": project, "taskId": id, "status": "in_progress"}, "dependency_unsatisfied")
	taskError(t, client, "task_update", map[string]any{"projectId": project, "taskId": preID, "dependsOn": []string{id}}, "dependency_cycle")
	taskError(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "dependsOn": []string{preID}, "externalDependsOn": []string{preID}}, "invalid_input")
	taskError(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "dependsOn": []string{preID, preID}}, "invalid_input")

	task = taskData(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "dependsOn": []string{preID}, "ifVersion": "1", "returnView": "full"})
	if !reflect.DeepEqual(task["dependsOn"], []any{preID}) || !reflect.DeepEqual(task["externalDependsOn"], []any{}) || task["version"] != "2" {
		t.Fatalf("ordinary dependency reclassification: %#v", task)
	}
	taskError(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "dependsOn": []string{preID}, "ifVersion": "1"}, "version_conflict")
	task = taskData(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "description": "changed", "returnView": "full"})
	if !reflect.DeepEqual(task["dependsOn"], []any{preID}) || !reflect.DeepEqual(task["externalDependsOn"], []any{}) {
		t.Fatalf("omitted dependencies should remain: %#v", task)
	}
	task = taskData(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "externalDependsOn": []string{}, "returnView": "full"})
	if !reflect.DeepEqual(task["dependsOn"], []any{}) || !reflect.DeepEqual(task["externalDependsOn"], []any{}) {
		t.Fatalf("empty collection should clear both: %#v", task)
	}
	task = taskData(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "assignedTo": nil, "requiredPlatform": "linux", "returnView": "full"})
	if task["assignedTo"] != nil || task["requiredPlatform"] != "linux" {
		t.Fatalf("nullable assignment and platform: %#v", task)
	}
	task = taskData(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "requiredPlatform": nil, "returnView": "full"})
	if task["assignedTo"] != nil || task["requiredPlatform"] != nil {
		t.Fatalf("nullable platform clearing: %#v", task)
	}
	started := taskData(t, client, "task_set_status", map[string]any{"projectId": project, "taskId": id, "status": "in_progress"})
	if started["status"] != "in_progress" || started["projection"] != "summary" {
		t.Fatalf("start response: %#v", started)
	}
	taskError(t, client, "task_set_status", map[string]any{"projectId": project, "taskId": id, "status": "in_progress", "claimId": uuid.NewString()}, "invalid_input")
	var beforeEpoch string
	if err := database.Pool.QueryRow(context.Background(), "SELECT task_cache_epoch::text FROM projects WHERE id=$1", project).Scan(&beforeEpoch); err != nil {
		t.Fatal(err)
	}
	deleted := taskData(t, client, "task_delete", map[string]any{"projectId": project, "taskId": id})
	if deleted["projectId"] != project || deleted["taskId"] != id || deleted["deleted"] != true {
		t.Fatalf("delete receipt: %#v", deleted)
	}
	taskError(t, client, "task_show", key, "task_deleted")
	var deletedAt *time.Time
	var afterEpoch, title string
	if err := database.Pool.QueryRow(context.Background(), "SELECT deleted_at, title FROM tasks WHERE project_id=$1 AND id=$2", project, id).Scan(&deletedAt, &title); err != nil {
		t.Fatal(err)
	}
	if err := database.Pool.QueryRow(context.Background(), "SELECT task_cache_epoch::text FROM projects WHERE id=$1", project).Scan(&afterEpoch); err != nil {
		t.Fatal(err)
	}
	if deletedAt == nil || title != "Dependent" || beforeEpoch == afterEpoch {
		t.Fatalf("soft delete/cache state: deleted=%v title=%q before=%q after=%q", deletedAt, title, beforeEpoch, afterEpoch)
	}
}

func TestMCPTaskProperties(t *testing.T) {
	client, project, _, _, _, _, _ := taskResourceClient(t)
	task := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Properties"})
	id := task["id"].(string)
	schema := taskData(t, client, "task_properties", map[string]any{"mode": "schema"})
	if _, ok := object(t, schema["properties"])["pullRequests"]; !ok {
		t.Fatalf("missing property definition: %#v", schema)
	}
	taskError(t, client, "task_properties", map[string]any{"mode": "schema", "projectId": project}, "invalid_input")
	taskError(t, client, "task_properties", map[string]any{"mode": "values", "projectId": project}, "invalid_input")
	set := map[string]any{"projectId": project, "taskId": id, "name": "pullRequests", "valueText": "[]", "returnView": "full"}
	task = taskData(t, client, "task_set_property", set)
	if !reflect.DeepEqual(object(t, task["properties"])["pullRequests"], []any{}) {
		t.Fatalf("empty property: %#v", task)
	}
	values := taskData(t, client, "task_properties", map[string]any{"projectId": project, "taskId": id, "mode": "values"})
	if values["version"] != task["version"] || !reflect.DeepEqual(object(t, values["properties"])["pullRequests"], []any{}) {
		t.Fatalf("property resource: %#v", values)
	}
	taskError(t, client, "task_set_property", map[string]any{"projectId": project, "taskId": id, "name": "pullRequests", "valueText": "null"}, "invalid_input")
	taskError(t, client, "task_set_property", map[string]any{"projectId": project, "taskId": id, "name": "pullRequests", "valueText": "[]", "ifVersion": "1"}, "version_conflict")
	removed := taskData(t, client, "task_remove_property", map[string]any{"projectId": project, "taskId": id, "name": "pullRequests", "returnView": "full"})
	if _, exists := object(t, removed["properties"])["pullRequests"]; exists {
		t.Fatalf("property not removed: %#v", removed)
	}
	values = taskData(t, client, "task_properties", map[string]any{"projectId": project, "taskId": id, "mode": "values"})
	if _, exists := object(t, values["properties"])["pullRequests"]; exists {
		t.Fatalf("property not removed in read: %#v", values)
	}
}

func TestMCPTaskCompletesOnlyExplicitClaim(t *testing.T) {
	client, project, principal, tasks, _, _, _ := taskResourceClient(t)
	task := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Claim"})
	id := task["id"].(string)
	taskData(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "allowAgents": true})
	current, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "test machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, WorktreeID: uuid.NewString()}
	claimed, err := tasks.ClaimWorker(context.Background(), principal, project, id, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
	if err != nil {
		t.Fatal(err)
	}
	taskError(t, client, "task_set_status", map[string]any{"projectId": project, "taskId": id, "status": "done", "claimId": uuid.NewString(), "ifVersion": Decimal(claimed.Version)}, "claim_conflict")
	done := taskData(t, client, "task_set_status", map[string]any{"projectId": project, "taskId": id, "status": "done", "claimId": descriptor.ClaimID, "ifVersion": Decimal(claimed.Version), "returnView": "full"})
	worker := object(t, object(t, done["properties"])["worker"])
	if done["status"] != "done" || worker["state"] != "completed" || worker["claimId"] != descriptor.ClaimID {
		t.Fatalf("claim completion: %#v", done)
	}
}

func TestMCPTaskPropertyBudgetFollowsMode(t *testing.T) {
	client, project, _, _, _, entry, _ := taskResourceClient(t)
	task := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Budget"})
	id := task["id"].(string)
	release, err := entry.budget.Acquire(context.Background(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	schema := taskData(t, client, "task_properties", map[string]any{"mode": "schema"})
	if _, ok := object(t, schema["properties"])["paused"]; !ok {
		t.Fatalf("schema response: %#v", schema)
	}
	taskError(t, client, "task_properties", map[string]any{"mode": "values", "projectId": project, "taskId": id}, "resource_busy")
	release()
	values := taskData(t, client, "task_properties", map[string]any{"mode": "values", "projectId": project, "taskId": id})
	if values["taskId"] != id {
		t.Fatalf("property response: %#v", values)
	}
}

func TestMCPTaskBusinessJSONLimit(t *testing.T) {
	client, project, principal, tasks, _, _, _ := taskResourceClient(t)
	// The REST create body is the corresponding business JSON; transport-only
	// projectId and returnView fields do not consume its one MiB allowance.
	base, err := json.Marshal(map[string]any{"title": "Limit", "description": ""})
	if err != nil {
		t.Fatal(err)
	}
	description := strings.Repeat("x", (1<<20)-len(base))
	data := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Limit", "description": description})
	got, err := tasks.Get(context.Background(), principal, project, data["id"].(string))
	if err != nil || got.Description != description {
		t.Fatalf("exact-limit content: length=%d err=%v", len(got.Description), err)
	}
	taskError(t, client, "task_create", map[string]any{"projectId": project, "title": "Limit", "description": description + "x"}, "invalid_input")
}

func TestMCPTaskRejectsDuplicateVersionBeforeWrite(t *testing.T) {
	client, project, principal, tasks, _, _, server := taskResourceClient(t)
	task := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Original"})
	id := task["id"].(string)
	before, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_update","arguments":{"projectId":%q,"taskId":%q,"ifVersion":"1","ifVersion":"2","title":"Changed"}}}`, project, id)
	req, err := http.NewRequest(http.MethodPost, server.URL, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer alice")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	httpClient := &http.Client{Timeout: 10 * time.Second}
	response, err := httpClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result struct {
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !result.Result.IsError || result.Result.StructuredContent.Error.Code != "invalid_input" {
		t.Fatalf("duplicate response: status=%d result=%#v", response.StatusCode, result)
	}
	after, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("duplicate version changed task: before=%#v after=%#v err=%v", before, after, err)
	}
}

func TestMCPTaskPropertyBusinessLimitCountsEncodedText(t *testing.T) {
	client, project, principal, tasks, _, _, _ := taskResourceClient(t)
	task := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Property limit"})
	id := task["id"].(string)
	before, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil {
		t.Fatal(err)
	}
	valueText, err := json.Marshal([]map[string]string{{"url": strings.Repeat(`"`, 350000), "title": "Quoted"}})
	if err != nil {
		t.Fatal(err)
	}
	restBody, err := json.Marshal(map[string]any{"version": before.Version, "valueText": string(valueText)})
	if err != nil {
		t.Fatal(err)
	}
	if len(valueText) >= 1<<20 || len(restBody) <= 1<<20 {
		t.Fatalf("fixture does not cross encoded limit: text=%d body=%d", len(valueText), len(restBody))
	}
	taskError(t, client, "task_set_property", map[string]any{"projectId": project, "taskId": id, "name": "pullRequests", "valueText": string(valueText), "ifVersion": Decimal(before.Version)}, "invalid_input")
	after, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("oversized property changed task: err=%v", err)
	}
}

func TestMCPTaskBusinessLimitDoesNotEscapeRawHTML(t *testing.T) {
	_, project, principal, tasks, _, _, server := taskResourceClient(t)
	base, err := json.Marshal(map[string]any{"title": "HTML", "description": ""})
	if err != nil {
		t.Fatal(err)
	}
	description := strings.Repeat("<", (1<<20)-len(base))
	body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_create","arguments":{"projectId":%q,"title":"HTML","description":"%s"}}}`, project, description)
	req, err := http.NewRequest(http.MethodPost, server.URL, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer alice")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result struct {
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Data struct {
					ID string `json:"id"`
				} `json:"data"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || result.Result.IsError || result.Result.StructuredContent.Data.ID == "" {
		t.Fatalf("raw HTML at limit rejected: status=%d result=%#v", response.StatusCode, result)
	}
	got, err := tasks.Get(context.Background(), principal, project, result.Result.StructuredContent.Data.ID)
	if err != nil || got.Description != description {
		t.Fatalf("raw HTML content: length=%d err=%v", len(got.Description), err)
	}
}

// A successful commit with a lost receipt is indistinguishable from an
// unsuccessful commit to the caller, so the adapter must not replay it.
type taskUnknownStore struct {
	*postgres.Store
	reads  int
	writes int
}

func (s *taskUnknownStore) ReadSnapshot(ctx context.Context, read func(store.SnapshotScope) error) error {
	s.reads++
	return s.Store.ReadSnapshot(ctx, read)
}

func (s *taskUnknownStore) WriteProject(ctx context.Context, project string, write func(store.ProjectWriteScope) error) (store.Completion, error) {
	s.writes++
	completion, err := s.Store.WriteProject(ctx, project, write)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		return completion, err
	}
	return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("commit response lost")}
}

func TestMCPTaskUnknownCommitIsNotReplayed(t *testing.T) {
	original, project, principal, tasks, database, _, _ := taskResourceClient(t)
	task := taskData(t, original, "task_create", map[string]any{"projectId": project, "title": "Before"})
	id := task["id"].(string)
	wrapped := &taskUnknownStore{Store: database}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(taskResourceAuthenticator{principal}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := RegisterTaskTools(entry, taskservice.NewTasks(wrapped)); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(logger, entry))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
		server.Close()
	})
	client := (&entryFixture{entry: entry, server: server}).client(t, "2026-07-28", "alice")
	result, envelope := callTaskResource(t, client, "task_update", map[string]any{"projectId": project, "taskId": id, "title": "After"})
	failure := object(t, envelope["error"])
	if !result.IsError || failure["writeOutcome"] != "unknown" || failure["phase"] != "commit" {
		t.Fatalf("unknown result: %#v", envelope)
	}
	if wrapped.reads != 1 || wrapped.writes != 1 {
		t.Fatalf("operation replayed: reads=%d writes=%d", wrapped.reads, wrapped.writes)
	}
	actual, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil || actual.Title != "After" || actual.Version != 2 {
		t.Fatalf("committed state after lost response: %#v %v", actual, err)
	}
}

func TestMCPTaskExternalDependenciesCountCompiledBusinessPayload(t *testing.T) {
	client, project, _, _, database, _, _ := taskResourceClient(t)
	dependencies := make([]string, 14000)
	for i := range dependencies {
		dependencies[i] = uuid.NewString()
	}
	input, err := json.Marshal(map[string]any{"title": "Large", "externalDependsOn": dependencies})
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := json.Marshal(map[string]any{"title": "Large", "dependsOn": dependencies, "externalDependsOn": dependencies})
	if err != nil {
		t.Fatal(err)
	}
	if len(input) >= 1<<20 || len(compiled) <= 1<<20 {
		t.Fatalf("fixture does not cross compiled limit: input=%d compiled=%d", len(input), len(compiled))
	}
	result, envelope := callTaskResource(t, client, "task_create", map[string]any{"projectId": project, "title": "Large", "externalDependsOn": dependencies})
	failure := object(t, envelope["error"])
	if !result.IsError || failure["code"] != "invalid_input" || !strings.Contains(failure["message"].(string), "1 MiB") {
		t.Fatalf("compiled payload not rejected at size limit: %#v", envelope)
	}
	var count int
	if err := database.Pool.QueryRow(context.Background(), "SELECT count(*) FROM tasks WHERE project_id=$1", project).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("oversized dependency payload created %d tasks", count)
	}
}

func TestMCPTaskUnchangedMutationReceipt(t *testing.T) {
	client, project, _, _, _, _, _ := taskResourceClient(t)
	task := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Unchanged"})
	result, envelope := callTaskResource(t, client, "task_update", map[string]any{"projectId": project, "taskId": task["id"], "ifVersion": task["version"], "title": "Unchanged"})
	if result.IsError || object(t, envelope["meta"])["outcome"] != "unchanged" || object(t, envelope["data"])["version"] != task["version"] {
		t.Fatalf("unchanged receipt: %#v", envelope)
	}
}

func TestMCPRejectsUnknownToolBudgetClass(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	tool := simpleTestTool("invalid_budget", testObjectSchema(), standardOutputSchema())
	err = entry.RegisterTool(tool, BudgetClass(255), func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		t.Fatal("invalid-budget handler invoked")
		return ToolResult{}, nil
	})
	if err == nil {
		t.Fatal("unknown budget class registered")
	}
}
