package workerreadonly

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

// Authorize rechecks both the credential and owner-scoped Worker identity.
type Authorize func(context.Context, model.Principal, string) error

type Connection struct {
	Fence
	Principal  model.Principal
	Messages   chan Message
	Done       chan struct{}
	pending    map[string]*pending
	seen       map[string]bool
	operations map[string]bool
}
type pending struct {
	actor     model.Principal
	answer    chan outcome
	operation string
	provider  string
}
type outcome struct {
	message Message
	err     error
}
type Broker struct {
	mu           sync.Mutex
	authorize    Authorize
	connections  map[string]*Connection
	disconnected map[string]time.Time
	count        int
	closing      bool
}

func New(authorize Authorize) *Broker {
	return &Broker{authorize: authorize, connections: map[string]*Connection{}, disconnected: map[string]time.Time{}}
}
func key(owner, worker string) string { return owner + "/" + worker }
func (b *Broker) Connect(ctx context.Context, p model.Principal, worker string, h Hello) (*Connection, error) {
	if e := ValidateHello(h); e != nil {
		return nil, e
	}
	if p.Kind != model.PATCredential {
		return nil, fault("permission_denied", "Worker channels require a personal access token.")
	}
	if e := model.RequirePrincipal(p); e != nil {
		return nil, e
	}
	if !validID(worker) {
		return nil, fault("invalid_input", "Worker ID is invalid.")
	}
	if e := b.authorize(ctx, p, worker); e != nil {
		return nil, e
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closing {
		return nil, fault("offline", "Worker read-only service is stopping.")
	}
	k := key(p.UserID, worker)
	if old := b.connections[k]; old != nil {
		b.disconnect(old, fault("offline", "Worker read-only connection was replaced."))
	}
	if len(b.connections) >= 1024 {
		return nil, fault("busy", "Worker read-only channel capacity is exhausted.")
	}
	c := &Connection{Fence: Fence{Protocol: Protocol, OwnerUserID: p.UserID, WorkerID: worker, ConnectionID: uuid.NewString(), CapabilityGeneration: h.CapabilityGeneration}, Principal: p, Messages: make(chan Message, 32), Done: make(chan struct{}), pending: map[string]*pending{}, seen: map[string]bool{}}
	c.operations = map[string]bool{}
	for _, operation := range h.Operations {
		c.operations[operation] = true
	}
	b.connections[k] = c
	delete(b.disconnected, k)
	for k, at := range b.disconnected {
		if time.Since(at) > 2*time.Minute {
			delete(b.disconnected, k)
		}
	}
	return c, nil
}
func (b *Broker) disconnect(c *Connection, err error) {
	k := key(c.OwnerUserID, c.WorkerID)
	if b.connections[k] != c {
		return
	}
	delete(b.connections, k)
	if len(b.disconnected) < 1024 {
		b.disconnected[k] = time.Now()
	}
	close(c.Done)
	for id, p := range c.pending {
		p.answer <- outcome{err: err}
		delete(c.pending, id)
		b.count--
	}
}
func (b *Broker) Disconnect(c *Connection) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.disconnect(c, fault("offline", "Worker read-only connection is offline."))
}
func (b *Broker) Check(ctx context.Context, c *Connection) error {
	if err := requestContextError(ctx, nil); err != nil {
		return err
	}
	if e := b.authorize(ctx, c.Principal, c.WorkerID); e != nil {
		// A caller's interrupted authority read does not invalidate the shared Worker.
		if ctx.Err() == nil && !errors.Is(e, context.Canceled) && !errors.Is(e, context.DeadlineExceeded) {
			b.Disconnect(c)
		}
		return requestContextError(ctx, e)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.connections[key(c.OwnerUserID, c.WorkerID)] != c {
		return fault("offline", "Worker connection is no longer current.")
	}
	return nil
}
func requestContextError(ctx context.Context, err error) error {
	cause := ctx.Err()
	if cause == nil {
		cause = err
	}
	switch {
	case errors.Is(cause, context.DeadlineExceeded):
		return fault("timeout", "Worker read-only request did not complete before its deadline.")
	case errors.Is(cause, context.Canceled):
		return fault("cancelled", "Worker read-only request was cancelled.")
	default:
		return err
	}
}
func (b *Broker) Request(ctx context.Context, p model.Principal, worker string, r Request) (result Message, err error) {
	timeout := OperationTimeout(r.Operation)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// Normalize every exit while the operation context still reflects its caller or deadline.
	defer func() {
		if failure := requestContextError(ctx, err); failure != nil {
			result = Message{}
			err = failure
		}
	}()
	if err := requestContextError(ctx, nil); err != nil {
		return Message{}, err
	}
	if e := ValidateRequest(r); e != nil {
		return Message{}, e
	}
	if e := model.RequirePrincipal(p); e != nil {
		return Message{}, e
	}
	if !validID(worker) {
		return Message{}, fault("invalid_input", "Worker ID is invalid.")
	}
	if e := b.authorize(ctx, p, worker); e != nil {
		return Message{}, e
	}
	b.mu.Lock()
	k := key(p.UserID, worker)
	c := b.connections[k]
	if c == nil {
		code := "unsupported"
		if b.closing || !b.disconnected[k].IsZero() {
			code = "offline"
		}
		b.mu.Unlock()
		return Message{}, fault(code, "Worker read-only directory browsing is unavailable.")
	}
	b.mu.Unlock()
	if err := b.Check(ctx, c); err != nil {
		return Message{}, err
	}
	b.mu.Lock()
	if b.connections[k] != c {
		b.mu.Unlock()
		return Message{}, fault("offline", "Worker connection changed before dispatch.")
	}
	if !c.operations[r.Operation] {
		b.mu.Unlock()
		return Message{}, fault("unsupported", "Worker does not support the requested read-only operation.")
	}
	if len(c.seen) >= 4096 {
		b.disconnect(c, fault("offline", "Worker request identity capacity requires reconnection."))
		b.mu.Unlock()
		return Message{}, fault("offline", "Worker read-only connection requires renewal.")
	}
	if len(c.pending) >= 16 || b.count >= 1024 {
		b.mu.Unlock()
		return Message{}, fault("busy", "Worker read-only request capacity is exhausted.")
	}
	if c.seen[r.RequestID] {
		b.mu.Unlock()
		return Message{}, fault("invalid_input", "requestId was already used on this connection.")
	}
	work := &pending{actor: p, answer: make(chan outcome, 1), operation: r.Operation}
	if r.Operation == "model.list" {
		var input ModelInput
		_ = json.Unmarshal(r.Input, &input)
		work.provider = input.Provider
	}
	m := Message{Fence: c.Fence, Type: "request", RequestID: r.RequestID, Operation: r.Operation, Input: append(json.RawMessage(nil), r.Input...), TimeoutMs: int(timeout / time.Millisecond)}
	c.pending[r.RequestID] = work
	c.seen[r.RequestID] = true
	b.count++
	select {
	case c.Messages <- m:
	default:
		b.disconnect(c, fault("offline", "Worker read-only channel is not consuming requests."))
	}
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if c.pending[r.RequestID] == work {
			delete(c.pending, r.RequestID)
			b.count--
			select {
			case c.Messages <- Message{Fence: c.Fence, Type: "cancel", RequestID: r.RequestID}:
			default:
				b.disconnect(c, fault("offline", "Worker cancellation could not be delivered."))
			}
		}
	}()
	select {
	case out := <-work.answer:
		if e := ctx.Err(); e != nil {
			return Message{}, e
		}
		if out.err != nil {
			return Message{}, out.err
		}
		if e := b.authorize(ctx, p, worker); e != nil {
			return Message{}, e
		}
		if e := b.Check(ctx, c); e != nil {
			return Message{}, e
		}
		b.mu.Lock()
		current := b.connections[k] == c
		b.mu.Unlock()
		if !current {
			return Message{}, fault("offline", "Worker read-only connection changed before delivery.")
		}
		return out.message, nil
	case <-ctx.Done():
		return Message{}, ctx.Err()
	}
}
func (b *Broker) Deliver(ctx context.Context, c *Connection, m Message) error {
	if e := validateResultEnvelope(m); e != nil {
		return e
	}
	if m.Fence != c.Fence {
		return fault("invalid_input", "Worker response belongs to another connection.")
	}
	if e := b.Check(ctx, c); e != nil {
		return e
	}
	b.mu.Lock()
	work := c.pending[m.RequestID]
	b.mu.Unlock()
	if work == nil {
		return fault("cancelled", "Worker read-only request is no longer active.")
	}
	if e := ValidateOperationResult(m, work.operation); e != nil {
		return e
	}
	if work.operation == "model.list" && m.Error == nil {
		var result ModelResult
		_ = json.Unmarshal(m.Result, &result)
		if result.Provider != work.provider {
			return fault("invalid_input", "Model capabilities belong to another Provider.")
		}
	}
	authErr := b.authorize(ctx, work.actor, c.WorkerID)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.connections[key(c.OwnerUserID, c.WorkerID)] != c || c.pending[m.RequestID] != work {
		return fault("cancelled", "Worker read-only request is no longer active.")
	}
	delete(c.pending, m.RequestID)
	b.count--
	work.answer <- outcome{message: m, err: authErr}
	// Caller authorization belongs to this request, not the shared Worker channel.
	return nil
}
func (b *Broker) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closing = true
	for _, c := range b.connections {
		b.disconnect(c, fault("offline", "Worker read-only service is stopping."))
	}
}
