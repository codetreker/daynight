package tag

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const projectID = "10000000-0000-4000-8000-000000000001"
const tagIDValue = "10000000-0000-4000-8000-000000000002"

var principal = model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000003", CredentialID: "10000000-0000-4000-8000-000000000004"}
var clock = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

type fixture struct {
	store.ProjectWriter
	store.SnapshotReader
	store.ProjectWriteScope
	calls              []string
	item               model.Tag
	accessErr, errorAt error
	stop               string
	completion         store.Completion
	completionErr      error
	seenVersion        int64
	seenTime           time.Time
}

func (f *fixture) call(name string) error {
	f.calls = append(f.calls, name)
	if f.stop == name {
		return f.errorAt
	}
	return nil
}
func (f *fixture) WriteProject(ctx context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
	if id != projectID {
		panic("wrong project")
	}
	f.calls = append(f.calls, "lock")
	err := run(f)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
	return f.completion, f.completionErr
}
func (f *fixture) ProjectDAO() store.ProjectWriteDAO { return &projectDAO{fixture: f} }
func (f *fixture) TagDAO() store.TagWriteDAO         { return &tagDAO{fixture: f} }
func (f *fixture) TaskDAO() store.TaskWriteDAO       { return &taskDAO{fixture: f} }
func (f *fixture) TaskTagDAO() store.TaskTagWriteDAO { return &associationDAO{fixture: f} }

type projectDAO struct {
	store.ProjectWriteDAO
	fixture *fixture
}

func (f *projectDAO) ProjectAccess(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
	x := f.fixture
	if p != principal {
		panic("wrong principal")
	}
	x.call("access")
	return model.ProjectAccess{}, x.accessErr
}
func (f *projectDAO) RotateTagCatalogEpoch(context.Context) error { return f.fixture.call("epoch") }

type tagDAO struct {
	store.TagWriteDAO
	fixture *fixture
}

func (f *tagDAO) Tag(ctx context.Context, id string) (model.Tag, error) {
	x := f.fixture
	if id != tagIDValue {
		panic("wrong tag")
	}
	return x.item, x.call("tag")
}
func (f *tagDAO) TagUsage(ctx context.Context, id string) (model.TagUsage, error) {
	x := f.fixture
	return model.TagUsage{Tasks: 3, Goals: 1}, x.call("usage")
}
func (f *tagDAO) InsertTag(ctx context.Context, item model.Tag) (model.Tag, error) {
	x := f.fixture
	x.item = item
	return item, x.call("insert")
}
func (f *tagDAO) UpdateTag(ctx context.Context, id string, version int64, name, key string, at time.Time) (model.Tag, error) {
	x := f.fixture
	x.seenVersion = version
	x.seenTime = at
	err := x.call("update")
	item := x.item
	item.Name = name
	item.NameKey = key
	item.Version++
	return item, err
}
func (f *tagDAO) DeleteTag(ctx context.Context, id string, version int64) error {
	x := f.fixture
	x.seenVersion = version
	return x.call("delete")
}

type taskDAO struct {
	store.TaskWriteDAO
	fixture *fixture
}

func (f *taskDAO) ObservedAt(context.Context) (time.Time, error) {
	x := f.fixture
	return clock, x.call("time")
}

type associationDAO struct {
	store.TaskTagWriteDAO
	fixture *fixture
}

func (f *associationDAO) TouchTaggedTasks(ctx context.Context, id string, at time.Time) (int64, error) {
	x := f.fixture
	x.seenTime = at
	return 0, x.call("touch")
}
func (f *associationDAO) ClearTagAssociations(context.Context, string) error {
	return f.fixture.call("clear")
}
func newFixture() *fixture {
	return &fixture{item: model.Tag{ID: tagIDValue, ProjectID: projectID, Name: "Alpha", NameKey: "alpha", Version: 7}, completion: store.Completion{Outcome: store.TransactionCommitted}}
}
func faultCode(err error) string {
	var f *model.Fault
	if errors.As(err, &f) {
		return f.Code
	}
	return ""
}
func TestWritesKeepPermissionVersionAndMutationOrder(t *testing.T) {
	t.Run("rename", func(t *testing.T) {
		f := newFixture()
		result, err := New(f).Rename(context.Background(), principal, projectID, tagIDValue, 7, " ALPHA ")
		if err != nil || result.Item.Tag.Name != "ALPHA" || result.Item.Usage.Tasks != 3 || f.seenVersion != 7 || f.seenTime != clock || result.Outcome != store.TransactionCommitted {
			t.Fatalf("result=%+v err=%v", result, err)
		}
		if !reflect.DeepEqual(f.calls, []string{"lock", "access", "tag", "usage", "time", "update", "touch", "epoch"}) {
			t.Fatal(f.calls)
		}
	})
	t.Run("unchanged", func(t *testing.T) {
		f := newFixture()
		_, err := New(f).Rename(context.Background(), principal, projectID, tagIDValue, 7, "Alpha")
		if err != nil || !reflect.DeepEqual(f.calls, []string{"lock", "access", "tag", "usage"}) {
			t.Fatalf("%v %v", f.calls, err)
		}
	})
	t.Run("stale", func(t *testing.T) {
		f := newFixture()
		_, err := New(f).Rename(context.Background(), principal, projectID, tagIDValue, 6, "new")
		if faultCode(err) != "version_conflict" || !reflect.DeepEqual(f.calls, []string{"lock", "access", "tag"}) {
			t.Fatalf("%v %v", f.calls, err)
		}
	})
	t.Run("delete", func(t *testing.T) {
		f := newFixture()
		result, err := New(f).Delete(context.Background(), principal, projectID, tagIDValue, 7, true)
		if err != nil || !result.Deleted || f.seenVersion != 7 || f.seenTime != clock || !reflect.DeepEqual(f.calls, []string{"lock", "access", "tag", "time", "touch", "clear", "delete", "epoch"}) {
			t.Fatalf("%+v %v %v", result, err, f.calls)
		}
	})
	t.Run("unconfirmed", func(t *testing.T) {
		f := newFixture()
		_, err := New(f).Delete(context.Background(), principal, projectID, tagIDValue, 7, false)
		if faultCode(err) != "confirmation_required" || len(f.calls) != 0 {
			t.Fatalf("%v %v", f.calls, err)
		}
	})
	t.Run("permission", func(t *testing.T) {
		f := newFixture()
		f.accessErr = model.ErrNotFound
		_, err := New(f).Delete(context.Background(), principal, projectID, tagIDValue, 7, true)
		if faultCode(err) != "not_found" || !reflect.DeepEqual(f.calls, []string{"lock", "access"}) {
			t.Fatalf("%v %v", f.calls, err)
		}
	})
	t.Run("create", func(t *testing.T) {
		f := newFixture()
		result, err := New(f).Create(context.Background(), principal, projectID, " A ")
		if err != nil || result.Item.Tag.Name != "A" || f.item.NameKey != "a" || f.item.CreatedAt != clock || !reflect.DeepEqual(f.calls, []string{"lock", "access", "time", "insert", "epoch"}) {
			t.Fatalf("%+v %v %v", result, err, f.calls)
		}
	})
}
func TestWriteFailuresDoNotInventCompletionOrReplay(t *testing.T) {
	t.Run("rollback", func(t *testing.T) {
		f := newFixture()
		f.stop = "clear"
		f.errorAt = errors.New("clear failed")
		result, err := New(f).Delete(context.Background(), principal, projectID, tagIDValue, 7, true)
		if !errors.Is(err, f.errorAt) || result.Deleted || result.Outcome != store.TransactionNotCommitted || !reflect.DeepEqual(f.calls, []string{"lock", "access", "tag", "time", "touch", "clear"}) {
			t.Fatalf("%+v %v %v", result, err, f.calls)
		}
	})
	t.Run("unknown", func(t *testing.T) {
		f := newFixture()
		cause := errors.New("lost commit")
		f.completion = store.Completion{Outcome: store.TransactionUnknown}
		f.completionErr = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}
		result, err := New(f).Delete(context.Background(), principal, projectID, tagIDValue, 7, true)
		if !errors.Is(err, cause) || result.Deleted || result.Outcome != store.TransactionUnknown || result.Phase != "commit" || len(f.calls) != 8 {
			t.Fatalf("%+v %v %v", result, err, f.calls)
		}
	})
}

type readFixture struct {
	store.ProjectWriter
	store.SnapshotScope
	store.ProjectReader
	store.TagReader
	calls     []string
	accessErr error
	epoch     string
	page      store.TagPage
	resolved  []model.Tag
	item      model.Tag
	query     store.TagQuery
}

func (f *readFixture) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	f.calls = append(f.calls, "snapshot")
	return run(f)
}
func (f *readFixture) ProjectDAO() store.ProjectReader { return f }
func (f *readFixture) TagDAO() store.TagReader         { return f }
func (f *readFixture) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	f.calls = append(f.calls, "access")
	if p != principal || id != projectID {
		panic("wrong project or principal")
	}
	return model.ProjectAccess{}, f.accessErr
}
func (f *readFixture) TagCatalogEpoch(context.Context, string) (string, error) {
	f.calls = append(f.calls, "epoch")
	return f.epoch, nil
}
func (f *readFixture) Tags(ctx context.Context, id string, q store.TagQuery) (store.TagPage, error) {
	f.calls = append(f.calls, "tags")
	f.query = q
	return f.page, nil
}
func (f *readFixture) Tag(ctx context.Context, project, id string) (model.Tag, error) {
	f.calls = append(f.calls, "tag")
	return f.item, nil
}
func (f *readFixture) TagUsage(ctx context.Context, project, id string) (model.TagUsage, error) {
	f.calls = append(f.calls, "usage")
	return model.TagUsage{Tasks: 2, Goals: 1}, nil
}
func (f *readFixture) ResolveTags(ctx context.Context, project string, ids []string) ([]model.Tag, error) {
	f.calls = append(f.calls, "resolve")
	return f.resolved, nil
}
func TestReadsUseOneAuthorizedSnapshot(t *testing.T) {
	f := &readFixture{epoch: "10000000-0000-4000-8000-000000000005", page: store.TagPage{Items: []model.Tag{{ID: tagIDValue, Name: "Alpha", NameKey: "alpha"}}, HasMore: true}}
	page, err := New(f).List(context.Background(), principal, projectID, ListInput{Query: "AL", Limit: 1})
	if err != nil || page.NextCursor == nil || page.Items[0].Usage.Tasks != 2 || f.query.NameContains != "al" || !reflect.DeepEqual(f.calls, []string{"snapshot", "access", "epoch", "tags", "usage"}) {
		t.Fatalf("page=%+v calls=%v err=%v", page, f.calls, err)
	}
	f.calls = nil
	f.page.HasMore = false
	_, err = New(f).List(context.Background(), principal, projectID, ListInput{Query: "al", Limit: 1, Cursor: *page.NextCursor})
	if err != nil || f.query.After == nil || f.query.After.ID != tagIDValue {
		t.Fatalf("query=%+v err=%v", f.query, err)
	}
	f.calls = nil
	f.epoch = "10000000-0000-4000-8000-000000000006"
	_, err = New(f).List(context.Background(), principal, projectID, ListInput{Query: "al", Limit: 1, Cursor: *page.NextCursor})
	if faultCode(err) != "catalog_changed" || !reflect.DeepEqual(f.calls, []string{"snapshot", "access", "epoch"}) {
		t.Fatalf("calls=%v err=%v", f.calls, err)
	}
	f.calls = nil
	f.accessErr = model.ErrNotFound
	_, err = New(f).Get(context.Background(), principal, projectID, tagIDValue)
	if faultCode(err) != "not_found" || !reflect.DeepEqual(f.calls, []string{"snapshot", "access"}) {
		t.Fatalf("calls=%v err=%v", f.calls, err)
	}
}
func TestResolveRequiresAllIdsAndBoundedEncoding(t *testing.T) {
	f := &readFixture{resolved: []model.Tag{{ID: tagIDValue, Name: "Alpha"}}}
	result, err := New(f).Resolve(context.Background(), principal, projectID, []string{tagIDValue, tagIDValue})
	if err != nil || len(result) != 1 || result[0].Name != "Alpha" {
		t.Fatalf("%v %v", result, err)
	}
	_, err = New(f).Resolve(context.Background(), principal, projectID, []string{tagIDValue, "10000000-0000-4000-8000-000000000009"})
	if faultCode(err) != "tag_not_found" {
		t.Fatal(err)
	}
	const count = 1400
	ids := make([]string, count)
	f.resolved = make([]model.Tag, count)
	for i := range ids {
		ids[i] = fmt.Sprintf("%08x-0000-4000-8000-000000000001", i+1)
		f.resolved[i] = model.Tag{ID: ids[i], Name: strings.Repeat("&", 64)}
	}
	result, err = New(f).Resolve(context.Background(), principal, projectID, ids)
	if result != nil || faultCode(err) != "resource_limit_exceeded" {
		t.Fatalf("count=%d err=%v", len(result), err)
	}
}

func TestWriteFailuresStopAtTheirBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, stop string
		run        func(*Tags) (WriteResult, error)
	}{
		{"create clock", "time", func(s *Tags) (WriteResult, error) { return s.Create(context.Background(), principal, projectID, "New") }},
		{"create insertion", "insert", func(s *Tags) (WriteResult, error) { return s.Create(context.Background(), principal, projectID, "New") }},
		{"create epoch", "epoch", func(s *Tags) (WriteResult, error) { return s.Create(context.Background(), principal, projectID, "New") }},
		{"rename tag", "tag", func(s *Tags) (WriteResult, error) {
			return s.Rename(context.Background(), principal, projectID, tagIDValue, 7, "New")
		}},
		{"rename count", "usage", func(s *Tags) (WriteResult, error) {
			return s.Rename(context.Background(), principal, projectID, tagIDValue, 7, "New")
		}},
		{"rename update", "update", func(s *Tags) (WriteResult, error) {
			return s.Rename(context.Background(), principal, projectID, tagIDValue, 7, "New")
		}},
		{"rename touch", "touch", func(s *Tags) (WriteResult, error) {
			return s.Rename(context.Background(), principal, projectID, tagIDValue, 7, "New")
		}},
		{"rename epoch", "epoch", func(s *Tags) (WriteResult, error) {
			return s.Rename(context.Background(), principal, projectID, tagIDValue, 7, "New")
		}},
		{"delete tag", "tag", func(s *Tags) (WriteResult, error) {
			return s.Delete(context.Background(), principal, projectID, tagIDValue, 7, true)
		}},
		{"delete clock", "time", func(s *Tags) (WriteResult, error) {
			return s.Delete(context.Background(), principal, projectID, tagIDValue, 7, true)
		}},
		{"delete touch", "touch", func(s *Tags) (WriteResult, error) {
			return s.Delete(context.Background(), principal, projectID, tagIDValue, 7, true)
		}},
		{"delete row", "delete", func(s *Tags) (WriteResult, error) {
			return s.Delete(context.Background(), principal, projectID, tagIDValue, 7, true)
		}},
		{"delete epoch", "epoch", func(s *Tags) (WriteResult, error) {
			return s.Delete(context.Background(), principal, projectID, tagIDValue, 7, true)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture()
			f.stop = tc.stop
			f.errorAt = errors.New("failure")
			result, err := tc.run(New(f))
			if !errors.Is(err, f.errorAt) || result.Outcome != store.TransactionNotCommitted || result.Deleted || result.Item.Tag.ID != "" || f.calls[len(f.calls)-1] != tc.stop {
				t.Fatalf("result=%+v calls=%v err=%v", result, f.calls, err)
			}
		})
	}
}
func TestInputErrorsDoNotStartTransactions(t *testing.T) {
	for _, run := range []func(*Tags) (WriteResult, error){
		func(s *Tags) (WriteResult, error) {
			return s.Create(context.Background(), model.Principal{}, projectID, "ok")
		},
		func(s *Tags) (WriteResult, error) { return s.Create(context.Background(), principal, "bad", "ok") },
		func(s *Tags) (WriteResult, error) { return s.Create(context.Background(), principal, projectID, "") },
		func(s *Tags) (WriteResult, error) {
			return s.Rename(context.Background(), principal, projectID, "bad", 1, "ok")
		},
		func(s *Tags) (WriteResult, error) {
			return s.Rename(context.Background(), principal, projectID, tagIDValue, 0, "ok")
		},
		func(s *Tags) (WriteResult, error) {
			return s.Rename(context.Background(), principal, projectID, tagIDValue, 1, "")
		},
		func(s *Tags) (WriteResult, error) {
			return s.Delete(context.Background(), principal, projectID, "bad", 1, true)
		},
		func(s *Tags) (WriteResult, error) {
			return s.Delete(context.Background(), principal, projectID, tagIDValue, 0, true)
		},
	} {
		f := newFixture()
		result, err := run(New(f))
		if err == nil || len(f.calls) != 0 || result.Outcome != store.TransactionNotCommitted {
			t.Fatalf("result=%+v calls=%v err=%v", result, f.calls, err)
		}
	}
	f := newFixture()
	f.item.Version = math.MaxInt64
	_, err := New(f).Rename(context.Background(), principal, projectID, tagIDValue, math.MaxInt64, "New")
	if faultCode(err) != "version_exhausted" || !reflect.DeepEqual(f.calls, []string{"lock", "access", "tag", "usage"}) {
		t.Fatalf("calls=%v err=%v", f.calls, err)
	}
}
func TestGetReadsTagAndUsage(t *testing.T) {
	f := &readFixture{item: model.Tag{ID: tagIDValue, Name: "Alpha"}}
	item, err := New(f).Get(context.Background(), principal, projectID, tagIDValue)
	if err != nil || item.Tag.Name != "Alpha" || item.Usage.Tasks != 2 || !reflect.DeepEqual(f.calls, []string{"snapshot", "access", "tag", "usage"}) {
		t.Fatalf("item=%+v calls=%v err=%v", item, f.calls, err)
	}
}

func TestNameConflictRetainsDatabaseAndRollbackEvidence(t *testing.T) {
	for _, tc := range []struct {
		name, stop string
		run        func(*Tags) (WriteResult, error)
	}{
		{"create", "insert", func(s *Tags) (WriteResult, error) {
			return s.Create(context.Background(), principal, projectID, "Duplicate")
		}},
		{"rename", "update", func(s *Tags) (WriteResult, error) {
			return s.Rename(context.Background(), principal, projectID, tagIDValue, 7, "Duplicate")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cause := errors.New("unique index")
			f := newFixture()
			f.stop = tc.stop
			f.errorAt = errors.Join(store.ErrTagNameConflict, &store.Error{DatabaseFailure: true, SQLState: "23505", Cause: cause})
			result, err := tc.run(New(f))
			failed, state := store.DatabaseErrorFacts(err)
			var tx *store.TransactionError
			if faultCode(err) != "tag_name_conflict" || !errors.Is(err, cause) || !errors.Is(err, store.ErrTagNameConflict) || !failed || state != "23505" || !errors.As(err, &tx) || tx.Outcome != store.TransactionNotCommitted || tx.CleanupFailed || result.Outcome != store.TransactionNotCommitted || f.calls[len(f.calls)-1] != tc.stop {
				t.Fatalf("result=%+v calls=%v err=%v", result, f.calls, err)
			}
		})
	}
}
