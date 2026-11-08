package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"

	"github.com/coder/websocket"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestControllerChannelRejectsInvalidGrantsBeforeUpgrade(t *testing.T) {
	for _, kind := range []string{"unknown", "expired", "consumed", "revoked"} {
		t.Run(kind, func(t *testing.T) {
			f := sessionHTTPSetup(t)
			token := f.grant.Token
			var err error
			switch kind {
			case "unknown":
				token = "dncontroller_invalid"
			case "expired":
				_, err = f.db.Pool.Exec(context.Background(), `UPDATE task_sessions SET grant_expires_at=now()-interval '1 second' WHERE id=$1`, f.snapshot.SessionID)
			case "consumed":
				_, err = f.db.Pool.Exec(context.Background(), `UPDATE task_sessions SET grant_consumed=true WHERE id=$1`, f.snapshot.SessionID)
			case "revoked":
				_, err = f.db.Pool.Exec(context.Background(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.handler.principal.CredentialID)
			}
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			conn, response, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http://", "ws://", 1)+"/api/v1/controller-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}})
			if conn != nil {
				_ = conn.CloseNow()
			}
			if err == nil || response == nil || (response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden) {
				t.Fatalf("invalid grant upgraded: response=%v error=%v", response, err)
			}
			if count := f.application.relay.ActiveConnections(); count != 0 {
				t.Fatal("invalid grant occupied channel capacity", count)
			}
		})
	}
}

func TestControllerChannelStaleOfferRejectsOnlyOperation(t *testing.T) {
	f := sessionHTTPSetup(t)
	epoch := uuid.NewString()
	conn, snapshot := f.controller(t, epoch)
	native := "native-session"
	state := sp.State{NativeSessionID: &native, InitialInputState: "provider_accepted", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	publish := func(seq string) {
		sessionWSWrite(t, conn, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: seq, Kind: "state", Payload: json.RawMessage(jsonBody(t, state))}}})
		sessionWSKind(t, conn, "events_ack")
	}
	publish("1")
	submit := func() sp.Command {
		command := sp.Command{Protocol: sp.Protocol, RequestID: "stale-offer", Fence: snapshot.Fence, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"bounded test input"}],"expectedTurnId":null}`)}
		decodeResponse[map[string]any](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+snapshot.SessionID+"/commands", jsonBody(t, command)), http.StatusAccepted)
		sessionWSKind(t, conn, "operation_offer")
		return command
	}
	command := submit()
	state.Activity = "unknown"
	publish("2")
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID})
	frame := sessionWSKind(t, conn, "receipt_ack")
	var receipt sp.Operation
	if err := json.Unmarshal(frame["operation"], &receipt); err != nil || receipt.State != "rejected" || receipt.OperationID != command.OperationID {
		t.Fatal(receipt, err)
	}
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence})
	sessionWSKind(t, conn, "heartbeat_ack")
	state.Activity = "idle"
	publish("3")
	command = submit()
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID})
	sessionWSKind(t, conn, "operation_authorized")
}

func TestSessionChannelCallbackPathsReserved(t *testing.T) {
	config := configpkg.AuthSettings{PublicOrigin: "https://daynight.example.com"}
	for _, root := range []string{"/api/v1/session-capabilities", "/api/v1/test-session-capabilities", "/api/v1/controller-channel", "/api/v1/controller-resources"} {
		for _, path := range []string{root, root + "/child"} {
			if _, _, err := configpkg.ValidateAuthSettings(config, config.PublicOrigin+path); err == nil {
				t.Fatal("callback overlaps session route", path)
			}
		}
	}
}
