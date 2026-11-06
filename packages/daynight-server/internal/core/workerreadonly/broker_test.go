package workerreadonly

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBrokerRoutesAndFencesResults(t *testing.T) {
	b := New(func(context.Context, model.Principal, string) error { return nil })
	p := model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.PATCredential}
	worker := uuid.NewString()
	c, err := b.Connect(context.Background(), p, worker, Hello{Type: "hello", Protocol: Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	answer := make(chan Message, 1)
	go func() {
		m, e := b.Request(context.Background(), p, worker, Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)})
		if e != nil {
			t.Error(e)
		}
		answer <- m
	}()
	var m Message
	select {
	case m = <-c.Messages:
	case <-time.After(time.Second):
		t.Fatal("not dispatched")
	}
	bad := m
	bad.Type = "result"
	bad.Input = nil
	bad.Operation = ""
	bad.TimeoutMs = 0
	bad.ConnectionID = uuid.NewString()
	bad.Result = json.RawMessage(`{"path":"/","parentPath":null,"entries":[],"nextCursor":null}`)
	if err = b.Deliver(context.Background(), c, bad); err == nil {
		t.Fatal("accepted wrong connection")
	}
	good := bad
	good.ConnectionID = m.ConnectionID
	if err = b.Deliver(context.Background(), c, good); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-answer:
		if got.RequestID != m.RequestID {
			t.Fatal("identity lost")
		}
	case <-time.After(time.Second):
		t.Fatal("no response")
	}
	if err = b.Deliver(context.Background(), c, good); err == nil {
		t.Fatal("accepted late duplicate")
	}
}

func brokerPrincipal() model.Principal {
	return model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.PATCredential}
}
func brokerHello() Hello {
	return Hello{Type: "hello", Protocol: Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}}
}
func brokerInput() Request {
	return Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)}
}
func receiveRequest(t *testing.T, c *Connection) Message {
	t.Helper()
	select {
	case m := <-c.Messages:
		return m
	case <-time.After(time.Second):
		t.Fatal("request did not arrive")
		return Message{}
	}
}
func TestBrokerDisconnectReplacementAndCancellation(t *testing.T) {
	for _, mode := range []string{"disconnect", "replace", "close", "cancel", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			b := New(func(context.Context, model.Principal, string) error { return nil })
			defer b.Close()
			p := brokerPrincipal()
			worker := uuid.NewString()
			c, err := b.Connect(context.Background(), p, worker, brokerHello())
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "timeout" {
				var stop context.CancelFunc
				ctx, stop = context.WithTimeout(ctx, 50*time.Millisecond)
				defer stop()
			}
			input := brokerInput()
			answer := make(chan error, 1)
			go func() { _, e := b.Request(ctx, p, worker, input); answer <- e }()
			m := receiveRequest(t, c)
			switch mode {
			case "disconnect":
				b.Disconnect(c)
			case "replace":
				if _, err = b.Connect(context.Background(), p, worker, brokerHello()); err != nil {
					t.Fatal(err)
				}
			case "close":
				b.Close()
			case "cancel":
				cancel()
			}
			err = <-answer
			want := "offline"
			if mode == "cancel" {
				want = "cancelled"
			}
			if mode == "timeout" {
				want = "timeout"
			}
			if ErrorCode(err) != want {
				t.Fatalf("wanted %s got %v", want, err)
			}
			if mode == "cancel" || mode == "timeout" {
				if cancel := receiveRequest(t, c); cancel.Type != "cancel" || cancel.RequestID != m.RequestID {
					t.Fatal("wrong cancellation")
				}
				if _, err = b.Request(context.Background(), p, worker, input); ErrorCode(err) != "invalid_input" {
					t.Fatal("cancelled requestId was reused", err)
				}
			}
			late := Message{Fence: m.Fence, Type: "result", RequestID: m.RequestID, Error: &Error{Code: "not_found", Message: "not found"}}
			if e := b.Deliver(context.Background(), c, late); e == nil {
				t.Fatal("late result was accepted")
			}
		})
	}
}
func TestBrokerCredentialRevocationPreventsDispatchAndDelivery(t *testing.T) {
	var mu sync.Mutex
	revoked := ""
	b := New(func(_ context.Context, p model.Principal, _ string) error {
		mu.Lock()
		defer mu.Unlock()
		if p.CredentialID == revoked {
			return fault("unauthenticated", "revoked")
		}
		return nil
	})
	defer b.Close()
	workerPrincipal := brokerPrincipal()
	caller := workerPrincipal
	caller.CredentialID = uuid.NewString()
	worker := uuid.NewString()
	c, err := b.Connect(context.Background(), workerPrincipal, worker, brokerHello())
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	revoked = workerPrincipal.CredentialID
	mu.Unlock()
	if _, err = b.Request(context.Background(), caller, worker, brokerInput()); ErrorCode(err) != "unauthenticated" {
		t.Fatal("revoked Worker credential dispatched", err)
	}
	select {
	case <-c.Messages:
		t.Fatal("unauthorized directory work was dispatched")
	default:
	}
	mu.Lock()
	revoked = ""
	mu.Unlock()
	c, err = b.Connect(context.Background(), workerPrincipal, worker, brokerHello())
	if err != nil {
		t.Fatal(err)
	}
	answer := make(chan error, 1)
	go func() { _, e := b.Request(context.Background(), caller, worker, brokerInput()); answer <- e }()
	m := receiveRequest(t, c)
	mu.Lock()
	revoked = caller.CredentialID
	mu.Unlock()
	if err = b.Deliver(context.Background(), c, Message{Fence: m.Fence, Type: "result", RequestID: m.RequestID, Error: &Error{Code: "not_found", Message: "not found"}}); err != nil {
		t.Fatal(err)
	}
	if err = <-answer; ErrorCode(err) != "unauthenticated" {
		t.Fatal("revoked caller received result", err)
	}
}
func TestBrokerOwnerRoutingCapacityAndInputAdmission(t *testing.T) {
	b := New(func(context.Context, model.Principal, string) error { return nil })
	defer b.Close()
	p := brokerPrincipal()
	other := brokerPrincipal()
	worker := uuid.NewString()
	c, err := b.Connect(context.Background(), p, worker, brokerHello())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.Request(context.Background(), other, worker, brokerInput()); ErrorCode(err) != "unsupported" {
		t.Fatal("another owner routed", err)
	}
	if _, err = b.Request(context.Background(), p, uuid.NewString(), brokerInput()); ErrorCode(err) != "unsupported" {
		t.Fatal("another worker routed", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	answers := make(chan error, 16)
	for range 16 {
		go func() { _, e := b.Request(ctx, p, worker, brokerInput()); answers <- e }()
		receiveRequest(t, c)
	}
	if _, err = b.Request(context.Background(), p, worker, brokerInput()); ErrorCode(err) != "busy" {
		t.Fatal("capacity bypass", err)
	}
	cancel()
	for range 16 {
		<-answers
	}
	c.seen = map[string]bool{}
	for i := 0; i < 4096; i++ {
		c.seen[uuid.NewString()] = true
	}
	if _, err = b.Request(context.Background(), p, worker, brokerInput()); ErrorCode(err) != "offline" {
		t.Fatal("identity budget bypass", err)
	}
	if _, err = b.Request(context.Background(), p, "bad", brokerInput()); ErrorCode(err) != "invalid_input" {
		t.Fatal(err)
	}
	if _, err = b.Request(context.Background(), model.Principal{}, worker, brokerInput()); err == nil {
		t.Fatal("anonymous request")
	}
	bad := brokerInput()
	bad.Operation = "exec"
	if _, err = b.Request(context.Background(), p, worker, bad); ErrorCode(err) != "unsupported" {
		t.Fatal(err)
	}
	hello := brokerHello()
	hello.Protocol = "old"
	if _, err = b.Connect(context.Background(), p, worker, hello); ErrorCode(err) != "unsupported" {
		t.Fatal(err)
	}
	p.Kind = model.SessionCredential
	if _, err = b.Connect(context.Background(), p, worker, brokerHello()); ErrorCode(err) != "permission_denied" {
		t.Fatal("cookie connected", err)
	}
	p.Kind = model.PATCredential
	if _, err = b.Connect(context.Background(), p, "bad", brokerHello()); ErrorCode(err) != "invalid_input" {
		t.Fatal(err)
	}
	b.Close()
	if _, err = b.Connect(context.Background(), p, worker, brokerHello()); ErrorCode(err) != "offline" {
		t.Fatal(err)
	}
}

type cancellationProbeKey struct{}

func TestBrokerCallerContextDoesNotInvalidateSharedConnection(t *testing.T) {
	for _, phase := range []string{"before_dispatch", "before_delivery", "actor_before_dispatch", "actor_before_delivery"} {
		for _, end := range []string{"cancel", "deadline"} {
			t.Run(phase+"/"+end, func(t *testing.T) {
				workerPrincipal := brokerPrincipal()
				caller := workerPrincipal
				caller.CredentialID = uuid.NewString()
				other := caller
				other.CredentialID = uuid.NewString()
				worker := uuid.NewString()
				entered := make(chan struct{}, 1)
				checks := 0
				b := New(func(ctx context.Context, p model.Principal, _ string) error {
					target := workerPrincipal.CredentialID
					if strings.HasPrefix(phase, "actor_") {
						target = caller.CredentialID
					}
					if ctx.Value(cancellationProbeKey{}) == true && p.CredentialID == target {
						checks++
						if strings.HasSuffix(phase, "before_dispatch") || checks == 2 {
							entered <- struct{}{}
							<-ctx.Done()
							return fmt.Errorf("credential query interrupted: %w", ctx.Err())
						}
					}
					return nil
				})
				defer b.Close()
				c, err := b.Connect(context.Background(), workerPrincipal, worker, brokerHello())
				if err != nil {
					t.Fatal(err)
				}
				otherAnswer := make(chan error, 1)
				go func() { _, err := b.Request(context.Background(), other, worker, brokerInput()); otherAnswer <- err }()
				otherRequest := receiveRequest(t, c)
				tagged := context.WithValue(context.Background(), cancellationProbeKey{}, true)
				var ctx context.Context
				var cancel context.CancelFunc
				if end == "deadline" {
					ctx, cancel = context.WithTimeout(tagged, 500*time.Millisecond)
				} else {
					ctx, cancel = context.WithCancel(tagged)
				}
				defer cancel()
				answer := make(chan error, 1)
				go func() { _, err := b.Request(ctx, caller, worker, brokerInput()); answer <- err }()
				if strings.HasSuffix(phase, "before_delivery") {
					m := receiveRequest(t, c)
					if err = b.Deliver(context.Background(), c, Message{Fence: m.Fence, Type: "result", RequestID: m.RequestID, Error: &Error{Code: "not_found", Message: "not found"}}); err != nil {
						t.Fatal(err)
					}
				}
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("authorization was not reached")
				}
				if end == "cancel" {
					cancel()
				}
				err = <-answer
				want := "cancelled"
				if end == "deadline" {
					want = "timeout"
				}
				if ErrorCode(err) != want {
					t.Errorf("request context lost: want %s got %v", want, err)
				}
				select {
				case <-c.Done:
					t.Fatal("one caller's context closed the shared connection")
				default:
				}
				if err = b.Deliver(context.Background(), c, Message{Fence: otherRequest.Fence, Type: "result", RequestID: otherRequest.RequestID, Error: &Error{Code: "not_found", Message: "not found"}}); err != nil {
					t.Fatal(err)
				}
				if err = <-otherAnswer; err != nil {
					t.Fatal("uncancelled request failed", err)
				}
				if err = b.Check(context.Background(), c); err != nil {
					t.Fatal("connection was not retained", err)
				}
			})
		}
	}
}
