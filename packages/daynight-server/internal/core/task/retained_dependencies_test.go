package task

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type retainedDependencyDAO struct {
	store.TaskWriteDAO
	current         model.Task
	facts           []model.Task
	visible         []string
	visibilityErr   error
	visibilityCalls [][]string
}

func (d *retainedDependencyDAO) Task(context.Context, string) (model.Task, error) {
	return d.current, nil
}
func (d *retainedDependencyDAO) TasksByID(context.Context, []string) ([]model.Task, error) {
	return d.facts, nil
}
func (d *retainedDependencyDAO) VisibleTaskIDs(_ context.Context, ids []string) ([]string, error) {
	d.visibilityCalls = append(d.visibilityCalls, append([]string(nil), ids...))
	return d.visible, d.visibilityErr
}
func (d *retainedDependencyDAO) Reachable(context.Context, string, string, store.DependencyReplacement) (bool, error) {
	return false, nil
}

func TestDependencyAdmissionPreservesRetainedAndChecksOnlyAdded(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	const retained = "00000000-0000-4000-8000-000000000002"
	const added = "00000000-0000-4000-8000-000000000003"
	current := model.Task{ID: id, Title: "task", Status: model.TaskTodo, Version: 1, Properties: model.TaskProperties{}, DependsOn: []string{retained}}
	dao := &retainedDependencyDAO{current: current, facts: []model.Task{{ID: retained, Status: model.TaskDone}, {ID: added, Status: model.TaskDone}}}
	title := "renamed"
	if _, err := PrepareUpdate(t.Context(), dao, id, UpdateTask{Version: 1, Title: &title}); err != nil {
		t.Fatalf("unchanged hidden prerequisite: %v", err)
	}
	if len(dao.visibilityCalls) != 0 {
		t.Fatalf("unchanged target queried: %v", dao.visibilityCalls)
	}
	dependencies := []string{retained, added}
	_, err := PrepareUpdate(t.Context(), dao, id, UpdateTask{Version: 1, DependsOn: &dependencies})
	fault := faultCode(t, err, "invalid_input")
	if !reflect.DeepEqual(fault.TaskIDs, []string{added}) || !reflect.DeepEqual(dao.visibilityCalls, [][]string{{added}}) {
		t.Fatalf("new hidden target: %+v calls %v", fault, dao.visibilityCalls)
	}
	dao.visible = []string{added}
	if _, err := PrepareUpdate(t.Context(), dao, id, UpdateTask{Version: 1, DependsOn: &dependencies}); err != nil {
		t.Fatalf("visible new target: %v", err)
	}
	failure := errors.New("visibility failure")
	dao.visibilityErr = failure
	if _, err := PrepareUpdate(t.Context(), dao, id, UpdateTask{Version: 1, DependsOn: &dependencies}); !errors.Is(err, failure) {
		t.Fatalf("visibility error lost: %v", err)
	}
	dao.visibilityErr = nil
	dao.visible = nil
	_, err = PrepareCreate(t.Context(), dao, id, store.TaskWrite{DependsOn: []string{retained}})
	if faultCode(t, err, "invalid_input").TaskIDs[0] != retained {
		t.Fatalf("create accepted hidden prerequisite: %v", err)
	}
}
