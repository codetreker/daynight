package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestBotRuntimeHTTPChecksCredentialAfterUnchangedBotLockWait(t *testing.T) {
	for _, operation := range []string{"register", "report", "report_replay"} {
		for _, expired := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/expired=%t", operation, expired), func(t *testing.T) {
				principal := defaultHTTPPrincipal()
				f := newBotExpiryFixture(t, principal)
				worker, botID := uuid.NewString(), uuid.NewString()
				configuration := model.BotConfiguration{WorkerID: worker, Cwd: "/private/bot-work", Provider: "codex", Args: []string{}}
				instant := time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC)
				bot := model.Bot{ID: botID, OwnerUserID: principal.UserID, WorkerID: worker, Name: "长期助手", Version: 1, ResolvedConfiguration: configuration, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: instant, UpdatedAt: instant}
				ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), botExpiryContextKey{}, "request"), 5*time.Second)
				defer cancel()
				base := "/api/v1/me/workers/" + worker + "/bots/" + botID
				code := "directory_missing"
				report := sessioncore.BotReport{BotVersion: 1, Result: model.BotStartupResult{State: "failed", Code: &code}}
				instructions := "Use the Daynight CLI."
				registration := sessioncore.BotRegistration{BotVersion: 1, Configuration: configuration, RoleConfiguration: model.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}, Registration: sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}}
				sessionID, historyEpoch := uuid.NewString(), uuid.NewString()
				snapshot := func() sp.Snapshot {
					return sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: sessionID, TestExecutionID: registration.Registration.TestExecutionID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{OwnerUserID: principal.UserID, ControllerID: registration.Registration.ControllerID, ControllerInstanceID: registration.Registration.ControllerInstanceID, AgentControlMode: "web", Provider: "codex"}, SessionRevision: "1", HistoryEpoch: historyEpoch, LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_required", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
				}
				registered := func() sessioncore.BotRegistrationResult {
					bound := botExpiryCloneBot(bot)
					bound.Version, bound.UpdatedAt = 2, instant.Add(time.Second)
					bound.SessionID = botExpiryClonePointer(&sessionID)
					bound.TestExecutionID = botExpiryClonePointer(&registration.Registration.TestExecutionID)
					bound.RoleConfiguration = botExpiryClonePointer(&registration.RoleConfiguration)
					return sessioncore.BotRegistrationResult{Bot: bound, Session: botExpiryCloneSnapshot(snapshot())}
				}
				reported := func() model.Bot {
					out := botExpiryCloneBot(bot)
					out.Version, out.UpdatedAt = 2, instant.Add(time.Second)
					out.StartupResult = model.BotStartupResult{State: "failed", Code: botExpiryClonePointer(&code)}
					return out
				}
				registerCall := func() *botExpiryCall {
					expected := registration
					expected.Configuration.Args = botExpiryCloneSlice(registration.Configuration.Args)
					return &botExpiryCall{method: "RegisterBot", worker: worker, bot: botID, input: expected, result: registered()}
				}
				wantBot := func(bound bool) api.Bot {
					definition := &api.BotDefinition{OwnerUserID: principal.UserID, Name: "长期助手", ResolvedConfiguration: api.BotConfiguration{WorkerID: worker, Cwd: "/private/bot-work", Provider: "codex", Args: []string{}}, StartupResult: api.BotResult{State: "pending"}, CreatedAt: instant, UpdatedAt: instant.Add(time.Second)}
					if bound {
						definition.RoleConfiguration = &api.BotRoleConfiguration{Instructions: instructions, Revision: "v1", Digest: fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))}
						definition.SessionID = botExpiryClonePointer(&sessionID)
						definition.TestExecutionID = botExpiryClonePointer(&registration.Registration.TestExecutionID)
					} else {
						definition.StartupResult = api.BotResult{State: "failed", Code: botExpiryClonePointer(&code)}
					}
					return api.Bot{ID: botID, WorkerID: worker, Version: 2, BotDefinition: definition}
				}
				reportCall := func(in sessioncore.BotReport, err error) *botExpiryCall {
					in.Result.Code = botExpiryClonePointer(in.Result.Code)
					return &botExpiryCall{method: "ReportBot", worker: worker, bot: botID, input: in, result: reported(), err: err}
				}
				request := func(path string, body any, call *botExpiryCall) *httptest.ResponseRecorder {
					return f.dispatch(ctx, http.MethodPost, path, jsonBody(t, body), call)
				}
				path := base + "/report"
				if operation == "report_replay" {
					setup := reportCall(report, nil)
					setup.contentType = "application/json; charset=UTF-8"
					out := decodeResponse[api.Bot](t, request(path, report, setup), http.StatusOK)
					if !reflect.DeepEqual(out, wantBot(false)) {
						t.Fatal("failure setup did not return the planned version and result")
					}
					report.BotVersion = 2
				}
				var call *botExpiryCall
				var body any = report
				if operation == "register" {
					path, body = base+"/register", registration
					call = registerCall()
				} else {
					call = reportCall(report, nil)
				}
				if expired {
					call.err = &model.Fault{Code: "unauthenticated", Message: "Credential expired or was revoked."}
				}
				response := blockedBotExpiryResponse(t, ctx, cancel, call, func() *httptest.ResponseRecorder { return request(path, body, call) })
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
					if !reflect.DeepEqual(out.Bot, wantBot(true)) || !reflect.DeepEqual(out.Session, snapshot()) || out.Session.HistoryEpoch == "" {
						t.Fatal("valid PAT did not retain the independent binding and initial Session facts")
					}
					replayCall := registerCall()
					replayCall.contentType = "application/json; charset=UTF-8"
					replayResponse := request(path, registration, replayCall)
					replay := decodeResponse[registrationResult](t, replayResponse, http.StatusOK)
					var originalWire, replayWire struct {
						Bot json.RawMessage `json:"bot"`
					}
					if err := json.Unmarshal(response.Body.Bytes(), &originalWire); err != nil {
						t.Fatal(err)
					}
					if err := json.Unmarshal(replayResponse.Body.Bytes(), &replayWire); err != nil {
						t.Fatal(err)
					}
					if !bytes.Equal(originalWire.Bot, replayWire.Bot) || replay.Session.SessionID != out.Session.SessionID || replay.Session.TestExecutionID != out.Session.TestExecutionID {
						t.Fatal("valid registration replay changed its result")
					}
				} else {
					out := decodeResponse[api.Bot](t, response, http.StatusOK)
					if !reflect.DeepEqual(out, wantBot(false)) {
						t.Fatal("valid PAT changed preflight semantics")
					}
					report.BotVersion = 2
					replayCall := reportCall(report, nil)
					replayCall.contentType = "application/json; charset=UTF-8"
					replayResponse := request(path, report, replayCall)
					decodeResponse[api.Bot](t, replayResponse, http.StatusOK)
					if !bytes.Equal(replayResponse.Body.Bytes(), response.Body.Bytes()) {
						t.Fatal("valid failure replay changed its result")
					}
				}
			})
		}
	}
}
