package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
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
				tx := newHTTPTestStoreForPrincipal(t, principal)
				h := resourceTestServerForPrincipal(t, tx, attachmentTestFiles(t), io.Discard, principal)
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				worker, sessionID, executionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
				instant := time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC)
				role := model.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: "frozen-digest"}
				bot := model.Bot{ID: uuid.NewString(), OwnerUserID: principal.UserID, WorkerID: worker, Name: "Assistant", Version: 2, ResolvedConfiguration: model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "codex", Args: []string{}}, SessionID: &sessionID, TestExecutionID: &executionID, RoleConfiguration: &role, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: instant, UpdatedAt: instant}
				input := store.DeleteBot{Version: 2, DeletionID: uuid.NewString()}
				path := "/api/v1/me/bots/" + bot.ID
				body := jsonBody(t, map[string]any{"ifVersion": strconv.FormatInt(input.Version, 10), "deletionId": input.DeletionID})
				request := func() *httptest.ResponseRecorder {
					r := httptest.NewRequest(http.MethodDelete, path, strings.NewReader(body)).WithContext(ctx)
					r.Header.Set("Content-Type", "application/json")
					r.Header.Set("Origin", configuredTestConfig().PublicOrigin)
					r.Header.Set("X-Request-ID", "project-test")
					if kind == model.PATCredential {
						r.Header.Set("Authorization", "Bearer "+httpTestToken(kind))
					} else {
						r.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: httpTestToken(kind)})
					}
					response := httptest.NewRecorder()
					h.ServeHTTP(response, r)
					return response
				}
				deleted := bot
				deleted.Version, deleted.UpdatedAt = 3, instant.Add(time.Second)
				deleted.Deletion = &model.BotDeletion{DeletionID: input.DeletionID, RequestedVersion: input.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
				intentCalls := []string{"LockCredential", "Bot", "LockBotSessions", "RevokeBotSessions", "SaveBotDeletion", "LockCredential"}
				replayCalls := []string{"LockCredential", "Bot", "LockCredential"}
				configureIntent := func(d *botExpiryDAO) {
					d.SessionsCall = func(id string) ([]store.BotSession, error) {
						d.check(id == bot.ID, "LockBotSessions")
						return []store.BotSession{{ID: sessionID, Owner: principal.UserID, Scope: "test", Backend: "web"}}, nil
					}
					d.RevokeCall = func(id string) error { d.check(id == bot.ID, "RevokeBotSessions"); return nil }
					d.DeletionCall = func(id string, deletion *model.BotDeletion) (model.Bot, error) {
						d.check(id == bot.ID && reflect.DeepEqual(deletion, deleted.Deletion), "SaveBotDeletion")
						return deleted, nil
					}
				}
				if replay {
					d := newBotExpiryPhase(t, tx, principal, bot, intentCalls, store.TransactionCommitted)
					configureIntent(d)
					out := decodeResponse[api.Bot](t, request(), http.StatusOK)
					if out.Version != 3 || out.Deletion == nil || out.Deletion.DeletionID != input.DeletionID {
						t.Fatal("deletion setup changed its requested identity")
					}
					bot = deleted
				}
				calls := intentCalls
				if replay {
					calls = replayCalls
				}
				d := newBotExpiryPhase(t, tx, principal, bot, calls, store.TransactionNotCommitted)
				d.expired = true
				if !replay {
					configureIntent(d)
				}
				response := blockedBotExpiryResponse(t, ctx, cancel, d, request)
				assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
				valid := newBotExpiryPhase(t, tx, principal, bot, calls, store.TransactionCommitted)
				if !replay {
					configureIntent(valid)
				}
				out := decodeResponse[api.Bot](t, request(), http.StatusOK)
				if out.Version != deleted.Version || out.Deletion == nil || out.Deletion.DeletionID != input.DeletionID || out.BotDefinition != nil {
					t.Fatal("valid deletion changed the bound identity or receipt")
				}
				newBotExpiryPhase(t, tx, principal, deleted, replayCalls, store.TransactionCommitted)
				repeated := decodeResponse[api.Bot](t, request(), http.StatusOK)
				if jsonBody(t, repeated) != jsonBody(t, out) {
					t.Fatal("valid HTTP replay changed the confirmed result")
				}
			})
		}
	}
}
