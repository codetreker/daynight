package session_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type ownerPermissionContextKey struct{}

func sessionReaderHandler(t *testing.T, handler *resourceTestHandler) *resourceTestHandler {
	t.Helper()
	viewer := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	return &resourceTestHandler{Handler: handler.Handler, token: handler.authentication.Credential(viewer), principal: viewer, backend: handler.backend, authentication: handler.authentication, application: handler.application}
}

func ownerPermissionRequest(t *testing.T, handler *resourceTestHandler, method, path, body, marker string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	handler.authentication.ExpectCalls(1)
	before := handler.authentication.Count()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), ownerPermissionContextKey{}, marker))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	for key, values := range headers {
		request.Header[key] = append([]string(nil), values...)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if handler.authentication.Count() != before+1 {
		t.Fatal("permission adapter changed its authentication call count")
	}
	return response
}

func TestNativeSessionHTTPAndBrowserEncodeSuppliedReaderPermissions(t *testing.T) {
	for _, role := range []string{"member", "admin"} {
		t.Run(role, func(t *testing.T) {
			f := sessionHTTPSetup(t)
			reader := sessionReaderHandler(t, f.handler)
			marker := uuid.NewString()
			native, turn, value := "native", "turn", "model"
			supplied := routeCopy(f.snapshot)
			supplied.ConnectionEpoch = "1"
			supplied.ConnectionState, supplied.Activity, supplied.InitialInputState = "connected", "working", "confirmed"
			supplied.Synchronized = true
			supplied.Identity.NativeSessionID, supplied.CurrentTurnID = &native, &turn
			supplied.Capabilities = sp.Capabilities{Send: true, Steer: true, Cancel: true, Respond: true}
			supplied.Operations = sp.Operations{}
			supplied.Controls = &sp.Controls{Revision: "1", Settings: []sp.Setting{{ID: "model", Category: "model", Label: "Model", Value: &value, Options: []sp.SettingOption{{Value: value, Label: "Model"}}, Mutable: false, Scope: "session"}}, Commands: []sp.NativeCommand{{ID: "compact", Name: "compact", Description: "Compact", Available: false}}}
			owner := routeCopy(supplied)
			owner.Operations = sp.Operations{CanSend: true, CanCancel: true, CanRespond: true}
			owner.Controls.Settings[0].Mutable, owner.Controls.Commands[0].Available = true, true
			currentCalls := 0
			var expectedCommand sp.Command
			var expectedActor model.Principal
			var commandResult sp.Operation
			var commandError error
			scope := func(ctx context.Context, principal model.Principal, project, task, session string, actor model.Principal, foreground bool) {
				t.Helper()
				if ctx.Err() != nil || principal != actor || project != f.task.ProjectID || task != f.task.ID || session != supplied.SessionID {
					t.Errorf("permission use-case scope changed: actor=%+v project=%s task=%s session=%s context=%v", principal, project, task, session, ctx.Err())
				}
				if foreground && ctx.Value(ownerPermissionContextKey{}) != marker {
					t.Error("permission request context was not forwarded")
				}
			}
			f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
				calls.Current = func(ctx context.Context, principal model.Principal, project, task string) (map[string]any, error) {
					currentCalls++
					if currentCalls == 1 {
						scope(ctx, principal, project, task, supplied.SessionID, reader.principal, true)
						return map[string]any{"status": "registered", "session": routeCopy(supplied)}, nil
					}
					scope(ctx, principal, project, task, supplied.SessionID, f.handler.principal, true)
					return map[string]any{"status": "registered", "session": routeCopy(owner)}, nil
				}
				calls.BrowserPoll = func(ctx context.Context, principal model.Principal, project, task, session, cursor string) (sp.Snapshot, []map[string]any, string, error) {
					scope(ctx, principal, project, task, session, reader.principal, false)
					if httpx.RequestID(ctx) != "project-test" || cursor != "" && cursor != "browser-cursor" {
						t.Error("browser request context or cursor was not forwarded")
					}
					return routeCopy(supplied), []map[string]any{}, "browser-cursor", nil
				}
				calls.Submit = func(ctx context.Context, principal model.Principal, project, task, session string, command sp.Command) (sp.Operation, error) {
					scope(ctx, principal, project, task, session, expectedActor, true)
					if !reflect.DeepEqual(command, expectedCommand) {
						t.Errorf("permission command body changed: got=%+v want=%+v", command, expectedCommand)
					}
					return commandResult, commandError
				}
			})
			f.backend.ExpectCalls("Current", 2)
			f.backend.ExpectCalls("Submit", 7)
			f.backend.RequireCalls("BrowserPoll", 1)
			path := f.base + "/" + supplied.SessionID
			response := ownerPermissionRequest(t, reader, http.MethodGet, f.base+"/current", "", marker, nil)
			current := decodeResponse[struct{ Session sp.Snapshot }](t, response, http.StatusOK)
			if !reflect.DeepEqual(current.Session, supplied) {
				t.Fatal("HTTP changed the supplied reader permission snapshot", current.Session)
			}
			f.authentication.ExpectCalls(1)
			browser := sessionDial(t, f.server.URL, path+"/channel", reader.token, http.Header{"X-Request-ID": {"project-test"}})
			frame := sessionWSKind(t, browser, "snapshot")
			projected, err := sp.DecodeSnapshot(frame["snapshot"])
			var frameUser, cursor string
			_ = json.Unmarshal(frame["userId"], &frameUser)
			_ = json.Unmarshal(frame["cursor"], &cursor)
			if err != nil || !reflect.DeepEqual(projected, supplied) || frameUser != reader.principal.UserID || cursor != "browser-cursor" {
				t.Fatal("WebSocket changed the supplied reader snapshot or correlation", err)
			}
			_ = browser.CloseNow()
			for _, item := range []struct {
				kind    string
				payload any
			}{
				{"send_message", sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "reader input"}}, ExpectedTurnID: &turn}},
				{"cancel", sp.Cancel{ExpectedTurnID: turn}},
				{"interaction_response", sp.InteractionResponse{InteractionID: uuid.NewString(), InteractionRevision: "1", SubmissionID: uuid.NewString(), Response: json.RawMessage("{\"kind\":\"approval\",\"action\":\"allow_once\"}")}},
				{"update_setting", sp.UpdateSetting{SettingID: "model", Value: value, ExpectedControlsRevision: "1"}},
				{"execute_command", sp.ExecuteCommand{CommandID: "compact", ExpectedControlsRevision: "1"}},
				{"refresh_controls", map[string]any{}},
			} {
				expectedCommand = sp.Command{Fence: supplied.Fence, Protocol: sp.Protocol, RequestID: uuid.NewString(), OperationID: uuid.NewString(), Kind: item.kind, Payload: json.RawMessage(jsonBody(t, item.payload))}
				expectedActor, commandError = reader.principal, &model.Fault{Code: "forbidden", Message: "Session interaction is unavailable."}
				assertProjectError(t, ownerPermissionRequest(t, reader, http.MethodPost, path+"/commands", jsonBody(t, expectedCommand), marker, nil), http.StatusForbidden, "forbidden")
			}
			response = ownerPermissionRequest(t, f.handler, http.MethodGet, f.base+"/current", "", marker, nil)
			current = decodeResponse[struct{ Session sp.Snapshot }](t, response, http.StatusOK)
			if !reflect.DeepEqual(current.Session, owner) {
				t.Fatal("HTTP changed the independently supplied owner permissions")
			}
			expectedCommand = sp.Command{Fence: supplied.Fence, Protocol: sp.Protocol, RequestID: uuid.NewString(), OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(jsonBody(t, sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "owner input"}}, ExpectedTurnID: &turn}))}
			expectedActor, commandError = f.handler.principal, nil
			commandResult = sp.Operation{Fence: supplied.Fence, Protocol: sp.Protocol, OperationID: expectedCommand.OperationID, Kind: expectedCommand.Kind, State: "accepted"}
			response = ownerPermissionRequest(t, f.handler, http.MethodPost, path+"/commands", jsonBody(t, expectedCommand), marker, nil)
			accepted := decodeResponse[struct {
				Operation    sp.Operation
				OperationURL string
			}](t, response, http.StatusAccepted)
			location := path + "/operations/" + expectedCommand.OperationID
			if !reflect.DeepEqual(accepted.Operation, commandResult) || accepted.OperationURL != location || response.Header().Get("Location") != location {
				t.Fatal("HTTP changed the supplied accepted operation or its URL", accepted)
			}
		})
	}
}

func TestTerminalSessionHTTPEncodesReaderStateAndControlRefusals(t *testing.T) {
	for _, role := range []string{"member", "admin"} {
		t.Run(role, func(t *testing.T) {
			f := terminalHTTPSetup(t)
			reader := sessionReaderHandler(t, f.h)
			marker, browserID := uuid.NewString(), uuid.NewString()
			supplied := f.knownState("1")
			supplied["control"] = v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{}}
			want := routeCopy(supplied)
			expected := f.message
			expected.Type = "control_request"
			expected.Payload = v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: browserID}
			scope := func(ctx context.Context, principal model.Principal, project, task, session string) {
				t.Helper()
				owner := f.message.Payload.(v2.Registration).Owner
				if ctx.Err() != nil || ctx.Value(ownerPermissionContextKey{}) != marker || principal != reader.principal || project != owner.ProjectID || task != owner.TaskID || session != f.message.SessionID {
					t.Errorf("terminal reader scope changed: actor=%+v project=%s task=%s session=%s context=%v", principal, project, task, session, ctx.Err())
				}
			}
			f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
				calls.CurrentTerminal = func(ctx context.Context, principal model.Principal, project, task string) (map[string]any, error) {
					scope(ctx, principal, project, task, f.message.SessionID)
					return routeCopy(want), nil
				}
				calls.TerminalState = func(ctx context.Context, principal model.Principal, project, task, session string) (map[string]any, error) {
					scope(ctx, principal, project, task, session)
					return routeCopy(want), nil
				}
				calls.SubmitTerminal = func(ctx context.Context, principal model.Principal, project, task, session, actualBrowser string, message v2.Message) (v2.Message, error) {
					scope(ctx, principal, project, task, session)
					if actualBrowser != browserID || !reflect.DeepEqual(message, expected) {
						t.Error("terminal control request body or browser-client header changed")
					}
					return v2.Message{}, &model.Fault{Code: "forbidden", Message: "Session interaction is unavailable."}
				}
			})
			f.calls.ExpectCalls("CurrentTerminal", 1)
			f.calls.ExpectCalls("TerminalState", 1)
			f.calls.ExpectCalls("SubmitTerminal", 1)
			headers := http.Header{v2.ProtocolHeader: {v2.Protocol}}
			for _, path := range []string{f.base + "/current", f.base + "/" + f.message.SessionID + "/state"} {
				response := ownerPermissionRequest(t, reader, http.MethodGet, path, "", marker, headers)
				view := decodeResponse[map[string]any](t, response, http.StatusOK)
				if !reflect.DeepEqual(view, want) {
					t.Fatal("HTTP changed the supplied terminal reader state", view)
				}
			}
			headers.Set("Daynight-Browser-Client", browserID)
			response := ownerPermissionRequest(t, reader, http.MethodPost, f.base+"/"+f.message.SessionID+"/commands", jsonBody(t, expected), marker, headers)
			assertProjectError(t, response, http.StatusForbidden, "forbidden")
		})
	}
}
