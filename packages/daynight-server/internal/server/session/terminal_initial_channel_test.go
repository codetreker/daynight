package session_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func terminalWireScope(t *testing.T, f *terminalHTTPFixture, ctx context.Context, principal model.Principal, project, task, id string) error {
	t.Helper()
	registration := f.message.Payload.(v2.Registration)
	if principal != f.h.principal || project != registration.Owner.ProjectID || task != registration.Owner.TaskID || id != f.message.SessionID {
		err := fmt.Errorf("terminal call changed its principal or route scope")
		t.Error(err)
		return err
	}
	return ctx.Err()
}

func terminalWireWorker(t *testing.T, f *terminalHTTPFixture, cleanupFence v2.Envelope) <-chan struct{} {
	t.Helper()
	disconnected := make(chan struct{}, 1)
	f.calls.Funcs.RegisterTerminal = func(ctx context.Context, principal model.Principal, project, task string, message v2.Message) (v2.Message, error) {
		if err := terminalWireScope(t, f, ctx, principal, project, task, message.SessionID); err != nil {
			return v2.Message{}, err
		}
		if !reflect.DeepEqual(message, f.message) {
			err := errors.New("worker registration changed its decoded message")
			t.Error(err)
			return v2.Message{}, err
		}
		return f.ack("1"), nil
	}
	f.calls.Funcs.BindTerminalConnection = func(ctx context.Context, principal model.Principal, project, task, id string, fence v2.Envelope, epoch string) error {
		if err := terminalWireScope(t, f, ctx, principal, project, task, id); err != nil {
			return err
		}
		if fence != f.message.Envelope || epoch != "1" {
			err := errors.New("worker bind changed the registration fence or acknowledged connection epoch")
			t.Error(err)
			return err
		}
		return nil
	}
	f.calls.Funcs.DisconnectTerminal = func(ctx context.Context, principal model.Principal, project, task, id string, fence v2.Envelope, epoch string) error {
		if err := terminalWireScope(t, f, ctx, principal, project, task, id); err != nil {
			return err
		}
		deadline, bounded := ctx.Deadline()
		if fence != cleanupFence || epoch != "1" || !bounded || time.Until(deadline) <= 0 || time.Until(deadline) > 5*time.Second {
			err := errors.New("worker cleanup changed its latest fence, epoch or fresh bounded context")
			t.Error(err)
			return err
		}
		disconnected <- struct{}{}
		return nil
	}
	return disconnected
}

func terminalWireDial(t *testing.T, f *terminalHTTPFixture) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	worker, _, err := websocket.Dial(ctx, f.server.URL+f.base+"/"+f.message.SessionID+"/worker-channel", &websocket.DialOptions{HTTPHeader: f.workerHeaders(), Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = worker.CloseNow() })
	f.handshake(t, worker)
	return worker
}

func terminalWireDisconnected(t *testing.T, f *terminalHTTPFixture, disconnected <-chan struct{}) {
	t.Helper()
	select {
	case <-disconnected:
	case <-time.After(3 * time.Second):
		t.Fatal("terminal worker cleanup did not complete")
	}
	f.waitConnections(t, 0)
}

func TestTerminalWorkerChannelAcknowledgesInitialDeliveryObservation(t *testing.T) {
	f := terminalHTTPSetup(t)
	disconnected := terminalWireWorker(t, f, f.message.Envelope)
	f.calls.AllowRepeated("PollTerminal")
	f.calls.Funcs.PollTerminal = func(ctx context.Context, principal model.Principal, project, task, id string, fence v2.Envelope, epoch string) ([]v2.Message, error) {
		if err := terminalWireScope(t, f, ctx, principal, project, task, id); err != nil {
			return nil, err
		}
		if fence != f.message.Envelope || epoch != "1" {
			err := errors.New("initial channel poll changed its registered fence or connection epoch")
			t.Error(err)
			return nil, err
		}
		return []v2.Message{}, nil
	}
	input := f.message
	input.Type = "control_state"
	input.Payload = v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "pending", AvailableActions: []string{"acquire_control"}}
	result := input
	result.Payload = v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "suspended", InitialAssignment: "unconfirmed", AvailableActions: []string{}}
	f.calls.Funcs.HandleTerminalControl = func(ctx context.Context, principal model.Principal, project, task, id, epoch string, message v2.Message) (v2.Message, error) {
		if err := terminalWireScope(t, f, ctx, principal, project, task, id); err != nil {
			return v2.Message{}, err
		}
		if epoch != "1" || !reflect.DeepEqual(message, input) {
			err := errors.New("initial delivery observation changed before the service call")
			t.Error(err)
			return v2.Message{}, err
		}
		return result, nil
	}
	worker := terminalWireDial(t, f)
	ack := f.workerMessage(t, worker, input)
	if !reflect.DeepEqual(ack, result) {
		t.Fatalf("initial delivery acknowledgement changed the supplied service result: %#v", ack)
	}
	_ = worker.CloseNow()
	terminalWireDisconnected(t, f, disconnected)
}

func TestTerminalWorkerChannelClosesOnInitialDeliveryError(t *testing.T) {
	for _, initial := range []string{"unknown", "unconfirmed", "transport_completed"} {
		t.Run(initial, func(t *testing.T) {
			f := terminalHTTPSetup(t)
			disconnected := terminalWireWorker(t, f, f.message.Envelope)
			f.calls.AllowRepeated("PollTerminal")
			f.calls.Funcs.PollTerminal = func(ctx context.Context, principal model.Principal, project, task, id string, fence v2.Envelope, epoch string) ([]v2.Message, error) {
				if err := terminalWireScope(t, f, ctx, principal, project, task, id); err != nil {
					return nil, err
				}
				if fence != f.message.Envelope || epoch != "1" {
					err := errors.New("refused initial observation changed the channel poll fence")
					t.Error(err)
					return nil, err
				}
				return []v2.Message{}, nil
			}
			input := f.message
			input.Type = "control_state"
			input.Payload = v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "suspended", InitialAssignment: initial, AvailableActions: []string{}}
			f.calls.Funcs.HandleTerminalControl = func(ctx context.Context, principal model.Principal, project, task, id, epoch string, message v2.Message) (v2.Message, error) {
				if err := terminalWireScope(t, f, ctx, principal, project, task, id); err != nil {
					return v2.Message{}, err
				}
				if epoch != "1" || !reflect.DeepEqual(message, input) {
					err := errors.New("refused initial observation changed its decoded message")
					t.Error(err)
					return v2.Message{}, err
				}
				return v2.Message{}, &model.Fault{Code: "resource_conflict", Message: "Initial delivery observation was refused."}
			}
			worker := terminalWireDial(t, f)
			sessionWSWrite(t, worker, input)
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			if _, _, err := worker.Read(ctx); err == nil || ctx.Err() != nil {
				t.Fatalf("service refusal did not close the initial observation channel before its deadline: %v", err)
			}
			terminalWireDisconnected(t, f, disconnected)
		})
	}
}
