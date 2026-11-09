package server

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestBotRuntimeHTTPChecksCredentialAfterUnchangedBotLockWait(t *testing.T) {
	for _, operation := range []string{"register", "report", "report_replay"} {
		for _, expired := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/expired=%t", operation, expired), func(t *testing.T) {
				tx := newHTTPTestStore(t)
				h := projectTestHandler(t, tx, io.Discard)
				worker := uuid.NewString()
				configuration := model.BotConfiguration{WorkerID: worker, Cwd: "/private/bot-work", Provider: "codex", Args: []string{}}
				instant := time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC)
				bot := model.Bot{ID: uuid.NewString(), OwnerUserID: h.principal.UserID, WorkerID: worker, Name: "长期助手", Version: 1, ResolvedConfiguration: configuration, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: instant, UpdatedAt: instant}
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				base := "/api/v1/me/workers/" + worker + "/bots/" + bot.ID
				path := base + "/report"
				code := "directory_missing"
				report := sessioncore.BotReport{BotVersion: 1, Result: model.BotStartupResult{State: "failed", Code: &code}}
				instructions := "Use the Daynight CLI."
				registration := sessioncore.BotRegistration{BotVersion: 1, Configuration: configuration, RoleConfiguration: model.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}, Registration: sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}}
				var body any = report
				if operation == "register" {
					path, body = base+"/register", registration
				}
				updated := bot
				updated.Version, updated.UpdatedAt = 2, instant.Add(time.Second)
				updated.StartupResult = report.Result
				configureReport := func(d *botExpiryDAO) {
					d.StartupCall = func(id string, version int64, result model.BotStartupResult) (model.Bot, error) {
						d.check(id == bot.ID && version == 1 && reflect.DeepEqual(result, report.Result), "SetBotStartup")
						return updated, nil
					}
				}
				if operation == "report_replay" {
					first := newBotExpiryPhase(t, tx, h.principal, bot, []string{"LockCredential", "Bot", "SetBotStartup", "LockCredential"}, store.TransactionCommitted)
					configureReport(first)
					out := decodeResponse[api.Bot](t, projectRequest(h, http.MethodPost, path, jsonBody(t, report)), http.StatusOK)
					if out.Version != 2 || out.StartupResult.State != "failed" {
						t.Fatal("failure setup did not return the planned version and result")
					}
					bot = updated
					report.BotVersion = 2
					body = report
				}
				calls := []string{"LockCredential", "Bot", "LockCredential"}
				if operation == "register" {
					calls = []string{"LockCredential", "Bot", "InsertBotSession", "BindBotSession", "LockCredential"}
				} else if operation == "report" {
					calls = []string{"LockCredential", "Bot", "SetBotStartup", "LockCredential"}
				}
				outcome := store.TransactionCommitted
				if expired {
					outcome = store.TransactionNotCommitted
				}
				d := newBotExpiryPhase(t, tx, h.principal, bot, calls, outcome)
				d.expired = expired
				if operation == "register" {
					d.InsertCall = func(input store.SessionRegistration) (bool, error) {
						d.check(input.BotID != nil && *input.BotID == bot.ID && input.OwnerID == h.principal.UserID && input.ParentCredentialID == h.principal.CredentialID && input.Location.ProjectID == "" && input.Location.TaskID == "" && input.Location.SessionID != "" && input.TestExecutionID == registration.Registration.TestExecutionID && input.RegistrationID == registration.Registration.RegistrationID && string(input.Registration) == jsonBody(t, registration), "InsertBotSession")
						captured := botExpiryCloneRegistration(input)
						d.registration = &captured
						return true, nil
					}
					d.BindCall = func(id string, version int64, sessionID string, role model.BotRoleConfiguration) (model.Bot, error) {
						d.check(d.registration != nil && id == bot.ID && version == 1 && sessionID == d.registration.Location.SessionID && role == registration.RoleConfiguration, "BindBotSession")
						bound := bot
						bound.Version, bound.UpdatedAt = 2, instant.Add(time.Second)
						bound.SessionID, bound.TestExecutionID, bound.RoleConfiguration = &sessionID, &registration.Registration.TestExecutionID, &role
						return bound, nil
					}
				} else if operation == "report" {
					configureReport(d)
				}
				response := blockedBotExpiryResponse(t, ctx, cancel, d, func() *httptest.ResponseRecorder {
					request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(jsonBody(t, body))).WithContext(ctx)
					request.Header.Set("Content-Type", "application/json")
					request.Header.Set("X-Request-ID", "project-test")
					authorizeResourceRequest(h, request)
					response := httptest.NewRecorder()
					h.ServeHTTP(response, request)
					return response
				})
				if expired {
					assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
					return
				}
				if operation == "register" {
					type registrationResult struct {
						Bot     api.Bot     `json:"bot"`
						Session sp.Snapshot `json:"session"`
					}
					out := decodeResponse[registrationResult](t, response, http.StatusOK)
					if out.Bot.Version != 2 || out.Bot.RoleConfiguration == nil || jsonBody(t, out.Bot.RoleConfiguration) != jsonBody(t, registration.RoleConfiguration) || out.Bot.SessionID == nil || *out.Bot.SessionID != out.Session.SessionID || out.Session.TestExecutionID != registration.Registration.TestExecutionID || out.Session.Identity.ControllerID != registration.Registration.ControllerID || out.Session.Identity.ControllerInstanceID != registration.Registration.ControllerInstanceID || out.Session.InitialInputState != "not_required" {
						t.Fatal("valid PAT did not bind the role and Session")
					}
					bound := bot
					bound.Version, bound.UpdatedAt = 2, instant.Add(time.Second)
					bound.SessionID, bound.TestExecutionID, bound.RoleConfiguration = &out.Session.SessionID, &registration.Registration.TestExecutionID, &registration.RoleConfiguration
					supplied := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: out.Session.SessionID, TestExecutionID: registration.Registration.TestExecutionID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{OwnerUserID: h.principal.UserID, ControllerID: registration.Registration.ControllerID, ControllerInstanceID: registration.Registration.ControllerInstanceID, AgentControlMode: "web", Provider: "codex"}, SessionRevision: "1", HistoryEpoch: out.Session.HistoryEpoch, LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_required", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
					if !reflect.DeepEqual(out.Session, supplied) || out.Session.HistoryEpoch == "" {
						t.Fatal("registration response changed the independent initial Session facts")
					}
					stored := store.SessionRecord{BotID: &bot.ID, Owner: h.principal.UserID, Parent: h.principal.CredentialID, Snapshot: supplied, Registration: []byte(jsonBody(t, registration))}
					replayDAO := newBotExpiryPhase(t, tx, h.principal, bound, []string{"LockCredential", "Bot", "LockSession", "LockCredential", "LockCredential"}, store.TransactionCommitted)
					replayDAO.SessionCall = func(id string) (store.SessionRecord, error) {
						replayDAO.check(id == stored.Snapshot.SessionID, "LockSession")
						return stored, nil
					}
					replay := decodeResponse[registrationResult](t, projectRequest(h, http.MethodPost, path, jsonBody(t, body)), http.StatusOK)
					if jsonBody(t, replay.Bot) != jsonBody(t, out.Bot) || replay.Session.SessionID != out.Session.SessionID || replay.Session.TestExecutionID != out.Session.TestExecutionID {
						t.Fatal("valid registration replay changed its result")
					}
				} else {
					out := decodeResponse[api.Bot](t, response, http.StatusOK)
					if out.Version != 2 || out.StartupResult.State != "failed" || out.StartupResult.Code == nil || *out.StartupResult.Code != "directory_missing" || out.SessionID != nil || out.RoleConfiguration != nil {
						t.Fatal("valid PAT changed preflight semantics")
					}
					report.BotVersion = 2
					newBotExpiryPhase(t, tx, h.principal, updated, []string{"LockCredential", "Bot", "LockCredential"}, store.TransactionCommitted)
					replay := decodeResponse[api.Bot](t, projectRequest(h, http.MethodPost, path, jsonBody(t, report)), http.StatusOK)
					if jsonBody(t, replay) != jsonBody(t, out) {
						t.Fatal("valid failure replay changed its result")
					}
				}
			})
		}
	}
}
