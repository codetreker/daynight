package session_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func sessionReaderHandler(t *testing.T, handler *resourceTestHandler) *resourceTestHandler {
	t.Helper()
	viewer := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	return &resourceTestHandler{Handler: handler.Handler, token: handler.authentication.Credential(viewer), principal: viewer, backend: handler.backend, authentication: handler.authentication, application: handler.application}
}

func TestNativeSessionHTTPAndBrowserKeepOtherProjectMembersReadOnly(t *testing.T) {
	f := sessionHTTPSetup(t)
	epoch := uuid.NewString()
	controller, snapshot := f.controller(t, epoch)
	native, turn, value := "native", "turn", "model"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "working", CurrentTurnID: &turn, Capabilities: sp.Capabilities{Send: true, Steer: true, Cancel: true, Respond: true}, Controls: &sp.Controls{Revision: "1", Settings: []sp.Setting{{ID: "model", Category: "model", Label: "Model", Value: &value, Options: []sp.SettingOption{{Value: value, Label: "Model"}}, Mutable: true, Scope: "session"}}, Commands: []sp.NativeCommand{{ID: "compact", Name: "compact", Description: "Compact", Available: true}}}}
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, controller, "sync_ack")
	f.SelectNativeState(t, epoch, 0, &state)
	path := f.base + "/" + snapshot.SessionID
	for _, role := range []string{"member", "admin"} {
		t.Run(role, func(t *testing.T) {
			reader := sessionReaderHandler(t, f.handler)
			f.SetInput(func(input *nativeRouteInput) {
				input.Credentials[reader.principal.CredentialID] = reader.principal
				input.ProjectAccess[reader.principal.UserID] = model.ProjectAccess{UserID: reader.principal.UserID, ProjectID: f.task.ProjectID, Role: model.ProjectRole(role)}
			})
			current := decodeResponse[struct {
				Session sp.Snapshot `json:"session"`
			}](t, projectRequest(reader, http.MethodGet, f.base+"/current", "", "native.current"), http.StatusOK)
			if current.Session.Lifecycle != "active" || current.Session.Operations != (sp.Operations{}) || current.Session.Controls == nil || len(current.Session.Controls.Settings) != 1 || len(current.Session.Controls.Commands) != 1 || current.Session.Controls.Settings[0].Mutable || current.Session.Controls.Commands[0].Available {
				t.Fatal("reader current snapshot lost live state or retained interaction authority")
			}
			browser := sessionDial(t, f.server.URL, path+"/channel", reader.token, f.backend.PlanHeader("native.browser"))
			defer browser.CloseNow()
			frame := sessionWSKind(t, browser, "snapshot")
			projected, err := sp.DecodeSnapshot(frame["snapshot"])
			if err != nil || projected.Operations != (sp.Operations{}) || projected.Controls == nil || len(projected.Controls.Settings) != 1 || len(projected.Controls.Commands) != 1 || projected.Controls.Settings[0].Mutable || projected.Controls.Commands[0].Available {
				t.Fatal("reader browser snapshot retained interaction authority", err)
			}
			for _, item := range []struct {
				kind    string
				payload any
			}{
				{"send_message", sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "reader input"}}, ExpectedTurnID: &turn}},
				{"cancel", sp.Cancel{ExpectedTurnID: turn}},
				{"interaction_response", sp.InteractionResponse{InteractionID: uuid.NewString(), InteractionRevision: "1", SubmissionID: uuid.NewString(), Response: json.RawMessage(`{"kind":"approval","action":"allow_once"}`)}},
				{"update_setting", sp.UpdateSetting{SettingID: "model", Value: value, ExpectedControlsRevision: "1"}},
				{"execute_command", sp.ExecuteCommand{CommandID: "compact", ExpectedControlsRevision: "1"}},
				{"refresh_controls", map[string]any{}},
			} {
				command := sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: uuid.NewString(), OperationID: uuid.NewString(), Kind: item.kind, Payload: json.RawMessage(jsonBody(t, item.payload))}
				assertProjectError(t, projectRequest(reader, http.MethodPost, path+"/commands", jsonBody(t, command), "native.browser-request"), http.StatusForbidden, "forbidden")
			}
		})
	}
	owner := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(f.handler, http.MethodGet, f.base+"/current", "", "native.current"), http.StatusOK)
	if owner.Session.Controls == nil || len(owner.Session.Controls.Settings) != 1 || len(owner.Session.Controls.Commands) != 1 || !owner.Session.Controls.Settings[0].Mutable || !owner.Session.Controls.Commands[0].Available || !owner.Session.Operations.CanSend {
		t.Fatal("reader projection changed the owner's live controls")
	}
	command := sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: uuid.NewString(), OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(jsonBody(t, sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "owner input"}}, ExpectedTurnID: &turn}))}
	f.SetInput(func(input *nativeRouteInput) {
		input.OperationID = command.OperationID
		input.OperationError = model.ErrNotFound
	})
	accepted := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
	}](t, projectRequest(f.handler, http.MethodPost, path+"/commands", jsonBody(t, command), "native.submit"), http.StatusAccepted)
	if accepted.Operation.OperationID != command.OperationID || accepted.Operation.State != "accepted" {
		t.Fatalf("owner command lost its accepted identity: %+v", accepted.Operation)
	}
}

func TestTerminalSessionHTTPKeepsOtherProjectMembersReadOnly(t *testing.T) {
	f := terminalHTTPSetup(t)
	terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol, "terminal-register"))
	f.state.mu.Lock()
	if len(f.state.writes.insert) != 1 {
		f.state.mu.Unlock()
		t.Fatal("terminal registration did not propose one bound record")
	}
	inserted := f.state.writes.insert[0]
	f.state.mu.Unlock()
	f.selectInsert(t, inserted)
	for _, role := range []string{"member", "admin"} {
		t.Run(role, func(t *testing.T) {
			reader := f.addViewer(t, model.ProjectRole(role))
			for _, selection := range []struct{ path, plan string }{{f.base + "/current", "terminal-current"}, {f.base + "/" + f.message.SessionID + "/state", "terminal-state"}} {
				view := decodeResponse[map[string]any](t, terminalRequest(reader, http.MethodGet, selection.path, "", v2.Protocol, selection.plan), http.StatusOK)
				if view["sessionId"] != f.message.SessionID || view["connected"] != true {
					t.Fatal("reader could not inspect live terminal", view)
				}
			}
			browserID := uuid.NewString()
			message := f.message
			message.Type = "control_request"
			message.Payload = v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: browserID}
			request := httptest.NewRequest(http.MethodPost, f.base+"/"+message.SessionID+"/commands", strings.NewReader(jsonBody(t, message)))
			authorizeResourceRequest(reader, request)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Request-ID", "project-test")
			request.Header.Set(v2.ProtocolHeader, v2.Protocol)
			request.Header.Set("Daynight-Browser-Client", browserID)
			plan := "owner.terminal." + role + ".refuse"
			f.declareTerminal(plan, terminalReadCounts(nil), false)
			request.Header.Set(routePlanHeader, plan)
			response := httptest.NewRecorder()
			reader.ServeHTTP(response, request)
			assertProjectError(t, response, http.StatusForbidden, "forbidden")
		})
	}
}
