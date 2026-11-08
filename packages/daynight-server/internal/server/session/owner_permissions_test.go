package session_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	servicesupport "github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func sessionReaderHandler(t *testing.T, database *postgres.Store, handler http.Handler, project, role string) *resourceTestHandler {
	t.Helper()
	ctx := context.Background()
	viewer := servicesupport.ServicePrincipal(t, database)
	var token identitycore.MintedPAT
	completion, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		var err error
		token, err = identitycore.NewIdentity(configuredTestConfig().UniAuthCallbackURL).CreatePAT(ctx, scope.IdentityDAO(), viewer, identitycore.CreatePAT{Name: "Session reader"}, time.Now())
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("reader credential: %+v %v", completion, err)
	}
	if _, err := database.Pool.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,$3)`, project, viewer.UserID, role); err != nil {
		t.Fatal(err)
	}
	return &resourceTestHandler{Handler: handler, token: token.Secret, principal: viewer}
}

func TestNativeSessionHTTPAndBrowserKeepOtherProjectMembersReadOnly(t *testing.T) {
	f := sessionHTTPSetup(t)
	controller, snapshot := f.controller(t, uuid.NewString())
	native, turn, value := "native", "turn", "model"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "working", CurrentTurnID: &turn, Capabilities: sp.Capabilities{Send: true, Steer: true, Cancel: true, Respond: true}, Controls: &sp.Controls{Revision: "1", Settings: []sp.Setting{{ID: "model", Category: "model", Label: "Model", Value: &value, Options: []sp.SettingOption{{Value: value, Label: "Model"}}, Mutable: true, Scope: "session"}}, Commands: []sp.NativeCommand{{ID: "compact", Name: "compact", Description: "Compact", Available: true}}}}
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, controller, "sync_ack")
	path := f.base + "/" + snapshot.SessionID
	for _, role := range []string{"member", "admin"} {
		t.Run(role, func(t *testing.T) {
			reader := sessionReaderHandler(t, f.db, f.handler.Handler, f.task.ProjectID, role)
			current := decodeResponse[struct {
				Session sp.Snapshot `json:"session"`
			}](t, projectRequest(reader, http.MethodGet, f.base+"/current", ""), http.StatusOK)
			if current.Session.Lifecycle != "active" || current.Session.Operations != (sp.Operations{}) || current.Session.Controls.Settings[0].Mutable || current.Session.Controls.Commands[0].Available {
				t.Fatal("reader current snapshot lost live state or retained interaction authority")
			}
			browser := sessionDial(t, f.server.URL, path+"/channel", reader.token, nil)
			defer browser.CloseNow()
			frame := sessionWSKind(t, browser, "snapshot")
			projected, err := sp.DecodeSnapshot(frame["snapshot"])
			if err != nil || projected.Operations != (sp.Operations{}) || projected.Controls.Settings[0].Mutable || projected.Controls.Commands[0].Available {
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
				assertProjectError(t, projectRequest(reader, http.MethodPost, path+"/commands", jsonBody(t, command)), http.StatusForbidden, "forbidden")
			}
		})
	}
	command := sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: uuid.NewString(), OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(jsonBody(t, sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "owner input"}}, ExpectedTurnID: &turn}))}
	decodeResponse[sp.Operation](t, projectRequest(f.handler, http.MethodPost, path+"/commands", jsonBody(t, command)), http.StatusAccepted)
}

func TestTerminalSessionHTTPKeepsOtherProjectMembersReadOnly(t *testing.T) {
	f := terminalHTTPSetup(t)
	terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol))
	registration := f.message.Payload.(v2.Registration)
	for _, role := range []string{"member", "admin"} {
		t.Run(role, func(t *testing.T) {
			reader := sessionReaderHandler(t, f.db, f.h.Handler, registration.Owner.ProjectID, role)
			for _, path := range []string{f.base + "/current", f.base + "/" + f.message.SessionID + "/state"} {
				view := decodeResponse[map[string]any](t, terminalRequest(reader, http.MethodGet, path, "", v2.Protocol), http.StatusOK)
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
			response := httptest.NewRecorder()
			reader.ServeHTTP(response, request)
			assertProjectError(t, response, http.StatusForbidden, "forbidden")
		})
	}
}
