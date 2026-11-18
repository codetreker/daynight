package task

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

type candidateTestStore struct {
	store.ProjectWriter
	run func(context.Context, func(store.SnapshotScope) error) error
}

func (s candidateTestStore) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	return s.run(ctx, run)
}

type candidateTestScope struct {
	store.SnapshotScope
	worker store.WorkerReader
}

func (s candidateTestScope) WorkerDAO() store.WorkerReader         { return s.worker }
func (s candidateTestScope) ProjectDAO() store.ProjectReader       { return nil }
func (s candidateTestScope) TaskDAO() store.TaskReader             { return nil }
func (s candidateTestScope) CredentialDAO() store.CredentialReader { return nil }

type candidateTestWorker struct {
	store.WorkerReader
	read func(context.Context, string, string) (model.WorkerConfigurationResource, error)
}

func (w candidateTestWorker) WorkerConfiguration(ctx context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
	return w.read(ctx, user, worker)
}

func TestCandidateListReadsTargetWithinAuthorizedSelectionSnapshot(t *testing.T) {
	const workerID = "abcdef66-6666-4666-8666-666666666666"
	principal := model.Principal{Kind: model.PATCredential, UserID: listOperationActor, CredentialID: "abcdef77-7777-4777-8777-777777777777"}
	failure := errors.New("worker read failed")
	selected := errors.New("selection reached")
	for _, observed := range []bool{false, true} {
		for _, tc := range []struct {
			name    string
			desired *model.WorkerDesiredConfiguration
			readErr error
			want    *model.TagNameFilter
			fault   string
			wantErr error
		}{
			{name: "uninitialized", want: &model.TagNameFilter{Names: []string{}, Match: "any"}},
			{name: "raw target despite invalid typed projection", desired: &model.WorkerDesiredConfiguration{Raw: json.RawMessage(`{"taskTagFilter":{"names":["Urgent","backend","BACKEND"],"match":"all"},"future":true}`), ValueValid: false}, want: &model.TagNameFilter{Names: []string{"backend", "Urgent"}, Match: "all"}},
			{name: "missing filter", desired: &model.WorkerDesiredConfiguration{Raw: json.RawMessage(`{"future":true}`)}},
			{name: "invalid filter", desired: &model.WorkerDesiredConfiguration{Raw: json.RawMessage(`{"taskTagFilter":{"names":null,"match":"any"}}`)}},
			{name: "unknown worker", readErr: model.ErrNotFound, fault: "not_found"},
			{name: "storage failure", readErr: failure, wantErr: failure},
		} {
			t.Run(tc.name+map[bool]string{true: "/observed", false: "/list"}[observed], func(t *testing.T) {
				ctx := t.Context()
				active, authorized, workerRead, queried := false, false, false, false
				db := candidateTestStore{run: func(actual context.Context, run func(store.SnapshotScope) error) error {
					if actual != ctx || active {
						t.Fatal("wrong snapshot or context")
					}
					active = true
					defer func() { active = false }()
					return run(candidateTestScope{worker: candidateTestWorker{read: func(actual context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
						if !active || !authorized || workerRead || actual != ctx || user != principal.UserID || worker != workerID {
							t.Fatal("worker read escaped authorized snapshot or changed identity")
						}
						workerRead = true
						return model.WorkerConfigurationResource{Desired: tc.desired}, tc.readErr
					}}})
				}}
				checkSelection := func(actual context.Context, project string, selection taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
					if !active || !authorized || !workerRead || actual != ctx || project != listOperationProject || !reflect.DeepEqual(selection.Query.CandidateTagFilter, tc.want) || selection.Scope.CandidateWorkerID == nil || *selection.Scope.CandidateWorkerID != workerID || selection.Scope.CandidateWorkerUserID == nil || *selection.Scope.CandidateWorkerUserID != principal.UserID {
						t.Fatalf("selection changed or escaped snapshot: %#v", selection)
					}
					queried = true
					return store.TaskPage{}, nil, selected
				}
				request := TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, AutomaticCandidate: true, CandidateWorkerID: listOperationPointer(strings.ToUpper(workerID))}
				var err error
				if observed {
					s := NewObservations(db, nil)
					s.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error { return nil }
					s.operations.access = func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error) {
						authorized = true
						return model.ProjectAccess{}, nil
					}
					s.operations.list = func(actual context.Context, _ taskcore.ReadDAO, project string, selection taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
						return checkSelection(actual, project, selection)
					}
					_, err = s.ObserveList(ctx, principal, listOperationProject, request)
				} else {
					s := NewTasks(db)
					s.listOperations.requireProjectRead = func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error) {
						authorized = true
						return model.ProjectAccess{}, nil
					}
					s.listOperations.readList = func(actual context.Context, _ taskcore.ReadDAO, project string, selection taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
						return checkSelection(actual, project, selection)
					}
					_, err = s.List(ctx, principal, listOperationProject, request)
				}
				if active || !authorized || !workerRead || queried != (tc.want != nil) || err == nil {
					t.Fatalf("read outcome: authorized=%v worker=%v queried=%v err=%v", authorized, workerRead, queried, err)
				}
				if tc.want != nil && !errors.Is(err, selected) || tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
					t.Fatalf("lost selected or storage error: %v", err)
				}
				if tc.fault != "" {
					var fault *model.Fault
					if !errors.As(err, &fault) || fault.Code != tc.fault {
						t.Fatalf("missing refusal: %v", err)
					}
				}
			})
		}
	}
}

func TestCandidateListRejectsInvalidRequestBeforeSnapshotAndChangedCursorBeforeQuery(t *testing.T) {
	workerID := listOperationWorker
	principal := model.Principal{Kind: model.PATCredential, UserID: listOperationActor, CredentialID: "abcdef77-7777-4777-8777-777777777777"}
	base := TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, AutomaticCandidate: true, CandidateWorkerID: &workerID}
	for _, request := range []TaskListRequest{
		{PageRequest: model.PageRequest{Limit: 1}, CandidateWorkerID: &workerID},
		{PageRequest: model.PageRequest{Limit: 1}, AutomaticCandidate: true, CandidateWorkerID: &workerID, WorkerID: &workerID},
		{PageRequest: model.PageRequest{Limit: 1}, AutomaticCandidate: true, CandidateWorkerID: listOperationPointer("invalid")},
	} {
		_, err := prepareListSelection(listOperationProject, principal.UserID, request)
		if err == nil {
			t.Fatal("invalid candidate request accepted")
		}
	}
	oldFilter := model.TagNameFilter{Names: []string{"backend"}, Match: "all"}
	input := listSelectionRequest(base)
	input.CandidateTagFilter = &oldFilter
	selection, err := taskcore.SelectList(listOperationProject, principal.UserID, input)
	if err != nil {
		t.Fatal(err)
	}
	cursor, err := query.EncodeListCursor(selection.Scope, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), "abcdef44-4444-4444-8444-444444444444")
	if err != nil {
		t.Fatal(err)
	}
	base.Cursor = &cursor
	scope := candidateTestScope{worker: candidateTestWorker{read: func(context.Context, string, string) (model.WorkerConfigurationResource, error) {
		return model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Raw: json.RawMessage(`{"taskTagFilter":{"names":["backend"],"match":"any"}}`)}}, nil
	}}}
	if _, err := candidateListSelection(t.Context(), scope, principal, listOperationProject, base); err == nil {
		t.Fatal("cursor from different filter semantics accepted")
	}
}

func TestCandidateListPreflightAndAuthorizationStopWorkerRead(t *testing.T) {
	workerID := listOperationWorker
	principal := model.Principal{Kind: model.PATCredential, UserID: listOperationActor, CredentialID: "abcdef77-7777-4777-8777-777777777777"}
	denied := errors.New("project access denied")
	for _, observed := range []bool{false, true} {
		for _, invalid := range []bool{false, true} {
			t.Run(map[bool]string{true: "observed", false: "list"}[observed]+map[bool]string{true: "/invalid", false: "/denied"}[invalid], func(t *testing.T) {
				snapshots, reads := 0, 0
				db := candidateTestStore{run: func(_ context.Context, run func(store.SnapshotScope) error) error {
					snapshots++
					return run(candidateTestScope{worker: candidateTestWorker{read: func(context.Context, string, string) (model.WorkerConfigurationResource, error) {
						reads++
						return model.WorkerConfigurationResource{}, nil
					}}})
				}}
				request := TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, AutomaticCandidate: !invalid, CandidateWorkerID: &workerID}
				var err error
				if observed {
					s := NewObservations(db, nil)
					s.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error { return nil }
					s.operations.access = func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error) {
						return model.ProjectAccess{}, denied
					}
					_, err = s.ObserveList(t.Context(), principal, listOperationProject, request)
				} else {
					s := NewTasks(db)
					s.listOperations.requireProjectRead = func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error) {
						return model.ProjectAccess{}, denied
					}
					_, err = s.List(t.Context(), principal, listOperationProject, request)
				}
				if reads != 0 || snapshots != map[bool]int{true: 0, false: 1}[invalid] || err == nil || !invalid && !errors.Is(err, denied) {
					t.Fatalf("preflight/authorization: snapshots=%d worker reads=%d err=%v", snapshots, reads, err)
				}
			})
		}
	}
}
