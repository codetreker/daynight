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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

func TestBotsHTTPEmptyList(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	response := projectRequest(handler, http.MethodGet, "/api/v1/me/bots", "")
	page := decodeResponse[struct {
		Items      []any   `json:"items"`
		NextCursor *string `json:"nextCursor"`
	}](t, response, http.StatusOK)
	if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("invalid empty bot page: %s", response.Body)
	}
}

func TestBotsHTTPReadDeleteIntentAndWorkerInventory(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	workerID := uuid.NewString()
	reportSnapshotHTTP(t, handler, workerID, workerSnapshotReportBody())
	bot := seedHTTPBot(t, database, handler, workerID)
	other := seedHTTPBot(t, database, handler, workerID)
	path := "/api/v1/me/bots/" + bot.ID
	page := decodeResponse[api.BotPage](t, projectRequest(handler, "GET", "/api/v1/me/bots?limit=1", ""), 200)
	if len(page.Items) != 1 || page.Items[0].ID != bot.ID || page.NextCursor == nil {
		t.Fatalf("page: %+v", page)
	}
	next := decodeResponse[api.BotPage](t, projectRequest(handler, "GET", "/api/v1/me/bots?limit=1&cursor="+url.QueryEscape(*page.NextCursor), ""), 200)
	if len(next.Items) != 1 || next.Items[0].ID != other.ID || next.NextCursor != nil {
		t.Fatalf("next: %+v", next)
	}
	workerPath := "/api/v1/me/workers/" + workerID + "/bots"
	assertProjectError(t, projectRequest(handler, "GET", workerPath+"?cursor="+url.QueryEscape(*page.NextCursor), ""), 400, "invalid_input")
	const large int64 = 9007199254740993
	if _, err := database.Pool.Exec(context.Background(), "UPDATE bots SET version=$2 WHERE id=$1", bot.ID, large); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, "GET", "/api/v1/me/bots/"+strings.ToUpper(bot.ID), "")
	read := decodeResponse[api.Bot](t, response, 200)
	if read.Version != large || read.Name != "长期助手" || read.StartupResult.State != "pending" || read.SessionID != nil || read.RoleConfiguration != nil || read.ResolvedConfiguration.Cwd != "/private/bot-work" {
		t.Fatalf("read: %+v", read)
	}
	if !strings.Contains(response.Body.String(), `"version":"9007199254740993"`) || !strings.Contains(response.Body.String(), `"creationOrder":"`) || strings.Contains(response.Body.String(), "requestFingerprint") {
		t.Fatal(response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
		t.Fatal("missing private admission headers")
	}
	deletionID := uuid.NewString()
	body := `{"ifVersion":"9007199254740993","deletionId":"` + deletionID + `"}`
	deleted := projectRequest(handler, "DELETE", path, body)
	intent := decodeResponse[api.Bot](t, deleted, 200)
	if intent.Version != large+1 || intent.BotDefinition != nil || intent.Deletion.DeletionID != deletionID || intent.Deletion.RequestedVersion != large || intent.Deletion.WorkerCleanup.State != "pending" || intent.Deletion.ServerCleanup.State != "pending" {
		t.Fatalf("intent: %+v", intent)
	}
	for _, key := range []string{"name", "roleConfiguration", "sessionId", "resolvedConfiguration", "requestedOverrides", "startupResult"} {
		if strings.Contains(deleted.Body.String(), `"`+key+`"`) {
			t.Fatalf("deleted definition leaked %s", key)
		}
	}
	replayed := decodeResponse[api.Bot](t, projectRequest(handler, "DELETE", path, body), 200)
	if replayed.Version != intent.Version {
		t.Fatal("duplicate deletion advanced version")
	}
	assertProjectError(t, projectRequest(handler, "DELETE", path, `{"ifVersion":"9007199254740993","deletionId":"`+uuid.NewString()+`"}`), 409, "resource_conflict")
	visible := decodeResponse[api.BotPage](t, projectRequest(handler, "GET", "/api/v1/me/bots", ""), 200)
	if len(visible.Items) != 1 || visible.Items[0].ID != other.ID {
		t.Fatal("deleted bot remains in normal list")
	}
	inventory := decodeResponse[api.BotPage](t, projectRequest(handler, "GET", workerPath, ""), 200)
	if len(inventory.Items) != 2 || inventory.Items[0].Deletion == nil {
		t.Fatal("cleanup responsibility disappeared")
	}
	detail := decodeResponse[api.Bot](t, projectRequest(handler, "GET", path, ""), 200)
	if detail.BotDefinition != nil || detail.Deletion == nil {
		t.Fatal("deleted detail exposed definition")
	}
	if strings.Contains(logs.String(), "/private/bot-work") || strings.Contains(logs.String(), "长期助手") {
		t.Fatal("bot content leaked into logs")
	}
}

func TestBotsHTTPStrictInputAndAuthentication(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	workerID := uuid.NewString()
	reportSnapshotHTTP(t, handler, workerID, workerSnapshotReportBody())
	bot := seedHTTPBot(t, database, handler, workerID)
	path := "/api/v1/me/bots/" + bot.ID
	for _, body := range []string{`{}`, `null`, `[]`, `{"ifVersion":1}`, `{"ifVersion":null}`, `{"ifVersion":"01"}`, `{"ifVersion":"+1"}`, `{"ifVersion":"0"}`, `{"ifVersion":"9223372036854775808"}`, `{"ifVersion":"1"}`, `{"ifVersion":"1","deletionId":null}`, `{"ifVersion":"1","deletionId":"bad"}`, `{"ifVersion":"1","deletionId":"` + uuid.NewString() + `","extra":true}`} {
		assertProjectError(t, projectRequest(handler, "DELETE", path, body), 400, "invalid_input")
	}
	for _, p := range []string{path + "?x=1", path + "?", "/api/v1/me/bots/bad", "/api/v1/me/bots?limit=0", "/api/v1/me/bots?unexpected=1", "/api/v1/me/workers/bad/bots"} {
		assertProjectError(t, projectRequest(handler, "GET", p, ""), 400, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, "DELETE", path+"?x=1", `{}`), 400, "invalid_input")
	assertProjectError(t, projectRequest(handler, "GET", "/api/v1/me/bots/"+uuid.NewString(), ""), 404, "not_found")
	for _, p := range []string{"/api/v1/me/bots", path, "/api/v1/me/workers/" + workerID + "/bots"} {
		assertProjectError(t, projectRequest(handler, "PUT", p, `{}`), 405, "method_not_allowed")
		assertProjectError(t, projectRequest(handler.Handler, "GET", p, ""), 401, "unauthenticated")
	}
	assertProjectError(t, projectRequest(handler, "DELETE", path, `{"ifVersion":"2","deletionId":"`+uuid.NewString()+`"}`), 409, "version_conflict")
	if _, err := database.Pool.Exec(context.Background(), "DELETE FROM personal_access_tokens WHERE id=$1", handler.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, projectRequest(handler, "GET", path, ""), 401, "unauthenticated")
	assertProjectError(t, projectRequest(handler, "DELETE", path, `{"ifVersion":"1","deletionId":"`+uuid.NewString()+`"}`), 401, "unauthenticated")
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
