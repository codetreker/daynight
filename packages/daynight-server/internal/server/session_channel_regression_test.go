package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/coder/websocket"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestControllerChannelRejectsInvalidGrantsBeforeUpgrade(t *testing.T) {
	for _, kind := range []string{"unknown", "expired", "consumed", "revoked"} {
		t.Run(kind, func(t *testing.T) {
			f := sessionHTTPSetup(t)
			token := f.grant.Token
			switch kind {
			case "unknown":
				token = "dncontroller_invalid"
			case "expired":
				expired := time.Now().Add(-time.Second)
				f.record.GrantExpiry = &expired
			case "consumed":
				f.record.Consumed = true
			case "revoked":
				f.credentialRevoked = true
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
		f.supplyState(state)
		source, _ := strconv.ParseInt(seq, 10, 64)
		f.supplySource(source)
	}
	publish("1")
	submit := func() sp.Command {
		command := sp.Command{Protocol: sp.Protocol, RequestID: "stale-offer", Fence: snapshot.Fence, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"bounded test input"}],"expectedTurnId":null}`)}
		f.expectCommand(t, command)
		receipt := decodeResponse[struct {
			Operation sp.Operation `json:"operation"`
		}](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+snapshot.SessionID+"/commands", jsonBody(t, command)), http.StatusAccepted).Operation
		f.suppliedOperation(t, command, receipt)
		f.selectOffers(t, command.OperationID)
		sessionWSKind(t, conn, "operation_offer")
		f.suppliedOffer(t, command.OperationID, snapshot.ConnectionEpoch)
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
	f.supplyReceipt(t, receipt)
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence})
	sessionWSKind(t, conn, "heartbeat_ack")
	state.Activity = "idle"
	publish("3")
	command = submit()
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID})
	sessionWSKind(t, conn, "operation_authorized")
}

func TestSessionChannelCallbackPathsReserved(t *testing.T) {
	config := authconfig.AuthSettings{PublicOrigin: "https://daynight.example.com"}
	for _, root := range []string{"/api/v1/session-capabilities", "/api/v1/test-session-capabilities", "/api/v1/controller-channel", "/api/v1/controller-resources"} {
		for _, path := range []string{root, root + "/child"} {
			if _, _, err := authconfig.ValidateAuthSettings(config, config.PublicOrigin+path); err == nil {
				t.Fatal("callback overlaps session route", path)
			}
		}
	}
}
