package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestControllerChannelFailureDiagnostics(t *testing.T) {
	for _, phase := range []string{"controller_connect", "controller_source", "controller_fence", "controller_handle", "controller_poll"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			failure := &model.Fault{Code: "not_found", Message: "Session was not found.", Cause: &store.Error{Phase: "read image upload", MissingRow: true, Cause: errors.New("PRIVATE-DATABASE-CANARY")}}
			fence := sp.ControllerFence{Fence: sp.Fence{SessionID: "11111111-1111-4111-8111-111111111111", ClaimID: "22222222-2222-4222-8222-222222222222", ExecutionGeneration: "1"}, ConnectionEpoch: "3"}
			routes := newRoutes(serviceCalls{
				AuthenticateController: func(context.Context, string) error { return nil },
				Connect: func(context.Context, string, sp.ControllerMessage, string, int) (sp.Snapshot, error) {
					if phase == "controller_connect" {
						return sp.Snapshot{}, failure
					}
					return sp.Snapshot{ControllerFence: fence}, nil
				},
				SourceSeq: func(context.Context, sp.ControllerFence) (int64, error) {
					if phase == "controller_source" {
						return 0, failure
					}
					return 7, nil
				},
				Handle: func(context.Context, sp.ControllerMessage) (map[string]any, error) { return nil, failure },
				Poll: func(context.Context, sp.ControllerFence) ([]map[string]any, error) {
					if phase == "controller_poll" {
						return nil, failure
					}
					return nil, nil
				},
				Disconnect: func(context.Context, sp.ControllerFence) error { return nil },
			}, nil, logger)
			done := make(chan struct{})
			handler := httpx.RequestLogging(logger, http.HandlerFunc(routes.controllerChannel))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { defer close(done); handler.ServeHTTP(w, r) }))
			defer server.Close()
			conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{Subprotocols: []string{sp.Protocol}, HTTPHeader: http.Header{"Authorization": []string{"Bearer dncontroller_PRIVATE-TOKEN-CANARY"}, "X-Request-Id": []string{"controller-diagnostics-test"}}})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			hello := sp.BindingFields(fence.Fence, map[string]any{"sessionId": fence.SessionID, "claimId": fence.ClaimID, "executionGeneration": fence.ExecutionGeneration, "type": "hello", "protocol": sp.Protocol, "schemaVersion": 1, "projectionVersion": 1, "controllerId": fence.SessionID, "controllerInstanceId": fence.ClaimID, "provider": "codex", "sourceEpoch": fence.SessionID, "lastAckedSourceSeq": "0", "contentRevision": 2})
			if err = wsjson.Write(ctx, conn, hello); err != nil {
				t.Fatal(err)
			}
			var response map[string]any
			err = wsjson.Read(ctx, conn, &response)
			if phase == "controller_connect" {
				if err == nil {
					t.Fatalf("connect failure unexpectedly sent a public frame: %+v", response)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if phase != "controller_source" {
					if response["type"] != "welcome" {
						t.Fatalf("missing welcome: %+v", response)
					}
					if phase != "controller_poll" {
						epoch := fence.ConnectionEpoch
						if phase == "controller_fence" {
							epoch = "2"
						}
						if err = wsjson.Write(ctx, conn, sp.BindingFields(fence.Fence, map[string]any{"sessionId": fence.SessionID, "claimId": fence.ClaimID, "executionGeneration": fence.ExecutionGeneration, "type": "heartbeat", "protocol": sp.Protocol, "connectionEpoch": epoch})); err != nil {
							t.Fatal(err)
						}
					}
					response = nil
					if err = wsjson.Read(ctx, conn, &response); err != nil {
						t.Fatal(err)
					}
				}
				code, message := "not_found", "Session was not found."
				if phase == "controller_fence" {
					code, message = "session_conflict", "Controller connection fence changed."
				}
				if response["type"] != "error" || response["code"] != code || response["message"] != message || response["sessionId"] != fence.SessionID || response["claimId"] != fence.ClaimID || response["executionGeneration"] != "1" || response["connectionEpoch"] != "3" || response["protocol"] != sp.Protocol || len(response) != 8 {
					t.Fatalf("public error contract changed: %+v", response)
				}
				if err = wsjson.Read(ctx, conn, &response); err == nil {
					t.Fatal("channel remained open after failure")
				}
			}
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("controller handler did not finish")
			}
			if strings.Contains(logs.String(), "CANARY") {
				t.Fatalf("sensitive diagnostics: %s", logs.String())
			}
			var diagnostic map[string]any
			decoder := json.NewDecoder(bytes.NewReader(logs.Bytes()))
			for decoder.More() {
				var entry map[string]any
				if err = decoder.Decode(&entry); err != nil {
					t.Fatal(err)
				}
				if entry["type"] == "operation_error" {
					diagnostic = entry
				}
			}
			if diagnostic == nil || diagnostic["phase"] != phase || diagnostic["component"] != "session" || diagnostic["request_id"] != "controller-diagnostics-test" {
				t.Fatalf("missing correlated phase: %+v", diagnostic)
			}
			if phase == "controller_handle" {
				if diagnostic["message_type"] != "heartbeat" {
					t.Fatalf("missing handled message type: %+v", diagnostic)
				}
			} else if _, ok := diagnostic["message_type"]; ok {
				t.Fatalf("unexpected handled message type: %+v", diagnostic)
			}
			if phase != "controller_fence" && diagnostic["storage_phase"] != "image_upload_read" {
				t.Fatalf("missing wrapped storage phase: %+v", diagnostic)
			}
		})
	}
}

func TestControllerDiagnosticMetadataBoundaries(t *testing.T) {
	safeStore := &store.Error{Phase: "read original source hash", Cause: errors.New("PRIVATE-CAUSE-CANARY")}
	unknownStore := &store.Error{Phase: "PRIVATE-PHASE-CANARY"}
	for _, test := range []struct {
		name    string
		failure error
		storage string
	}{
		{"wrapped", &model.Fault{Code: "not_found", Message: "PRIVATE-MESSAGE-CANARY", Cause: safeStore}, "source_hash_read"},
		{"joined", errors.Join(unknownStore, errors.Join(errors.New("PRIVATE-JOIN-CANARY"), safeStore)), "source_hash_read"},
		{"unknown", unknownStore, ""},
		{"oversized", &store.Error{Phase: strings.Repeat("read original source hash", 1000)}, ""},
		{"plain", errors.New("PRIVATE-MESSAGE-CANARY"), ""},
		{"empty join", errors.Join(errors.New("PRIVATE-JOIN-CANARY"), unknownStore), ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			routes := newRoutes(serviceCalls{}, nil, slog.New(slog.NewJSONHandler(&logs, nil)))
			routes.logControllerFailure(context.Background(), "controller_handle", "PRIVATE-TYPE-CANARY", test.failure)
			var entry map[string]any
			if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(logs.String(), "CANARY") {
				t.Fatalf("sensitive diagnostics: %s", logs.String())
			}
			if _, ok := entry["message_type"]; ok {
				t.Fatalf("arbitrary message type was accepted: %+v", entry)
			}
			if test.storage == "" {
				if _, ok := entry["storage_phase"]; ok {
					t.Fatalf("invented storage phase: %+v", entry)
				}
			} else if entry["storage_phase"] != test.storage {
				t.Fatalf("lost nested storage phase: %+v", entry)
			}
		})
	}
	for _, messageType := range []string{"events", "source_reset", "operation_begin", "operation_receipt", "reconcile", "heartbeat", "content_response", "sync_state", "image_response", "image_capture"} {
		t.Run(messageType, func(t *testing.T) {
			var logs bytes.Buffer
			routes := newRoutes(serviceCalls{}, nil, slog.New(slog.NewJSONHandler(&logs, nil)))
			routes.logControllerFailure(context.Background(), "controller_handle", messageType, errors.New("PRIVATE-CAUSE-CANARY"))
			var entry map[string]any
			if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
				t.Fatal(err)
			}
			if entry["message_type"] != messageType {
				t.Fatalf("missing accepted message type: %+v", entry)
			}
		})
	}
}

func TestControllerCanceledFailureDoesNotLogOrWrite(t *testing.T) {
	var logs bytes.Buffer
	routes := newRoutes(serviceCalls{}, nil, slog.New(slog.NewJSONHandler(&logs, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	routes.logControllerFailure(ctx, "controller_connect", "", errors.New("canceled"))
	routes.channelFailure(ctx, nil, sp.ControllerFence{}, "controller_source", "", errors.New("canceled"))
	if logs.Len() != 0 {
		t.Fatalf("canceled channel logged a failure: %s", logs.String())
	}
}
