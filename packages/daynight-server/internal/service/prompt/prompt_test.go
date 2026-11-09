package prompt

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/prompt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const user = "11111111-1111-4111-8111-111111111111"
const other = "22222222-2222-4222-8222-222222222222"
const worker = "33333333-3333-4333-8333-333333333333"
const project = "44444444-4444-4444-8444-444444444444"

var principal = model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: other}

type call struct {
	name   string
	args   []any
	result any
	err    error
}
type promptMock struct {
	t            *testing.T
	expected     []call
	writeContext context.Context
}

func (m *promptMock) expect(name string, result any, err error, args ...any) {
	m.expected = append(m.expected, call{name, args, result, err})
}
func (m *promptMock) next(name string, args ...any) call {
	m.t.Helper()
	if len(m.expected) == 0 {
		m.t.Fatalf("unexpected %s(%v)", name, args)
	}
	c := m.expected[0]
	m.expected = m.expected[1:]
	if c.name != name || !reflect.DeepEqual(c.args, args) {
		m.t.Fatalf("got %s(%v), expected %s(%v)", name, args, c.name, c.args)
	}
	return c
}
func (m *promptMock) checkContext(ctx context.Context) {
	m.t.Helper()
	if m.writeContext != nil && ctx != m.writeContext {
		m.t.Fatal("DAO context changed")
	}
}
func (m *promptMock) check() {
	m.t.Helper()
	if len(m.expected) > 0 {
		m.t.Fatalf("unconsumed calls: %+v", m.expected)
	}
}
func (m *promptMock) snapshot() { m.expect("snapshot", nil, nil) }

type transactionFixture struct {
	completion           store.Completion
	phase                string
	cleanup              error
	cause                error
	expectOperationError bool
}
type decisionResult struct {
	next    int64
	changed bool
}

func (m *promptMock) write(outcome store.TransactionOutcome) {
	m.expect("write", transactionFixture{completion: store.Completion{Outcome: outcome}}, nil)
}
func (m *promptMock) writeFailure(outcome store.TransactionOutcome, phase string, cleanup error) {
	m.expect("write", transactionFixture{completion: store.Completion{Outcome: outcome}, phase: phase, cleanup: cleanup, expectOperationError: true}, nil)
}
func (m *promptMock) decide(current model.PromptResource, expected int64, text string) (int64, bool, error) {
	c := m.next("decision", current, expected, text)
	if c.err != nil {
		return 0, false, c.err
	}
	result := c.result.(decisionResult)
	return result.next, result.changed, nil
}
func testService(m *promptMock) *Prompts { return &Prompts{store: m, decideVersion: m.decide} }
func (m *promptMock) ReadPromptSnapshot(ctx context.Context, fn func(store.PromptSnapshot) error) error {
	c := m.next("snapshot")
	if c.err != nil {
		return c.err
	}
	return fn(m)
}
func (m *promptMock) WritePrompt(ctx context.Context, fn func(store.PromptWriteScope) error) (store.Completion, error) {
	if m.writeContext != nil && ctx != m.writeContext {
		m.t.Fatalf("write context changed")
	}
	c := m.next("write")
	if c.err != nil {
		return store.Completion{}, c.err
	}
	config := c.result.(transactionFixture)
	operationErr := fn(m)
	if config.phase != "" {
		if (operationErr != nil) != config.expectOperationError {
			m.t.Fatalf("unexpected callback result: %v", operationErr)
		}
		return config.completion, &store.TransactionError{Phase: config.phase, Outcome: config.completion.Outcome, CleanupFailed: config.cleanup != nil, Cause: errors.Join(operationErr, config.cause, config.cleanup)}
	}
	if operationErr != nil {
		m.t.Fatalf("unexpected callback error: %v", operationErr)
	}
	return config.completion, nil
}
func (m *promptMock) ProjectAccess(_ context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	c := m.next("access", p, id)
	return model.ProjectAccess{}, c.err
}
func (m *promptMock) LockPromptProject(ctx context.Context, p model.Principal, id string) error {
	m.checkContext(ctx)
	return m.next("lock", p, id).err
}
func (m *promptMock) PromptWorkerExists(ctx context.Context, u, id string) error {
	m.checkContext(ctx)
	return m.next("worker", u, id).err
}
func (m *promptMock) PromptMetadata(_ context.Context, u string, s model.PromptScope, id string) (store.PromptMetadata, error) {
	c := m.next("metadata", u, s, id)
	if c.err != nil {
		return store.PromptMetadata{}, c.err
	}
	return c.result.(store.PromptMetadata), nil
}
func (m *promptMock) PromptText(_ context.Context, u string, s model.PromptScope, id string) (string, error) {
	c := m.next("text", u, s, id)
	if c.err != nil {
		return "", c.err
	}
	return c.result.(string), nil
}
func (m *promptMock) PromptResource(ctx context.Context, u string, s model.PromptScope, id string) (model.PromptResource, error) {
	m.checkContext(ctx)
	c := m.next("resource", u, s, id)
	if c.err != nil {
		return model.PromptResource{}, c.err
	}
	return c.result.(model.PromptResource), nil
}
func (m *promptMock) CreatePrompt(ctx context.Context, u string, s model.PromptScope, id, text string) (model.PromptResource, error) {
	m.checkContext(ctx)
	c := m.next("create", u, s, id, text)
	if c.err != nil {
		return model.PromptResource{}, c.err
	}
	return c.result.(model.PromptResource), nil
}
func (m *promptMock) UpdatePrompt(ctx context.Context, u string, s model.PromptScope, id string, next, expected int64, text string) (model.PromptResource, error) {
	m.checkContext(ctx)
	c := m.next("update", u, s, id, next, expected, text)
	if c.err != nil {
		return model.PromptResource{}, c.err
	}
	return c.result.(model.PromptResource), nil
}
func fault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
func mock(t *testing.T) *promptMock { m := &promptMock{t: t}; t.Cleanup(m.check); return m }

func TestGetPutIdentityAndVersions(t *testing.T) {
	m := mock(t)
	svc := testService(m)
	ctx := context.WithValue(context.Background(), struct{}{}, "request")
	m.writeContext = ctx
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	empty := model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "0"}
	first := model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "1", Text: "text", UpdatedAt: &now}
	cleared := model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "2", UpdatedAt: &now}
	m.snapshot()
	m.expect("metadata", store.PromptMetadata{}, nil, user, model.PromptScopeUser, user)
	v, err := svc.Get(ctx, principal, model.PromptScopeUser, user)
	if err != nil || v != empty {
		t.Fatalf("empty: %+v %v", v, err)
	}
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, other, "0", "unsafe")
	fault(t, err, "identity_mismatch")
	m.write(store.TransactionCommitted)
	m.expect("resource", empty, nil, user, model.PromptScopeUser, user)
	m.expect("decision", decisionResult{0, false}, nil, empty, int64(0), "")
	v, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "0", "")
	if err != nil || v != empty {
		t.Fatalf("empty no-op: %+v %v", v, err)
	}
	m.write(store.TransactionCommitted)
	m.expect("resource", empty, nil, user, model.PromptScopeUser, user)
	m.expect("decision", decisionResult{1, true}, nil, empty, int64(0), "text")
	m.expect("create", first, nil, user, model.PromptScopeUser, user, "text")
	v, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "0", "text")
	if err != nil || v != first {
		t.Fatalf("create: %+v %v", v, err)
	}
	m.writeFailure(store.TransactionNotCommitted, "operation", nil)
	m.expect("resource", first, nil, user, model.PromptScopeUser, user)
	m.expect("decision", nil, &model.Fault{Code: "version_conflict", Message: "changed"}, first, int64(0), "text")
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "0", "text")
	fault(t, err, "version_conflict")
	m.write(store.TransactionCommitted)
	m.expect("resource", first, nil, user, model.PromptScopeUser, user)
	m.expect("decision", decisionResult{2, true}, nil, first, int64(1), "")
	m.expect("update", cleared, nil, user, model.PromptScopeUser, user, int64(2), int64(1), "")
	v, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "")
	if err != nil || v != cleared {
		t.Fatalf("clear: %+v %v", v, err)
	}
	m.snapshot()
	m.expect("metadata", store.PromptMetadata{Revision: 2, UpdatedAt: &now}, nil, user, model.PromptScopeUser, user)
	m.expect("text", "", nil, user, model.PromptScopeUser, user)
	v, err = svc.Get(ctx, principal, model.PromptScopeUser, user)
	if err != nil || v != cleared {
		t.Fatalf("read: %+v %v", v, err)
	}
	m.snapshot()
	m.expect("access", nil, model.ErrNotFound, principal, project)
	_, err = svc.Get(ctx, principal, model.PromptScopeProject, project)
	fault(t, err, "not_found")
	m.writeFailure(store.TransactionNotCommitted, "operation", nil)
	m.expect("lock", nil, model.ErrNotFound, principal, project)
	_, err = svc.Put(ctx, principal, model.PromptScopeProject, project, user, "0", "x")
	fault(t, err, "not_found")
	m.writeFailure(store.TransactionNotCommitted, "operation", nil)
	m.expect("worker", nil, model.ErrNotFound, user, worker)
	_, err = svc.Put(ctx, principal, model.PromptScopeWorker, worker, user, "0", "x")
	fault(t, err, "not_found")
}

func TestBatchKnownAndVisibility(t *testing.T) {
	m := mock(t)
	ctx := context.Background()
	known, zero := "1", "0"
	selectors := []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeUser}, KnownRevision: &known}, {Key: model.PromptKey{Scope: model.PromptScopeWorker}, KnownRevision: &zero}, {Key: model.PromptKey{Scope: model.PromptScopeProject, ProjectID: project}}}
	setup := func(withText, denied bool) {
		m.snapshot()
		m.expect("metadata", store.PromptMetadata{Revision: 1}, nil, user, model.PromptScopeUser, user)
		if withText {
			m.expect("text", "known", nil, user, model.PromptScopeUser, user)
		}
		if denied {
			m.expect("worker", nil, model.ErrNotFound, user, worker)
			m.expect("access", nil, model.ErrNotFound, principal, project)
			return
		}
		m.expect("worker", nil, nil, user, worker)
		m.expect("metadata", store.PromptMetadata{}, nil, user, model.PromptScopeWorker, worker)
		m.expect("access", nil, nil, principal, project)
		m.expect("metadata", store.PromptMetadata{}, nil, user, model.PromptScopeProject, project)
	}
	setup(false, false)
	result, err := Batch(ctx, m, principal, worker, selectors)
	if err != nil || len(result) != 3 || result[0].Status != "unchanged" || result[1].Status != "unchanged" || result[2].Value == nil || result[2].Value.Revision != "0" {
		t.Fatalf("batch %+v, %v", result, err)
	}
	selectors[0].KnownRevision = nil
	setup(true, false)
	result, err = Batch(ctx, m, principal, worker, selectors)
	if err != nil || result[0].Value.Text != "known" {
		t.Fatalf("value %+v %v", result, err)
	}
	setup(true, true)
	result, err = Batch(ctx, m, principal, worker, selectors)
	if err != nil || result[1].Status != "unavailable" || result[2].Status != "unavailable" {
		t.Fatalf("unavailable %+v %v", result, err)
	}
	_, err = Batch(ctx, m, principal, worker, append(selectors, selectors[0]))
	fault(t, err, "invalid_input")
	_, err = Batch(ctx, m, principal, worker, []model.PromptSelector{selectors[0], selectors[0]})
	fault(t, err, "invalid_input")
	offline := errors.New("offline")
	m.expect("snapshot", nil, offline)
	if _, err = Batch(ctx, m, principal, worker, selectors); !errors.Is(err, offline) {
		t.Fatal(err)
	}
}

func TestFailuresAndInputRejection(t *testing.T) {
	ctx := context.Background()
	m := mock(t)
	svc := testService(m)
	marker := errors.New("private storage failure")
	bad := model.Principal{}
	_, err := svc.Get(ctx, bad, model.PromptScopeUser, user)
	fault(t, err, "unauthenticated")
	_, err = svc.Get(ctx, principal, "bad", user)
	fault(t, err, "invalid_input")
	_, err = svc.Get(ctx, principal, model.PromptScopeUser, "invalid")
	fault(t, err, "invalid_input")
	_, err = svc.Get(ctx, principal, model.PromptScopeUser, other)
	fault(t, err, "invalid_input")
	_, err = svc.Put(ctx, bad, model.PromptScopeUser, user, user, "0", "x")
	fault(t, err, "unauthenticated")
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, "bad", "0", "x")
	fault(t, err, "invalid_input")
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, "bad", user, "0", "x")
	fault(t, err, "invalid_input")
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "01", "x")
	fault(t, err, "invalid_input")
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "0", "\x00")
	fault(t, err, "invalid_input")
	m.snapshot()
	m.expect("metadata", nil, marker, user, model.PromptScopeUser, user)
	_, err = svc.Get(ctx, principal, model.PromptScopeUser, user)
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	m.snapshot()
	m.expect("metadata", store.PromptMetadata{Revision: 1}, nil, user, model.PromptScopeUser, user)
	m.expect("text", nil, marker, user, model.PromptScopeUser, user)
	_, err = svc.Get(ctx, principal, model.PromptScopeUser, user)
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	m.snapshot()
	m.expect("metadata", store.PromptMetadata{Revision: 1}, nil, user, model.PromptScopeUser, user)
	m.expect("text", nil, marker, user, model.PromptScopeUser, user)
	_, err = svc.Batch(ctx, principal, worker, []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeUser}}})
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	m.writeFailure(store.TransactionNotCommitted, "operation", nil)
	m.expect("resource", nil, marker, user, model.PromptScopeUser, user)
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "y")
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	first := model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "1", Text: "x"}
	m.writeFailure(store.TransactionNotCommitted, "operation", nil)
	m.expect("resource", first, nil, user, model.PromptScopeUser, user)
	m.expect("decision", decisionResult{2, true}, nil, first, int64(1), "y")
	m.expect("update", nil, marker, user, model.PromptScopeUser, user, int64(2), int64(1), "y")
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "y")
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	m.write(store.TransactionUnknown)
	m.expect("resource", first, nil, user, model.PromptScopeUser, user)
	m.expect("decision", decisionResult{1, false}, nil, first, int64(1), "x")
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "x")
	if err == nil {
		t.Fatal("unconfirmed transaction accepted")
	}
	m.snapshot()
	m.expect("access", nil, marker, principal, project)
	_, err = svc.Batch(ctx, principal, worker, []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeProject, ProjectID: project}}})
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	_, err = svc.Batch(ctx, bad, worker, nil)
	fault(t, err, "unauthenticated")
	_, err = svc.Batch(ctx, principal, "bad", nil)
	fault(t, err, "invalid_input")
	_, err = svc.Batch(ctx, principal, worker, []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeProject, ProjectID: "bad"}}})
	fault(t, err, "invalid_input")
	_, err = svc.Batch(ctx, principal, worker, []model.PromptSelector{{Key: model.PromptKey{Scope: "bad"}}})
	fault(t, err, "invalid_input")
	invalidRevision := "01"
	_, err = svc.Batch(ctx, principal, worker, []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeUser}, KnownRevision: &invalidRevision}})
	fault(t, err, "invalid_input")
}

func TestCorruptStoredTextFailsWithoutClientFault(t *testing.T) {
	ctx := context.Background()
	m := mock(t)
	svc := testService(m)
	badText := "bad\x01text"
	check := func(err error) {
		t.Helper()
		var f *model.Fault
		if err == nil || errors.As(err, &f) {
			t.Fatalf("corrupt storage must be internal: %v", err)
		}
	}
	m.snapshot()
	m.expect("metadata", store.PromptMetadata{Revision: 1}, nil, user, model.PromptScopeUser, user)
	m.expect("text", badText, nil, user, model.PromptScopeUser, user)
	_, err := svc.Get(ctx, principal, model.PromptScopeUser, user)
	check(err)
	m.snapshot()
	m.expect("metadata", store.PromptMetadata{Revision: 1}, nil, user, model.PromptScopeUser, user)
	m.expect("text", badText, nil, user, model.PromptScopeUser, user)
	_, err = svc.Batch(ctx, principal, worker, []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeUser}}})
	check(err)
	current := model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "1", Text: badText}
	m.writeFailure(store.TransactionNotCommitted, "operation", nil)
	m.expect("resource", current, nil, user, model.PromptScopeUser, user)
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "safe")
	check(err)
	known := "1"
	m.snapshot()
	m.expect("metadata", store.PromptMetadata{Revision: 1}, nil, user, model.PromptScopeUser, user)
	results, err := svc.Batch(ctx, principal, worker, []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeUser}, KnownRevision: &known}})
	if err != nil || len(results) != 1 || results[0].Status != "unchanged" {
		t.Fatalf("unchanged: %+v %v", results, err)
	}
}

func TestWriteCompletionKeepsOperationAndCleanupFailures(t *testing.T) {
	ctx := context.Background()
	m := mock(t)
	svc := testService(m)
	current := model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "1", Text: "before"}
	refusal := &model.Fault{Code: "version_conflict", Message: "revision changed"}
	cleanup := errors.New("rollback failure")
	m.writeFailure(store.TransactionUnknown, "cleanup", cleanup)
	m.expect("resource", current, nil, user, model.PromptScopeUser, user)
	m.expect("decision", nil, refusal, current, int64(1), "after")
	value, err := svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "after")
	if value != (model.PromptResource{}) {
		t.Fatalf("cleanup failure returned resource: %+v", value)
	}
	var txErr *store.TransactionError
	if !errors.As(err, &txErr) || txErr.Outcome != store.TransactionUnknown || !txErr.CleanupFailed || !errors.Is(err, refusal) || !errors.Is(err, cleanup) || err == refusal {
		t.Fatalf("cleanup failure lost: %v", err)
	}
	commitErr := errors.New("commit response lost")
	m.expect("write", transactionFixture{completion: store.Completion{Outcome: store.TransactionUnknown}, phase: "commit", cause: commitErr}, nil)
	m.expect("resource", current, nil, user, model.PromptScopeUser, user)
	m.expect("decision", decisionResult{2, true}, nil, current, int64(1), "after")
	updated := model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "2", Text: "after"}
	m.expect("update", updated, nil, user, model.PromptScopeUser, user, int64(2), int64(1), "after")
	value, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "after")
	if value != (model.PromptResource{}) {
		t.Fatalf("commit failure returned resource: %+v", value)
	}
	if !errors.As(err, &txErr) || txErr.Outcome != store.TransactionUnknown || !errors.Is(err, commitErr) {
		t.Fatalf("commit failure lost: %v", err)
	}
}

func TestNewBindsProductionVersionDecision(t *testing.T) {
	svc := New(mock(t))
	if svc.decideVersion == nil || reflect.ValueOf(svc.decideVersion).Pointer() != reflect.ValueOf(core.Next).Pointer() {
		t.Fatal("production version decision is not bound")
	}
}
