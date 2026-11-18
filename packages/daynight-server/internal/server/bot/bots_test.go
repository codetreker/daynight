package bot_test

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

const (
	botDefinitionsID        = "a0000000-0000-4000-8000-000000000001"
	botDefinitionsOtherID   = "a0000000-0000-4000-8000-000000000002"
	botDefinitionsWorker    = "b0000000-0000-4000-8000-000000000001"
	botDefinitionsIntent    = "c0000000-0000-4000-8000-000000000001"
	botDefinitionsBase      = "/api/v1/me/bots"
	botDefinitionsPath      = botDefinitionsBase + "/" + botDefinitionsID
	botDefinitionsInventory = "/api/v1/me/workers/" + botDefinitionsWorker + "/bots"
)

func TestBotsHTTPEmptyList(t *testing.T) {
	f := newBotDefinitionsFixture(t, io.Discard)
	response := f.request("GET", botDefinitionsBase, "", &botDefinitionCall{
		method: "List", input: model.PageRequest{Limit: 50}, result: botcore.BotPage{},
	})
	page := decodeResponse[api.BotPage](t, response, http.StatusOK)
	if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("invalid empty bot page: %s", response.Body)
	}
}

func TestBotsHTTPReadDeleteIntentAndWorkerInventory(t *testing.T) {
	var logs bytes.Buffer
	f := newBotDefinitionsFixture(t, &logs)
	const large int64 = 9007199254740993
	instant := time.Date(2026, 11, 8, 8, 0, 0, 0, time.FixedZone("fixture", 7*60*60))
	definition := func(id string, order, version int64) model.Bot {
		return model.Bot{ID: id, WorkerID: botDefinitionsWorker, OwnerUserID: f.principal.UserID,
			Name: "长期助手", Version: version, CreationOrder: order, RequestFingerprint: "private-fingerprint",
			ResolvedConfiguration: model.BotConfiguration{WorkerID: botDefinitionsWorker, Cwd: "/private/bot-work", Provider: "codex", Args: []string{}},
			StartupResult:         model.BotStartupResult{State: "pending"}, CreatedAt: instant, UpdatedAt: instant.Add(time.Second)}
	}
	cursor := "owner-page+cursor/1="
	page := decodeResponse[api.BotPage](t, f.request("GET", botDefinitionsBase+"?limit=1", "", &botDefinitionCall{
		method: "List", input: model.PageRequest{Limit: 1},
		result: botcore.BotPage{Items: []model.Bot{definition(botDefinitionsID, 1, 1)}, NextCursor: &cursor},
	}), 200)
	if len(page.Items) != 1 || page.Items[0].ID != botDefinitionsID || page.NextCursor == nil || *page.NextCursor != cursor {
		t.Fatalf("page: %+v", page)
	}
	next := decodeResponse[api.BotPage](t, f.request("GET", botDefinitionsBase+"?limit=1&cursor="+url.QueryEscape(*page.NextCursor), "", &botDefinitionCall{
		method: "List", input: model.PageRequest{Limit: 1, Cursor: &cursor},
		result: botcore.BotPage{Items: []model.Bot{definition(botDefinitionsOtherID, 2, 1)}},
	}), 200)
	if len(next.Items) != 1 || next.Items[0].ID != botDefinitionsOtherID || next.NextCursor != nil {
		t.Fatalf("next: %+v", next)
	}
	assertProjectError(t, f.request("GET", botDefinitionsInventory+"?cursor="+url.QueryEscape(cursor), "", &botDefinitionCall{
		method: "ListWorker", id: botDefinitionsWorker, input: model.PageRequest{Limit: 50, Cursor: &cursor},
		err: &model.Fault{Code: "invalid_input", Message: "Invalid Bot cursor."},
	}), 400, "invalid_input")

	response := f.request("GET", botDefinitionsBase+"/"+strings.ToUpper(botDefinitionsID), "", &botDefinitionCall{
		method: "Get", id: botDefinitionsID, result: definition(botDefinitionsID, 1, large),
	})
	read := decodeResponse[api.Bot](t, response, 200)
	wantRead := api.Bot{ID: botDefinitionsID, WorkerID: botDefinitionsWorker, Version: large, BotDefinition: &api.BotDefinition{
		OwnerUserID: f.principal.UserID, Name: "长期助手", CreationOrder: 1,
		ResolvedConfiguration: api.BotConfiguration{WorkerID: botDefinitionsWorker, Cwd: "/private/bot-work", Provider: "codex", Args: []string{}},
		StartupResult:         api.BotResult{State: "pending"}, CreatedAt: instant.UTC(), UpdatedAt: instant.Add(time.Second).UTC(),
	}}
	if !reflect.DeepEqual(read, wantRead) {
		t.Fatalf("read: %s", response.Body)
	}
	if !strings.Contains(response.Body.String(), `"version":"9007199254740993"`) ||
		!strings.Contains(response.Body.String(), `"creationOrder":"1"`) ||
		strings.Contains(response.Body.String(), "requestFingerprint") || strings.Contains(response.Body.String(), "private-fingerprint") {
		t.Fatal(response.Body.String())
	}

	deletedFact := func() model.Bot {
		bot := definition(botDefinitionsID, 1, large+1)
		cwd := "/private/bot-work"
		session, execution := "d0000000-0000-4000-8000-000000000001", "d0000000-0000-4000-8000-000000000002"
		bot.RequestedOverrides = model.BotOverrides{Cwd: &cwd}
		bot.SessionID, bot.TestExecutionID = &session, &execution
		bot.RoleConfiguration = &model.BotRoleConfiguration{Instructions: "private role", Revision: "1", Digest: "private role digest"}
		bot.Deletion = &model.BotDeletion{DeletionID: botDefinitionsIntent, RequestedVersion: large,
			WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
		return bot
	}
	wantDeleted := api.Bot{ID: botDefinitionsID, WorkerID: botDefinitionsWorker, Version: large + 1,
		Deletion: &api.BotDeletion{DeletionID: botDefinitionsIntent, RequestedVersion: large,
			WorkerCleanup: api.BotResult{State: "pending"}, ServerCleanup: api.BotResult{State: "pending"}}}
	checkDeleted := func(response *httptest.ResponseRecorder) {
		t.Helper()
		intention := decodeResponse[api.Bot](t, response, http.StatusOK)
		if !reflect.DeepEqual(intention, wantDeleted) || response.Body.String() != jsonBody(t, wantDeleted)+"\n" {
			t.Fatalf("invalid deletion receipt or private definition exposed: %s", response.Body)
		}
	}
	remove := func(id string, result model.Bot, err error) *httptest.ResponseRecorder {
		t.Helper()
		input := store.DeleteBot{Version: large, DeletionID: id}
		body := jsonBody(t, map[string]string{"ifVersion": "9007199254740993", "deletionId": id})
		return f.request("DELETE", botDefinitionsPath, body, &botDefinitionCall{method: "DeleteBot", id: botDefinitionsID, input: input, result: result, err: err})
	}
	checkDeleted(remove(botDefinitionsIntent, deletedFact(), nil))
	checkDeleted(remove(botDefinitionsIntent, deletedFact(), nil))
	assertProjectError(t, remove("c0000000-0000-4000-8000-000000000002", model.Bot{},
		&model.Fault{Code: "resource_conflict", Message: "Bot deletion belongs to a different request."}), 409, "resource_conflict")

	visible := decodeResponse[api.BotPage](t, f.request("GET", botDefinitionsBase, "", &botDefinitionCall{
		method: "List", input: model.PageRequest{Limit: 50}, result: botcore.BotPage{Items: []model.Bot{definition(botDefinitionsOtherID, 2, 1)}},
	}), 200)
	if len(visible.Items) != 1 || visible.Items[0].ID != botDefinitionsOtherID {
		t.Fatal("deleted bot remains in normal list")
	}
	inventory := decodeResponse[api.BotPage](t, f.request("GET", botDefinitionsInventory, "", &botDefinitionCall{
		method: "ListWorker", id: botDefinitionsWorker, input: model.PageRequest{Limit: 50},
		result: botcore.BotPage{Items: []model.Bot{deletedFact(), definition(botDefinitionsOtherID, 2, 1)}},
	}), 200)
	if len(inventory.Items) != 2 || !reflect.DeepEqual(inventory.Items[0], wantDeleted) || inventory.Items[1].ID != botDefinitionsOtherID {
		t.Fatalf("invalid worker inventory: %+v", inventory)
	}
	checkDeleted(f.request("GET", botDefinitionsPath, "", &botDefinitionCall{method: "Get", id: botDefinitionsID, result: deletedFact()}))
	for _, private := range []string{"/private/bot-work", "长期助手", "private role", "private-fingerprint"} {
		if strings.Contains(logs.String(), private) {
			t.Fatalf("bot content leaked into logs: %q", private)
		}
	}
}

func TestBotsHTTPStrictInputAndAuthentication(t *testing.T) {
	f := newBotDefinitionsFixture(t, io.Discard)
	for _, body := range []string{`{}`, `null`, `[]`, `{"ifVersion":1}`, `{"ifVersion":null}`, `{"ifVersion":"01"}`, `{"ifVersion":"+1"}`, `{"ifVersion":"0"}`, `{"ifVersion":"9223372036854775808"}`, `{"ifVersion":"1"}`, `{"ifVersion":"1","deletionId":null}`, `{"ifVersion":"1","deletionId":"` + botDefinitionsIntent + `","extra":true}`} {
		assertProjectError(t, f.request("DELETE", botDefinitionsPath, body, nil), 400, "invalid_input")
	}
	assertProjectError(t, f.request("DELETE", botDefinitionsPath, `{"ifVersion":"1","deletionId":"bad"}`, &botDefinitionCall{
		method: "DeleteBot", id: botDefinitionsID, input: store.DeleteBot{Version: 1, DeletionID: "bad"},
		err: &model.Fault{Code: "invalid_input", Message: "Invalid deletion ID."},
	}), 400, "invalid_input")
	for _, path := range []string{botDefinitionsPath + "?x=1", botDefinitionsPath + "?", botDefinitionsBase + "/bad", botDefinitionsBase + "?limit=0", botDefinitionsBase + "?unexpected=1"} {
		assertProjectError(t, f.request("GET", path, "", nil), 400, "invalid_input")
	}
	assertProjectError(t, f.request("GET", "/api/v1/me/workers/bad/bots", "", &botDefinitionCall{
		method: "ListWorker", id: "bad", input: model.PageRequest{Limit: 50},
		err: &model.Fault{Code: "invalid_input", Message: "Invalid Worker ID."},
	}), 400, "invalid_input")
	assertProjectError(t, f.request("DELETE", botDefinitionsPath+"?x=1", `{}`, nil), 400, "invalid_input")
	assertProjectError(t, f.request("GET", botDefinitionsBase+"/"+botDefinitionsOtherID, "", &botDefinitionCall{
		method: "Get", id: botDefinitionsOtherID, err: &model.Fault{Code: "not_found", Message: "Bot not found.", Cause: model.ErrNotFound},
	}), 404, "not_found")
	for _, route := range []struct{ path, allow string }{
		{botDefinitionsBase, "GET, HEAD, POST"}, {botDefinitionsPath, "GET, HEAD, DELETE"}, {botDefinitionsInventory, "GET, HEAD"},
	} {
		response := f.request("PUT", route.path, `{}`, nil)
		assertProjectError(t, response, 405, "method_not_allowed")
		if response.Header().Get("Allow") != route.allow {
			t.Fatalf("unexpected Allow for %s: %v", route.path, response.Header())
		}
		assertProjectError(t, f.dispatch("GET", route.path, "", botDefinitionAnonymous, nil), 401, "unauthenticated")
	}
	assertProjectError(t, f.request("DELETE", botDefinitionsPath, `{"ifVersion":"2","deletionId":"`+botDefinitionsIntent+`"}`, &botDefinitionCall{
		method: "DeleteBot", id: botDefinitionsID, input: store.DeleteBot{Version: 2, DeletionID: botDefinitionsIntent},
		err: &model.Fault{Code: "version_conflict", Message: "Bot version changed."},
	}), 409, "version_conflict")
	assertProjectError(t, f.dispatch("GET", botDefinitionsPath, "", botDefinitionRevoked, nil), 401, "unauthenticated")
	assertProjectError(t, f.dispatch("DELETE", botDefinitionsPath, `{"ifVersion":"1","deletionId":"`+botDefinitionsIntent+`"}`, botDefinitionRevoked, nil), 401, "unauthenticated")
}

func TestBotResponseRoleAndRedaction(t *testing.T) {
	bot := model.Bot{ID: uuid.NewString(), Version: 1, AttentionCount: 3, RoleConfiguration: &model.BotRoleConfiguration{Instructions: "Role", Revision: "v1", Digest: "digest"}, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	value := bothttp.Response(bot)
	if value.RoleConfiguration.Instructions != "Role" || value.CreatedAt.Location() != time.UTC || value.AttentionCount != nil {
		t.Fatal("role or timestamp projection changed")
	}
	bot.Deletion = &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 1}
	value = bothttp.Response(bot)
	if value.BotDefinition != nil {
		t.Fatal("deleted role remains visible")
	}
}

func TestBotsHTTPUnconfirmedTransactionRemainsInternalFailure(t *testing.T) {
	refusal := &model.Fault{Code: "resource_conflict", Message: "Bot deletion belongs to a different request."}
	failure := &model.BotOperationError{Operation: "delete", Cause: &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: refusal}}
	request := httptest.NewRequest(http.MethodDelete, "/api/v1/me/bots/"+uuid.NewString(), nil)
	response := httptest.NewRecorder()
	httpx.WriteError(response, request, slog.New(slog.NewTextHandler(io.Discard, nil)), "bot", "delete", failure)
	decoded := decodeResponse[api.ErrorResponse](t, response, http.StatusInternalServerError)
	if decoded.Error.Code != "internal_error" {
		t.Fatalf("uncertain rollback became a definite refusal: %+v", decoded)
	}
}

func TestBotDeleteHTTPRejectsExpiryAfterAdmission(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.SessionCredential} {
		for _, replay := range []bool{false, true} {
			phase := "intent"
			if replay {
				phase = "replay"
			}
			t.Run(string(kind)+"/"+phase, func(t *testing.T) {
				principal := defaultHTTPPrincipal()
				principal.Kind = kind
				f := newBotExpiryFixture(t, principal)
				ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), botExpiryContextKey{}, "request"), 5*time.Second)
				defer cancel()
				worker, sessionID, executionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
				instant := time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC)
				role := model.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: "frozen-digest"}
				bot := model.Bot{ID: uuid.NewString(), OwnerUserID: principal.UserID, WorkerID: worker, Name: "Assistant", Version: 2, ResolvedConfiguration: model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "codex", Args: []string{}}, SessionID: &sessionID, TestExecutionID: &executionID, RoleConfiguration: &role, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: instant, UpdatedAt: instant}
				input := store.DeleteBot{Version: 2, DeletionID: uuid.NewString()}
				path := "/api/v1/me/bots/" + bot.ID
				body := jsonBody(t, map[string]any{"ifVersion": strconv.FormatInt(input.Version, 10), "deletionId": input.DeletionID})
				deleted := func() model.Bot {
					value := botExpiryCloneBot(bot)
					value.Version, value.UpdatedAt = 3, instant.Add(time.Second)
					value.Deletion = &model.BotDeletion{DeletionID: input.DeletionID, RequestedVersion: input.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
					return value
				}
				call := func(err error) *botExpiryCall {
					return &botExpiryCall{method: "DeleteBot", bot: bot.ID, input: store.DeleteBot{Version: input.Version, DeletionID: input.DeletionID}, result: deleted(), err: err}
				}
				request := func(c *botExpiryCall) *httptest.ResponseRecorder {
					return f.dispatch(ctx, http.MethodDelete, path, body, c)
				}
				want := api.Bot{ID: bot.ID, WorkerID: worker, Version: 3, Deletion: &api.BotDeletion{DeletionID: input.DeletionID, RequestedVersion: 2, WorkerCleanup: api.BotResult{State: "pending"}, ServerCleanup: api.BotResult{State: "pending"}}}
				if replay {
					out := decodeResponse[api.Bot](t, request(call(nil)), http.StatusOK)
					if !reflect.DeepEqual(out, want) {
						t.Fatalf("deletion setup changed its receipt: %+v", out)
					}
				}
				refused := call(&model.Fault{Code: "unauthenticated", Message: "Credential expired or was revoked."})
				response := blockedBotExpiryResponse(t, ctx, cancel, refused, func() *httptest.ResponseRecorder { return request(refused) })
				assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
				outResponse := request(call(nil))
				out := decodeResponse[api.Bot](t, outResponse, http.StatusOK)
				if !reflect.DeepEqual(out, want) || outResponse.Body.String() != jsonBody(t, want)+"\n" {
					t.Fatalf("valid deletion changed its receipt or redaction: %s", outResponse.Body)
				}
				repeatedResponse := request(call(nil))
				decodeResponse[api.Bot](t, repeatedResponse, http.StatusOK)
				if !bytes.Equal(repeatedResponse.Body.Bytes(), outResponse.Body.Bytes()) {
					t.Fatal("valid HTTP replay changed the confirmed result")
				}
			})
		}
	}
}
