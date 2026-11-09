package prompt

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const user = "11111111-1111-4111-8111-111111111111"
const other = "22222222-2222-4222-8222-222222222222"
const worker = "33333333-3333-4333-8333-333333333333"
const project = "44444444-4444-4444-8444-444444444444"

var principal = model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: other}

type memory struct {
	store.PromptSnapshot
	store.ProjectReader
	values                                                                       map[string]model.PromptResource
	writes, texts                                                                int
	denied                                                                       bool
	failure                                                                      error
	metadataError, textError, accessError, workerError, resourceError, saveError error
	outcome                                                                      store.TransactionOutcome
}

func (m *memory) key(u string, s model.PromptScope, id string) string { return u + string(s) + id }
func (m *memory) ReadPromptSnapshot(ctx context.Context, fn func(store.PromptSnapshot) error) error {
	if m.failure != nil {
		return m.failure
	}
	return fn(m)
}
func (m *memory) PromptDAO() store.PromptReader   { return m }
func (m *memory) ProjectDAO() store.ProjectReader { return m }
func (m *memory) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	if m.accessError != nil {
		return model.ProjectAccess{}, m.accessError
	}
	if m.denied {
		return model.ProjectAccess{}, model.ErrNotFound
	}
	return model.ProjectAccess{}, nil
}
func (m *memory) PromptWorkerExists(context.Context, string, string) error {
	if m.workerError != nil {
		return m.workerError
	}
	if m.denied {
		return model.ErrNotFound
	}
	return nil
}
func (m *memory) PromptMetadata(_ context.Context, u string, s model.PromptScope, id string) (store.PromptMetadata, error) {
	if m.metadataError != nil {
		return store.PromptMetadata{}, m.metadataError
	}
	v := m.values[m.key(u, s, id)]
	if v.Revision == "" {
		return store.PromptMetadata{}, nil
	}
	n, _ := strconv.ParseInt(v.Revision, 10, 64)
	return store.PromptMetadata{Revision: n, UpdatedAt: v.UpdatedAt}, nil
}
func (m *memory) PromptText(_ context.Context, u string, s model.PromptScope, id string) (string, error) {
	m.texts++
	if m.textError != nil {
		return "", m.textError
	}
	return m.values[m.key(u, s, id)].Text, nil
}
func (m *memory) PromptResource(_ context.Context, u string, s model.PromptScope, id string) (model.PromptResource, error) {
	if m.resourceError != nil {
		return model.PromptResource{}, m.resourceError
	}
	v, ok := m.values[m.key(u, s, id)]
	if !ok {
		return model.PromptResource{Scope: s, ScopeID: id, Revision: "0"}, nil
	}
	return v, nil
}
func (m *memory) LockPromptProject(context.Context, model.Principal, string) error {
	if m.denied {
		return model.ErrNotFound
	}
	return nil
}
func (m *memory) CreatePrompt(_ context.Context, u string, s model.PromptScope, id, text string) (model.PromptResource, error) {
	if m.saveError != nil {
		return model.PromptResource{}, m.saveError
	}
	return m.save(u, s, id, 1, text), nil
}
func (m *memory) UpdatePrompt(_ context.Context, u string, s model.PromptScope, id string, next, expected int64, text string) (model.PromptResource, error) {
	if m.saveError != nil {
		return model.PromptResource{}, m.saveError
	}
	return m.save(u, s, id, next, text), nil
}
func (m *memory) save(u string, s model.PromptScope, id string, n int64, text string) model.PromptResource {
	m.writes++
	now := time.Now()
	v := model.PromptResource{Scope: s, ScopeID: id, Revision: strconv.FormatInt(n, 10), Text: text, UpdatedAt: &now}
	m.values[m.key(u, s, id)] = v
	return v
}
func (m *memory) WritePrompt(_ context.Context, fn func(store.PromptWriteScope) error) (store.Completion, error) {
	if m.failure != nil {
		return store.Completion{}, m.failure
	}
	err := fn(m)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
	out := m.outcome
	if out == "" {
		out = store.TransactionCommitted
	}
	return store.Completion{Outcome: out}, nil
}
func fault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}
func TestGetPutIdentityAndVersions(t *testing.T) {
	m := &memory{values: map[string]model.PromptResource{}}
	svc := New(m)
	ctx := context.Background()
	v, err := svc.Get(ctx, principal, model.PromptScopeUser, user)
	if err != nil || v.Revision != "0" || v.UpdatedAt != nil {
		t.Fatalf("empty: %+v %v", v, err)
	}
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, other, "0", "unsafe")
	fault(t, err, "identity_mismatch")
	if m.writes != 0 {
		t.Fatal("wrong identity wrote")
	}
	v, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "0", "")
	if err != nil || m.writes != 0 {
		t.Fatalf("empty no-op: %+v %v", v, err)
	}
	v, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "0", "text")
	if err != nil || v.Revision != "1" {
		t.Fatalf("create: %+v %v", v, err)
	}
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "0", "text")
	fault(t, err, "version_conflict")
	v, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "")
	if err != nil || v.Revision != "2" {
		t.Fatalf("clear: %+v %v", v, err)
	}
	v, err = svc.Get(ctx, principal, model.PromptScopeUser, user)
	if err != nil || v.Revision != "2" || v.Text != "" {
		t.Fatalf("read: %+v %v", v, err)
	}
	m.denied = true
	_, err = svc.Get(ctx, principal, model.PromptScopeProject, project)
	fault(t, err, "not_found")
	_, err = svc.Put(ctx, principal, model.PromptScopeProject, project, user, "0", "x")
	fault(t, err, "not_found")
	_, err = svc.Put(ctx, principal, model.PromptScopeWorker, worker, user, "0", "x")
	fault(t, err, "not_found")
}
func TestBatchKnownAndVisibility(t *testing.T) {
	m := &memory{values: map[string]model.PromptResource{}}
	m.save(user, model.PromptScopeUser, user, 1, "known")
	ctx := context.Background()
	known := "1"
	zero := "0"
	selectors := []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeUser}, KnownRevision: &known}, {Key: model.PromptKey{Scope: model.PromptScopeWorker}, KnownRevision: &zero}, {Key: model.PromptKey{Scope: model.PromptScopeProject, ProjectID: project}}}
	result, err := Batch(ctx, m, principal, worker, selectors)
	if err != nil || len(result) != 3 || result[0].Status != "unchanged" || result[1].Status != "unchanged" || result[2].Value == nil || result[2].Value.Revision != "0" || m.texts != 0 {
		t.Fatalf("batch %+v, %v, text queries %d", result, err, m.texts)
	}
	selectors[0].KnownRevision = nil
	result, err = Batch(ctx, m, principal, worker, selectors)
	if err != nil || result[0].Value.Text != "known" || m.texts != 1 {
		t.Fatalf("value %+v %v", result, err)
	}
	m.denied = true
	result, err = Batch(ctx, m, principal, worker, selectors)
	if err != nil || result[1].Status != "unavailable" || result[2].Status != "unavailable" {
		t.Fatalf("unavailable %+v %v", result, err)
	}
	_, err = Batch(ctx, m, principal, worker, append(selectors, selectors[0]))
	fault(t, err, "invalid_input")
	_, err = Batch(ctx, m, principal, worker, []model.PromptSelector{selectors[0], selectors[0]})
	fault(t, err, "invalid_input")
	m.failure = errors.New("offline")
	if _, err = Batch(ctx, m, principal, worker, selectors); !errors.Is(err, m.failure) {
		t.Fatal(err)
	}
}

func TestFailuresAndInputRejection(t *testing.T) {
	ctx := context.Background()
	m := &memory{values: map[string]model.PromptResource{}}
	svc := New(m)
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
	m.metadataError = marker
	_, err = svc.Get(ctx, principal, model.PromptScopeUser, user)
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	m.metadataError = nil
	m.save(user, model.PromptScopeUser, user, 1, "x")
	m.textError = marker
	_, err = svc.Get(ctx, principal, model.PromptScopeUser, user)
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	_, err = svc.Batch(ctx, principal, worker, []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeUser}}})
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	m.textError = nil
	m.resourceError = marker
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "y")
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	m.resourceError = nil
	m.saveError = marker
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "y")
	if !errors.Is(err, marker) {
		t.Fatal(err)
	}
	m.saveError = nil
	m.outcome = store.TransactionUnknown
	_, err = svc.Put(ctx, principal, model.PromptScopeUser, user, user, "1", "x")
	if err == nil {
		t.Fatal("unconfirmed transaction accepted")
	}
	m.outcome = ""
	m.accessError = marker
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
