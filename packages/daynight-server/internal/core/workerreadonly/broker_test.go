package workerreadonly

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"reflect"
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

type routingContextKey struct{}

type routingMarker struct {
	target int
	phase  string
	page   int
}

// TestBrokerRoutesTwoLiveWorkers exercises both connections across the complete
// pagination sequence. The supplied directory pages are independent inputs to
// the broker; the test does not model filesystem or cursor generation.
func TestBrokerRoutesTwoLiveWorkers(t *testing.T) {
	type target struct {
		principal model.Principal
		worker    string
		hello     Hello
		requests  []Request
		results   []json.RawMessage
		want      []json.RawMessage
	}
	targets := []target{
		{
			principal: model.Principal{UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001", Kind: model.PATCredential},
			worker:    "30000000-0000-4000-8000-000000000001",
			hello:     Hello{Type: "hello", Protocol: Protocol, CapabilityGeneration: "40000000-0000-4000-8000-000000000001", Operations: []string{"directory.list"}},
			requests: []Request{
				{RequestID: "50000000-0000-4000-8000-000000000001", Operation: "directory.list", Input: json.RawMessage(`{"limit":1}`)},
				{RequestID: "50000000-0000-4000-8000-000000000002", Operation: "directory.list", Input: json.RawMessage(`{"limit":1,"cursor":"alpha-first"}`)},
				{RequestID: "50000000-0000-4000-8000-000000000003", Operation: "directory.list", Input: json.RawMessage(`{"limit":1,"cursor":"alpha-second"}`)},
			},
			results: []json.RawMessage{
				json.RawMessage(`{"path":"/native/alpha","parentPath":"/native","entries":[{"name":"alpha-a","path":"/native/alpha/alpha-a"}],"nextCursor":"alpha-first"}`),
				json.RawMessage(`{"path":"/native/alpha","parentPath":"/native","entries":[{"name":"alpha-b","path":"/native/alpha/alpha-b"}],"nextCursor":"alpha-second"}`),
				json.RawMessage(`{"path":"/native/alpha","parentPath":"/native","entries":[{"name":"alpha-c","path":"/native/alpha/alpha-c"}],"nextCursor":null}`),
			},
			want: []json.RawMessage{
				json.RawMessage(`{"path":"/native/alpha","parentPath":"/native","entries":[{"name":"alpha-a","path":"/native/alpha/alpha-a"}],"nextCursor":"alpha-first"}`),
				json.RawMessage(`{"path":"/native/alpha","parentPath":"/native","entries":[{"name":"alpha-b","path":"/native/alpha/alpha-b"}],"nextCursor":"alpha-second"}`),
				json.RawMessage(`{"path":"/native/alpha","parentPath":"/native","entries":[{"name":"alpha-c","path":"/native/alpha/alpha-c"}],"nextCursor":null}`),
			},
		},
		{
			principal: model.Principal{UserID: "10000000-0000-4000-8000-000000000002", CredentialID: "20000000-0000-4000-8000-000000000002", Kind: model.PATCredential},
			worker:    "30000000-0000-4000-8000-000000000002",
			hello:     Hello{Type: "hello", Protocol: Protocol, CapabilityGeneration: "40000000-0000-4000-8000-000000000002", Operations: []string{"directory.list"}},
			requests: []Request{
				{RequestID: "50000000-0000-4000-8000-000000000004", Operation: "directory.list", Input: json.RawMessage(`{"limit":1}`)},
				{RequestID: "50000000-0000-4000-8000-000000000005", Operation: "directory.list", Input: json.RawMessage(`{"limit":1,"cursor":"beta-first"}`)},
				{RequestID: "50000000-0000-4000-8000-000000000006", Operation: "directory.list", Input: json.RawMessage(`{"limit":1,"cursor":"beta-second"}`)},
			},
			results: []json.RawMessage{
				json.RawMessage(`{"path":"/native/beta","parentPath":"/native","entries":[{"name":"beta-a","path":"/native/beta/beta-a"}],"nextCursor":"beta-first"}`),
				json.RawMessage(`{"path":"/native/beta","parentPath":"/native","entries":[{"name":"beta-b","path":"/native/beta/beta-b"}],"nextCursor":"beta-second"}`),
				json.RawMessage(`{"path":"/native/beta","parentPath":"/native","entries":[{"name":"beta-c","path":"/native/beta/beta-c"}],"nextCursor":null}`),
			},
			want: []json.RawMessage{
				json.RawMessage(`{"path":"/native/beta","parentPath":"/native","entries":[{"name":"beta-a","path":"/native/beta/beta-a"}],"nextCursor":"beta-first"}`),
				json.RawMessage(`{"path":"/native/beta","parentPath":"/native","entries":[{"name":"beta-b","path":"/native/beta/beta-b"}],"nextCursor":"beta-second"}`),
				json.RawMessage(`{"path":"/native/beta","parentPath":"/native","entries":[{"name":"beta-c","path":"/native/beta/beta-c"}],"nextCursor":null}`),
			},
		},
	}
	var mu sync.Mutex
	calls := map[routingMarker]int{}
	requestContexts := map[routingMarker]context.Context{}
	b := New(func(ctx context.Context, p model.Principal, worker string) error {
		marker, ok := ctx.Value(routingContextKey{}).(routingMarker)
		if !ok || marker.target < 0 || marker.target >= len(targets) || (marker.phase != "connect" && marker.phase != "check" && marker.phase != "request" && marker.phase != "deliver") || (marker.phase == "request" || marker.phase == "deliver") && (marker.page < 0 || marker.page >= 3) {
			t.Errorf("unexpected authorization context: %#v", marker)
			return fmt.Errorf("unexpected authorization context")
		}
		if p != targets[marker.target].principal || worker != targets[marker.target].worker {
			t.Errorf("unexpected authorization target: principal=%+v worker=%s marker=%+v", p, worker, marker)
			return fmt.Errorf("unexpected authorization target")
		}
		mu.Lock()
		defer mu.Unlock()
		calls[marker]++
		if marker.phase == "request" {
			if _, ok := ctx.Deadline(); !ok || ctx.Err() != nil {
				t.Errorf("request authorization lacks live derived deadline: %v", ctx.Err())
				return fmt.Errorf("invalid request context")
			}
			if previous := requestContexts[marker]; previous != nil && previous != ctx {
				t.Errorf("request authorization context changed for %+v", marker)
				return fmt.Errorf("request context changed")
			}
			requestContexts[marker] = ctx
		}
		return nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	var requests sync.WaitGroup
	t.Cleanup(func() {
		cancel()
		b.Close()
		done := make(chan struct{})
		go func() { requests.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("request goroutines did not exit")
		}
	})
	marked := func(marker routingMarker) context.Context {
		return context.WithValue(ctx, routingContextKey{}, marker)
	}
	connections := make([]*Connection, len(targets))
	for i, target := range targets {
		var err error
		connections[i], err = b.Connect(marked(routingMarker{i, "connect", 0}), target.principal, target.worker, target.hello)
		if err != nil {
			t.Fatalf("connect target %d: %v", i, err)
		}
		c := connections[i]
		id, err := uuid.Parse(c.ConnectionID)
		if err != nil || id == uuid.Nil || id.String() != c.ConnectionID {
			t.Fatalf("invalid connection ID %q", c.ConnectionID)
		}
		wantFence := Fence{Protocol: Protocol, OwnerUserID: target.principal.UserID, WorkerID: target.worker, ConnectionID: c.ConnectionID, CapabilityGeneration: target.hello.CapabilityGeneration}
		if c.Fence != wantFence || c.Principal != target.principal {
			t.Fatalf("connection %d: got %+v principal %+v", i, c.Fence, c.Principal)
		}
	}
	if connections[0].ConnectionID == connections[1].ConnectionID {
		t.Fatal("connections share an ID")
	}
	for i, c := range connections {
		select {
		case <-c.Done:
			t.Fatalf("connection %d is closed", i)
		default:
		}
	}
	type answer struct {
		message Message
		err     error
	}
	for i, target := range targets {
		for page, input := range target.requests {
			answers := make(chan answer, 1)
			requests.Add(1)
			go func() {
				defer requests.Done()
				m, err := b.Request(marked(routingMarker{i, "request", page}), target.principal, target.worker, input)
				answers <- answer{m, err}
			}()
			var frame Message
			select {
			case frame = <-connections[i].Messages:
			case result := <-answers:
				t.Fatalf("target %d page %d returned before dispatch: %v", i, page, result.err)
			case <-time.After(3 * time.Second):
				t.Fatalf("target %d page %d not dispatched", i, page)
			}
			wantFence := Fence{Protocol: Protocol, OwnerUserID: target.principal.UserID, WorkerID: target.worker, ConnectionID: connections[i].ConnectionID, CapabilityGeneration: target.hello.CapabilityGeneration}
			wantFrame := Message{Fence: wantFence, Type: "request", RequestID: input.RequestID, Operation: "directory.list", Input: input.Input, TimeoutMs: int(RequestTimeout / time.Millisecond)}
			if !reflect.DeepEqual(frame, wantFrame) {
				t.Fatalf("target %d page %d frame: got %+v want %+v", i, page, frame, wantFrame)
			}
			select {
			case extra := <-connections[1-i].Messages:
				t.Fatalf("message entered other queue: %+v", extra)
			default:
			}
			result := Message{Fence: wantFence, Type: "result", RequestID: input.RequestID, Result: target.results[page]}
			wantResult := Message{Fence: wantFence, Type: "result", RequestID: input.RequestID, Result: target.want[page]}
			if err := b.Deliver(marked(routingMarker{i, "deliver", page}), connections[i], result); err != nil {
				t.Fatalf("target %d page %d delivery: %v", i, page, err)
			}
			select {
			case got := <-answers:
				if got.err != nil || !reflect.DeepEqual(got.message, wantResult) {
					t.Fatalf("target %d page %d result: got %+v, %v; want %+v", i, page, got.message, got.err, wantResult)
				}
			case <-time.After(3 * time.Second):
				t.Fatalf("target %d page %d did not complete", i, page)
			}
			if err := b.Deliver(marked(routingMarker{i, "deliver", page}), connections[i], result); ErrorCode(err) != "cancelled" {
				t.Fatalf("duplicate delivery accepted: %v", err)
			}
			select {
			case extra := <-answers:
				t.Fatalf("duplicate completion: %+v", extra)
			case extra := <-connections[i].Messages:
				t.Fatalf("extra queue message: %+v", extra)
			default:
			}
		}
	}
	for i, c := range connections {
		if err := b.Check(marked(routingMarker{i, "check", 0}), c); err != nil {
			t.Fatalf("connection %d is not current: %v", i, err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	for i := range targets {
		for _, phase := range []string{"connect", "check"} {
			marker := routingMarker{i, phase, 0}
			if calls[marker] != 1 {
				t.Errorf("authorization %+v: got %d calls, want 1", marker, calls[marker])
			}
			delete(calls, marker)
		}
		for page := range 3 {
			for phase, want := range map[string]int{"request": 4, "deliver": 3} {
				marker := routingMarker{i, phase, page}
				if calls[marker] != want {
					t.Errorf("authorization %+v: got %d calls, want %d", marker, calls[marker], want)
				}
				delete(calls, marker)
			}
		}
	}
	if len(calls) != 0 {
		t.Errorf("unexpected authorization calls: %+v", calls)
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
