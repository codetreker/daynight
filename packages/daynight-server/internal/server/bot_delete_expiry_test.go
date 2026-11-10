package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

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
