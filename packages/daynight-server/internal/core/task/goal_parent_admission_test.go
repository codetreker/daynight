package task

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type creationParentDAO struct {
	store.TaskWriteDAO
	parent          model.Task
	parentErr       error
	parents         []string
	dependencyCalls int
}

func (d *creationParentDAO) ParentTask(_ context.Context, id string) (model.Task, error) {
	d.parents = append(d.parents, id)
	return d.parent, d.parentErr
}

func (d *creationParentDAO) TasksByID(_ context.Context, _ []string) ([]model.Task, error) {
	d.dependencyCalls++
	return nil, nil
}

func TestCreateCandidateParentAdmissionPrecedesDependencies(t *testing.T) {
	failure := errors.New("parent read failure")
	for _, tc := range []struct {
		name      string
		parent    model.Task
		parentErr error
		wantFault string
		wantErr   error
	}{
		{name: "missing parent", parentErr: model.ErrNotFound, wantFault: "invalid_input"},
		{name: "deleted parent", parentErr: model.ErrTaskDeleted, wantFault: "invalid_input"},
		{name: "ordinary parent", parent: model.Task{Type: model.TaskTypeTask}, wantFault: "invalid_input"},
		{name: "storage failure", parentErr: failure, wantErr: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := &creationParentDAO{parent: tc.parent, parentErr: tc.parentErr}
			_, err := PrepareCreate(t.Context(), dao, childID, store.TaskWrite{Type: model.TaskTypeTask, ParentID: ptr(goalID), DependsOn: []string{childID}})
			if tc.wantFault != "" {
				faultCode(t, err, tc.wantFault)
			} else if !errors.Is(err, tc.wantErr) {
				t.Fatalf("lost parent read error: %v", err)
			}
			if !reflect.DeepEqual(dao.parents, []string{goalID}) || dao.dependencyCalls != 0 {
				t.Fatalf("unexpected calls: parents=%v dependencies=%d", dao.parents, dao.dependencyCalls)
			}
		})
	}

	dao := &creationParentDAO{parent: model.Task{ID: goalID, Type: model.TaskTypeGoal}}
	_, err := PrepareCreate(t.Context(), dao, childID, store.TaskWrite{Type: model.TaskTypeTask, ParentID: ptr(goalID), DependsOn: []string{childID}})
	fault := faultCode(t, err, "invalid_input")
	if !reflect.DeepEqual(fault.TaskIDs, []string{childID}) || !reflect.DeepEqual(dao.parents, []string{goalID}) || dao.dependencyCalls != 1 {
		t.Fatalf("dependency refusal lost after valid parent: fault=%+v parents=%v calls=%d", fault, dao.parents, dao.dependencyCalls)
	}
}
