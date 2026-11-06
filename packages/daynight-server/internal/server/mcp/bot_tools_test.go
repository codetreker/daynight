package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const botTestID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const deletionTestID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

type fakeBotOperations struct {
	bot                               model.Bot
	page                              botcore.BotPage
	principal                         model.Principal
	createInput                       botcore.CreateBot
	pageInput                         model.PageRequest
	readID                            string
	createCalls, listCalls, readCalls int
	err                               error
}

func (f *fakeBotOperations) CreateResolved(_ context.Context, p model.Principal, in botcore.CreateBot) (model.Bot, error) {
	f.createCalls++
	f.principal = p
	f.createInput = in
	out := f.bot
	out.ID = in.ID
	return out, f.err
}
func (f *fakeBotOperations) Get(_ context.Context, p model.Principal, id string) (model.Bot, error) {
	f.readCalls++
	f.principal = p
	f.readID = id
	return f.bot, f.err
}
func (f *fakeBotOperations) List(_ context.Context, p model.Principal, page model.PageRequest) (botcore.BotPage, error) {
	f.listCalls++
	f.principal = p
	f.pageInput = page
	return f.page, f.err
}

type fakeBotDeletion struct {
	bot       model.Bot
	principal model.Principal
	id        string
	input     store.DeleteBot
	calls     int
	err       error
}

func (f *fakeBotDeletion) DeleteBot(_ context.Context, p model.Principal, id string, in store.DeleteBot) (model.Bot, error) {
	f.calls++
	f.principal = p
	f.id = id
	f.input = in
	return f.bot, f.err
}
func sampleBot() model.Bot {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Bot{ID: botTestID, OwnerUserID: "alice", WorkerID: testTargetID, Name: "bot", Version: 9007199254740993, CreationOrder: 9007199254740994,
		ResolvedConfiguration: model.BotConfiguration{WorkerID: testTargetID, Cwd: "/tmp", Provider: "codex", Args: []string{}},
		StartupResult:         model.BotStartupResult{State: "pending"}, CreatedAt: now, UpdatedAt: now}
}
func TestBotToolHTTPContract(t *testing.T) {
	f := newEntryFixture(t)
	bot := sampleBot()
	next := "opaque-next"
	ops := &fakeBotOperations{bot: bot, page: botcore.BotPage{Items: []model.Bot{bot}, NextCursor: &next}}
	relay := &fakeBotDeletion{bot: bot}
	if err := RegisterBotTools(f.entry, ops, relay); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range list.Tools {
		names[tool.Name] = true
	}
	for _, name := range []string{"bot_list", "bot_show", "bot_create", "bot_delete"} {
		if !names[name] {
			t.Fatalf("missing tool %s", name)
		}
	}
	call := func(name string, args any) *sdk.CallToolResult {
		t.Helper()
		r, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	result := call("bot_list", map[string]any{})
	if result.IsError || ops.pageInput.Limit != 50 || ops.pageInput.Cursor != nil || ops.principal.CredentialID != "credential-alice" {
		t.Fatalf("list: %+v page=%+v", structured(t, result), ops.pageInput)
	}
	page := object(t, structured(t, result)["data"])
	items, ok := page["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("list output: %+v", page)
	}
	cursor, ok := page["nextCursor"].(string)
	if !ok {
		t.Fatalf("missing cursor: %+v", page)
	}
	decoded, err := query.ListPage(model.PageRequest{Limit: 1, Cursor: &cursor}, query.ListScope{Kind: "bots", WorkerUserID: ptr("alice")})
	if err != nil || decoded.After == nil || decoded.After.ID != botTestID {
		t.Fatalf("cursor: %+v %v", decoded, err)
	}
	item := object(t, items[0])
	if item["version"] != "9007199254740993" || object(t, item["startupResult"])["state"] != "pending" {
		t.Fatalf("bot facts: %+v", item)
	}
	result = call("bot_list", map[string]any{"limit": 1, "cursor": "previous"})
	if result.IsError || ops.pageInput.Limit != 1 || ops.pageInput.Cursor == nil || *ops.pageInput.Cursor != "previous" {
		t.Fatalf("page input: %+v", ops.pageInput)
	}
	calls := ops.listCalls
	result = call("bot_list", map[string]any{"limit": 101})
	if !result.IsError || ops.listCalls != calls {
		t.Fatal("invalid limit reached business service")
	}
	result = call("bot_show", map[string]any{"botId": botTestID})
	if result.IsError || ops.readID != botTestID || object(t, structured(t, result)["data"])["id"] != botTestID {
		t.Fatalf("show %+v", structured(t, result))
	}
	result = call("bot_create", map[string]any{"name": "new", "requestId": botTestID})
	if result.IsError || ops.createInput.ID != botTestID || ops.createInput.Name != "new" || ops.createInput.Overrides.WorkerID != nil || ops.createInput.Overrides.Cwd != nil || ops.createInput.Overrides.Provider != nil {
		t.Fatalf("default create input %+v, output %+v", ops.createInput, structured(t, result))
	}
	result = call("bot_create", map[string]any{"name": "new", "workerId": testTargetID, "cwd": "/work", "agent": "claude"})
	in := ops.createInput
	if result.IsError || in.ID == "" || in.Overrides.WorkerID == nil || *in.Overrides.WorkerID != testTargetID || in.Overrides.Cwd == nil || *in.Overrides.Cwd != "/work" || in.Overrides.Provider == nil || *in.Overrides.Provider != "claude" || object(t, structured(t, result)["data"])["id"] != in.ID {
		t.Fatalf("override create %+v output %+v", in, structured(t, result))
	}
	relay.bot.Deletion = &model.BotDeletion{DeletionID: deletionTestID, RequestedVersion: bot.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "completed"}}
	result = call("bot_delete", map[string]any{"botId": botTestID, "ifVersion": "9007199254740993", "requestId": deletionTestID})
	if result.IsError || relay.calls != 1 || relay.id != botTestID || relay.input.Version != bot.Version || relay.input.DeletionID != deletionTestID {
		t.Fatalf("delete %+v result %+v", relay, structured(t, result))
	}
	deleted := object(t, structured(t, result)["data"])
	cleanup := object(t, deleted["deletion"])
	if _, exists := deleted["name"]; exists || object(t, cleanup["workerCleanup"])["state"] != "pending" || object(t, cleanup["serverCleanup"])["state"] != "completed" {
		t.Fatalf("deletion facts %+v", deleted)
	}
	for _, version := range []any{nil, "0", "01", "9223372036854775808", 1} {
		args := map[string]any{"botId": botTestID}
		if version != nil {
			args["ifVersion"] = version
		}
		calls = relay.calls
		result = call("bot_delete", args)
		if !result.IsError || relay.calls != calls {
			t.Fatalf("bad version %v accepted", version)
		}
	}
}

func TestBotUnknownWriteRetainsOriginalIDs(t *testing.T) {
	f := newEntryFixture(t)
	unknown := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("lost receipt")}
	ops := &fakeBotOperations{bot: sampleBot(), err: unknown}
	relay := &fakeBotDeletion{err: unknown}
	if err := RegisterBotTools(f.entry, ops, relay); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	call := func(name string, args any) map[string]any {
		t.Helper()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || !result.IsError {
			t.Fatalf("call %s: %+v %v", name, result, err)
		}
		return object(t, structured(t, result)["error"])
	}
	e := call("bot_create", map[string]any{"name": "new"})
	refs := object(t, e["refs"])
	if e["writeOutcome"] != "unknown" || refs["botId"] != ops.createInput.ID || ops.createCalls != 1 {
		t.Fatalf("unknown create: %+v input %+v", e, ops.createInput)
	}
	e = call("bot_delete", map[string]any{"botId": botTestID, "ifVersion": "1"})
	refs = object(t, e["refs"])
	if e["writeOutcome"] != "unknown" || refs["botId"] != botTestID || refs["deletionId"] != relay.input.DeletionID || relay.input.DeletionID == "" || relay.calls != 1 {
		t.Fatalf("unknown delete: %+v input %+v", e, relay.input)
	}
}

func TestBotWriteOutputFailurePreservesCompletion(t *testing.T) {
	f := newEntryFixture(t)
	bot := sampleBot()
	bot.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	ops := &fakeBotOperations{bot: bot}
	relay := &fakeBotDeletion{bot: bot}
	if err := RegisterBotTools(f.entry, ops, relay); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "bot_create", Arguments: map[string]any{"name": "new", "requestId": botTestID}})
	if err != nil || !result.IsError {
		t.Fatalf("output failure: %+v %v", result, err)
	}
	failure := object(t, structured(t, result)["error"])
	if failure["writeOutcome"] != "confirmed" || failure["phase"] != "output" || object(t, failure["refs"])["botId"] != botTestID || ops.createCalls != 1 {
		t.Fatalf("completion facts: %+v", failure)
	}
}

func TestBotCreateBodySize(t *testing.T) {
	name := "a\"\\\n\t\x01\u2028\u2029"
	worker, cwd, provider := testTargetID, "/tmp/\"x\"\n\u2028", "codex"
	tests := []struct {
		name      string
		overrides model.BotOverrides
		want      string
	}{
		{"omitted", model.BotOverrides{}, `{"id":"` + botTestID + `","name":"a\"\\\n\t\u0001` + "\u2028\u2029" + `"}`},
		{"worker", model.BotOverrides{WorkerID: &worker}, `{"id":"` + botTestID + `","name":"a\"\\\n\t\u0001` + "\u2028\u2029" + `","overrides":{"workerId":"` + worker + `"}}`},
		{"cwd", model.BotOverrides{Cwd: &cwd}, `{"id":"` + botTestID + `","name":"a\"\\\n\t\u0001` + "\u2028\u2029" + `","overrides":{"cwd":"/tmp/\"x\"\n` + "\u2028" + `"}}`},
		{"all", model.BotOverrides{WorkerID: &worker, Cwd: &cwd, Provider: &provider}, `{"id":"` + botTestID + `","name":"a\"\\\n\t\u0001` + "\u2028\u2029" + `","overrides":{"workerId":"` + worker + `","cwd":"/tmp/\"x\"\n` + "\u2028" + `","provider":"codex"}}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := botCreateBodySize(botTestID, name, tc.overrides); got != len(tc.want) {
				t.Fatalf("got %d, want %d from %s", got, len(tc.want), tc.want)
			}
		})
	}

	f := newEntryFixture(t)
	ops := &fakeBotOperations{bot: sampleBot()}
	if err := RegisterBotTools(f.entry, ops, &fakeBotDeletion{}); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	overhead := botCreateBodySize(botTestID, "", model.BotOverrides{})
	for _, extra := range []int{0, 1} {
		input := strings.Repeat("a", httpx.MaxJSONBody-overhead+extra)
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "bot_create", Arguments: map[string]any{"name": input, "requestId": botTestID}})
		if err != nil {
			t.Fatal(err)
		}
		if result.IsError != (extra == 1) || ops.createCalls != 1 {
			t.Fatalf("boundary %d: error=%v calls=%d", extra, result.IsError, ops.createCalls)
		}
	}
}

func TestBotOperationIDsCanonicalized(t *testing.T) {
	f := newEntryFixture(t)
	ops := &fakeBotOperations{bot: sampleBot()}
	relay := &fakeBotDeletion{bot: sampleBot()}
	if err := RegisterBotTools(f.entry, ops, relay); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	call := func(name string, args any) {
		t.Helper()
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result.IsError {
			t.Fatalf("%s: %+v %v", name, result, err)
		}
	}
	call("bot_create", map[string]any{"name": "bot", "requestId": strings.ToUpper(botTestID)})
	if ops.createInput.ID != botTestID {
		t.Fatalf("create ID: %q", ops.createInput.ID)
	}
	call("bot_delete", map[string]any{"botId": strings.ToUpper(botTestID), "ifVersion": "1", "requestId": strings.ToUpper(deletionTestID)})
	if relay.id != botTestID || relay.input.DeletionID != deletionTestID {
		t.Fatalf("delete IDs: %s %s", relay.id, relay.input.DeletionID)
	}
}

func TestBotListBudgetReturnsResumableCursor(t *testing.T) {
	ops := &fakeBotOperations{}
	for i := 0; i < 5; i++ {
		bot := sampleBot()
		bot.ID = fmt.Sprintf("%08x-aaaa-4aaa-8aaa-aaaaaaaaaaaa", i+1)
		bot.RoleConfiguration = &model.BotRoleConfiguration{Instructions: strings.Repeat("a", 5000)}
		ops.page.Items = append(ops.page.Items, bot)
	}
	h := botTools{bots: ops}
	actor := RequestActor{Principal: model.Principal{UserID: "alice"}, RequestID: "test-request"}
	result, err := h.list(context.Background(), actor, botListInput{})
	if err != nil {
		t.Fatal(err)
	}
	page := result.Data.(botPage)
	if len(page.Items) == 0 || len(page.Items) >= len(ops.page.Items) || page.NextCursor == nil {
		t.Fatalf("page: %+v", page)
	}
	parsed, err := query.ListPage(model.PageRequest{Limit: 1, Cursor: page.NextCursor}, query.ListScope{Kind: "bots", WorkerUserID: ptr("alice")})
	if err != nil || parsed.After == nil || parsed.After.ID != page.Items[len(page.Items)-1].ID {
		t.Fatalf("cursor: %+v %v", parsed, err)
	}
	ops.page.Items = ops.page.Items[:1]
	ops.page.Items[0].RoleConfiguration.Instructions = strings.Repeat("a", 17000)
	result, err = h.list(context.Background(), actor, botListInput{})
	if err == nil || result.Refs["botId"] != ops.page.Items[0].ID || result.Refs["readTool"] != "bot_show" {
		t.Fatalf("oversized first Bot: %+v %v", result, err)
	}
	cursor, ok := result.Refs["cursorAfterItem"].(string)
	if !ok {
		t.Fatalf("missing cursor: %+v", result.Refs)
	}
	parsed, err = query.ListPage(model.PageRequest{Limit: 1, Cursor: &cursor}, query.ListScope{Kind: "bots", WorkerUserID: ptr("alice")})
	if err != nil || parsed.After == nil || parsed.After.ID != ops.page.Items[0].ID {
		t.Fatalf("recovery cursor: %+v %v", parsed, err)
	}
}

func TestBotDeleteCleanupFailureRetainsBarrier(t *testing.T) {
	f := newEntryFixture(t)
	cause := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: errors.New("cleanup failed")}
	relay := &fakeBotDeletion{err: &botservice.DeletionCleanupError{Cause: cause}}
	if err := RegisterBotTools(f.entry, &fakeBotOperations{}, relay); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "bot_delete", Arguments: map[string]any{"botId": botTestID, "ifVersion": "1", "requestId": deletionTestID}})
	if err != nil || !result.IsError {
		t.Fatalf("delete: %+v %v", result, err)
	}
	failure := object(t, structured(t, result)["error"])
	refs := object(t, failure["refs"])
	if failure["writeOutcome"] != "confirmed" || failure["phase"] != "cleanup" || refs["botId"] != botTestID || refs["deletionId"] != deletionTestID || relay.calls != 1 {
		t.Fatalf("cleanup facts: %+v", failure)
	}
}

func TestBotRegistrationRejectsInvalidDefinitions(t *testing.T) {
	original := botToolsJSON
	t.Cleanup(func() { botToolsJSON = original })
	botToolsJSON = []byte("[")
	fixture := newEntryFixture(t)
	if err := RegisterBotTools(fixture.entry, &fakeBotOperations{}, &fakeBotDeletion{}); err == nil {
		t.Fatal("malformed definitions accepted")
	}
	var definitions []map[string]any
	if err := json.Unmarshal(original, &definitions); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"bot_list", "bot_show", "bot_create", "bot_delete"} {
		t.Run(name, func(t *testing.T) {
			var remaining []map[string]any
			for _, definition := range definitions {
				if definition["name"] != name {
					remaining = append(remaining, definition)
				}
			}
			var err error
			botToolsJSON, err = json.Marshal(remaining)
			if err != nil {
				t.Fatal(err)
			}
			fixture := newEntryFixture(t)
			if err := RegisterBotTools(fixture.entry, &fakeBotOperations{}, &fakeBotDeletion{}); err == nil {
				t.Fatalf("missing %s definition accepted", name)
			}
		})
	}
}

func TestBotShowPreservesBusinessRefusal(t *testing.T) {
	fixture := newEntryFixture(t)
	ops := &fakeBotOperations{err: &model.Fault{Code: "forbidden", Message: "Bot access denied."}}
	if err := RegisterBotTools(fixture.entry, ops, &fakeBotDeletion{}); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "bot_show", Arguments: map[string]any{"botId": botTestID}})
	if err != nil || !result.IsError {
		t.Fatalf("show refusal: %+v %v", result, err)
	}
	failure := object(t, structured(t, result)["error"])
	if failure["code"] != "forbidden" || failure["message"] != "Bot access denied." || failure["requestId"] != "test-request" || ops.readCalls != 1 || ops.readID != botTestID {
		t.Fatalf("show refusal: %+v calls=%d id=%s", failure, ops.readCalls, ops.readID)
	}
}
