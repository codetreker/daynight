package task

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type observationReader struct {
	store.TaskReader
	task      model.Task
	taskErr   error
	epochErr  error
	epochRead *bool
}

func (r observationReader) Task(context.Context, string, string) (model.Task, error) {
	return r.task, r.taskErr
}
func (r observationReader) TaskCacheEpoch(context.Context, string) (string, error) {
	*r.epochRead = true
	return "55555555-5555-4555-8555-555555555555", r.epochErr
}

type observationSnapshot struct {
	store.SnapshotScope
	project graphProjectReader
	task    observationReader
}

func (s observationSnapshot) ProjectDAO() store.ProjectReader { return s.project }
func (s observationSnapshot) TaskDAO() store.TaskReader       { return s.task }

type observationStore struct {
	store.ProjectWriter
	snapshot      observationSnapshot
	completionErr error
}

func (s observationStore) ReadSnapshot(_ context.Context, callback func(store.SnapshotScope) error) error {
	if err := callback(s.snapshot); err != nil {
		return err
	}
	return s.completionErr
}

func TestTaskObservationPublishesOnlyCompleteAuthorizedSnapshot(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	projectID, taskID := "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"
	storage := errors.New("epoch failure")
	completion := errors.New("snapshot completion failure")
	for _, test := range []struct {
		name                    string
		accessErr, taskErr      error
		epochErr, completionErr error
		wantErr                 error
		wantFault               string
		wantEpochRead           bool
	}{
		{name: "success", wantEpochRead: true},
		{name: "access denied", accessErr: model.ErrNotFound, wantFault: "not_found"},
		{name: "missing task", taskErr: model.ErrNotFound, wantFault: "not_found"},
		{name: "deleted task", taskErr: model.ErrTaskDeleted, wantFault: "task_deleted"},
		{name: "epoch failure", epochErr: storage, wantErr: storage, wantEpochRead: true},
		{name: "completion failure", completionErr: completion, wantErr: completion, wantEpochRead: true},
		{name: "completion dominates refusal", taskErr: model.ErrNotFound, completionErr: completion, wantErr: completion},
	} {
		t.Run(test.name, func(t *testing.T) {
			epochRead := false
			reader := observationReader{task: model.Task{ID: taskID, ProjectID: projectID}, taskErr: test.taskErr, epochErr: test.epochErr, epochRead: &epochRead}
			tasks := NewTasks(observationStore{snapshot: observationSnapshot{project: graphProjectReader{accessErr: test.accessErr}, task: reader}, completionErr: test.completionErr})
			got, err := tasks.Observe(context.Background(), principal, projectID, taskID)
			if epochRead != test.wantEpochRead {
				t.Fatalf("epoch read = %t", epochRead)
			}
			if test.wantErr != nil && !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v", err)
			}
			if test.wantFault != "" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != test.wantFault {
					t.Fatalf("fault = %v", err)
				}
			}
			if test.wantErr != nil || test.wantFault != "" {
				if !reflect.DeepEqual(got, TaskObservation{}) {
					t.Fatalf("published partial snapshot: %#v", got)
				}
			} else if err != nil || got.Task.ID != taskID || got.Epoch != "55555555-5555-4555-8555-555555555555" {
				t.Fatalf("observation = %#v, %v", got, err)
			}
		})
	}
}

func TestTaskGetForOtherResourcesDoesNotRequireEpoch(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	projectID, taskID := "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"
	epochRead := false
	reader := observationReader{task: model.Task{ID: taskID}, epochErr: errors.New("unavailable"), epochRead: &epochRead}
	tasks := NewTasks(observationStore{snapshot: observationSnapshot{task: reader}})
	got, err := tasks.Get(context.Background(), principal, projectID, taskID)
	if err != nil || got.ID != taskID || epochRead {
		t.Fatalf("unrelated read changed: %#v, %v, epoch read %t", got, err, epochRead)
	}
}
