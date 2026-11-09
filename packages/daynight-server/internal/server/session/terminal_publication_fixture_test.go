package session_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type terminalPublicationOutcome struct {
	scope   *routeCallScope
	outcome store.Completion
	err     error
}

type terminalMessageGate struct {
	profile    string
	projection terminalProjection
	completed  chan terminalPublicationOutcome
	release    chan struct{}
	once       sync.Once
}

func (g *terminalMessageGate) releaseCompletion() { g.once.Do(func() { close(g.release) }) }

type terminalPublicationWrites struct {
	saved      [][]byte
	operations []store.TerminalOperation
	results    []v2.OperationResult
	epochs     []int64
	evidence   []terminalRouteEvidence
}

func (f *terminalHTTPFixture) publicationWrites(scope *routeCallScope) terminalPublicationWrites {
	f.state.mu.Lock()
	defer f.state.mu.Unlock()
	var out terminalPublicationWrites
	for i, token := range f.state.writes.savedScopes {
		if token == scope {
			out.saved = append(out.saved, append([]byte(nil), f.state.writes.saved[i]...))
		}
	}
	for i, token := range f.state.writes.operationScopes {
		if token == scope {
			out.operations = append(out.operations, routeCopy(f.state.writes.operations[i]))
		}
	}
	for i, token := range f.state.writes.resultScopes {
		if token == scope {
			out.results = append(out.results, routeCopy(f.state.writes.results[i]))
		}
	}
	for i, token := range f.state.writes.epochScopes {
		if token == scope {
			out.epochs = append(out.epochs, f.state.writes.epochs[i])
		}
	}
	for i, token := range f.state.writes.evidenceScopes {
		if token == scope {
			out.evidence = append(out.evidence, f.state.writes.evidence[i])
		}
	}
	return out
}

func (f *terminalHTTPFixture) installTerminalPublicationOutcomes() {
	for _, name := range []string{"terminal-bind", "terminal-reconnect", "terminal-ledger", "terminal-generation", "terminal-recording", "terminal-evidence", "terminal-finalize", "terminal-worker-initial", "terminal-worker-state", "terminal-ack", "terminal-submit", "terminal-socket-initial", "terminal-socket-state", "terminal-socket-write"} {
		f.backend.Outcome(name, func(ctx context.Context, cause error) (store.Completion, error) {
			completion, result := f.backend.CompletionFn(ctx, cause)
			f.state.mu.Lock()
			gate := f.state.messageGate
			f.state.mu.Unlock()
			if gate == nil {
				return completion, result
			}
			if profile := routeProfileFor(ctx); profile != gate.profile {
				return completion, result
			}
			select {
			case gate.completed <- terminalPublicationOutcome{scope: routeScopeToken(ctx), outcome: completion, err: result}:
			case <-ctx.Done():
				return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
			}
			select {
			case <-gate.release:
			case <-ctx.Done():
				return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
			}
			return completion, result
		})
	}
}

func (f *terminalHTTPFixture) beginPublication(t *testing.T, profile string, projection terminalProjection) *terminalMessageGate {
	t.Helper()
	gate := &terminalMessageGate{profile: profile, projection: projection, completed: make(chan terminalPublicationOutcome, 1), release: make(chan struct{})}
	f.state.mu.Lock()
	if f.state.messageGate != nil {
		f.state.mu.Unlock()
		t.Fatal("a foreground terminal publication is already selected")
	}
	f.state.messageGate = gate
	f.state.mu.Unlock()
	t.Cleanup(gate.releaseCompletion)
	return gate
}

func (f *terminalHTTPFixture) finishPublication(t *testing.T, gate *terminalMessageGate, handler <-chan error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var completed terminalPublicationOutcome
	select {
	case completed = <-gate.completed:
	case err := <-handler:
		t.Fatal("terminal HTTP handler ended before its declared publication", err)
	case <-ctx.Done():
		t.Fatal("terminal mutation completion was not observed", gate.profile)
	}
	if completed.outcome.Outcome != store.TransactionCommitted || completed.err != nil {
		t.Fatal("terminal mutation did not confirm commit", gate.profile, completed.outcome, completed.err)
	}
	writes := f.publicationWrites(completed.scope)
	projection := gate.projection
	if projection.Record == nil || len(writes.saved) != 1 {
		t.Fatal("terminal mutation did not propose exactly one selected record", gate.profile, len(writes.saved))
	}
	expected := routeCopy(*projection.Record)
	if projection.RuntimeSeen {
		actual := terminalDecodeRecord(t, writes.saved[0])
		if actual.LastSeen == nil || time.Since(*actual.LastSeen) < -time.Second || time.Since(*actual.LastSeen) > time.Minute {
			t.Fatal("terminal mutation omitted its runtime timestamp")
		}
		expected.LastSeen = actual.LastSeen
	}
	nextRaw := []byte(jsonBody(t, expected))
	terminalAssertRecordJSON(t, writes.saved[0], nextRaw)
	if projection.Evidence != nil && (len(writes.evidence) != 1 || writes.evidence[0] != *projection.Evidence) {
		t.Fatal("recording evidence proposal changed canonical identity or digest")
	}
	if projection.Result != nil && (len(writes.results) != 1 || !reflect.DeepEqual(writes.results[0], *projection.Result)) {
		t.Fatal("control result proposal changed the selected Worker receipt")
	}
	var operation *store.TerminalOperation
	if projection.Submit != nil {
		if len(writes.operations) != 1 {
			t.Fatal("control request did not propose exactly one operation")
		}
		value := terminalProjectedOperation(t, *projection.Submit, writes.operations[0])
		operation = &value
		f.prepareDispatch(t, value.OperationID)
	}
	f.input(func(in *terminalRouteInput) {
		in.Raw = nextRaw
		if projection.Evidence != nil {
			in.Evidence = append(in.Evidence, *projection.Evidence)
		}
		if projection.Result != nil {
			if in.Operation == nil {
				panic("result publication has no supplied operation")
			}
			value := *in.Operation
			value.Result = *projection.Result
			in.Operation = &value
			in.Queued = []string{}
			in.InputPending = false
			in.ViewerPending = false
		}
		if operation != nil {
			in.Operation = operation
			in.Queued = []string{operation.OperationID}
			in.InputPending = true
			in.ViewerPending = true
		}
	})
	gate.releaseCompletion()
	f.state.mu.Lock()
	f.state.messageGate = nil
	f.state.mu.Unlock()
}

func terminalProjectedOperation(t *testing.T, projection terminalSubmitProjection, proposal store.TerminalOperation) store.TerminalOperation {
	t.Helper()
	message := projection.Message
	request := message.Payload.(v2.ControlRequest)
	command := struct {
		v2.Envelope
		Request *v2.ControlRequest `json:"request,omitempty"`
	}{message.Envelope, &request}
	canonical, err := v2.CanonicalJSON(message)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(canonical)
	expected := store.TerminalOperation{SessionID: message.SessionID, OperationID: request.OperationID, Command: []byte(jsonBody(t, command)), Result: v2.OperationResult{OperationID: request.OperationID, State: "queued"}, Actor: projection.Actor, Hash: hash[:], Seq: projection.Seq, Deadline: proposal.Deadline}
	remaining := time.Until(proposal.Deadline)
	if remaining < time.Duration(v2.InputTimeoutMillis)*time.Millisecond-time.Second || remaining > time.Duration(v2.InputTimeoutMillis)*time.Millisecond+time.Second || !reflect.DeepEqual(proposal, expected) {
		t.Fatal("queued control proposal changed actor, durable intent, digest, sequence or deadline")
	}
	return expected
}

func terminalHTTPAsync(handler http.Handler, response *httptest.ResponseRecorder, request *http.Request) <-chan error {
	done := make(chan error, 1)
	go func() {
		completed := false
		defer func() {
			if cause := recover(); cause != nil {
				if err, ok := cause.(error); ok {
					done <- fmt.Errorf("terminal HTTP fixture panicked: %w", err)
				} else {
					done <- fmt.Errorf("terminal HTTP fixture panicked: %v", cause)
				}
			} else if !completed {
				done <- fmt.Errorf("terminal HTTP fixture exited without a result")
			}
			close(done)
		}()
		handler.ServeHTTP(response, request)
		completed = true
		done <- nil
	}()
	return done
}

func (f *terminalHTTPFixture) projectedHTTPRequest(t *testing.T, request *http.Request, profile string, projection terminalProjection) *httptest.ResponseRecorder {
	t.Helper()
	gate := f.beginPublication(t, profile, projection)
	request.Header.Set(routePlanHeader, profile)
	response := httptest.NewRecorder()
	done := terminalHTTPAsync(f.h, response, request)
	t.Cleanup(func() {
		gate.releaseCompletion()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("terminal HTTP fixture did not drain")
		}
	})
	f.finishPublication(t, gate, done)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("terminal HTTP response did not complete")
	}
	return response
}

func (f *terminalHTTPFixture) submitControl(t *testing.T, message v2.Message, browser string) v2.Message {
	t.Helper()
	input := f.inputSnapshot().(terminalRouteInput)
	projection := terminalControlProjection(t, input, f.h.principal, message)
	request := httptest.NewRequest(http.MethodPost, f.base+"/"+message.SessionID+"/commands", strings.NewReader(jsonBody(t, message)))
	authorizeResourceRequest(f.h, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(v2.ProtocolHeader, v2.Protocol)
	request.Header.Set("Daynight-Browser-Client", browser)
	return terminalMessage(t, f.projectedHTTPRequest(t, request, "terminal-submit", projection))
}
