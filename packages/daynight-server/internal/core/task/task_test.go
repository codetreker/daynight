package task

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type taskDAO struct {
	store.TaskWriteDAO
	tasks      []model.Task
	cycles     map[string]bool
	active     []string
	dependents []string
}

func (d taskDAO) TasksByID(context.Context, []string) ([]model.Task, error) { return d.tasks, nil }
func (d taskDAO) Reachable(_ context.Context, from, _ string, _ store.DependencyReplacement) (bool, error) {
	return d.cycles[from], nil
}
func (d taskDAO) ActiveDependentIDs(context.Context, string) ([]string, error) { return d.active, nil }
func (d taskDAO) DependentIDs(context.Context, string) ([]string, error)       { return d.dependents, nil }

func faultCode(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("got %v; want fault %q", err, code)
	}
	return fault
}

func TestCandidateDependencyRules(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	const one = "00000000-0000-4000-8000-000000000002"
	const two = "00000000-0000-4000-8000-000000000003"
	_, err := CreateCandidate(id, CreateTask{Title: "Task", DependsOn: []string{one, one}})
	faultCode(t, err, "invalid_input")
	_, err = CreateCandidate(id, CreateTask{Title: "Task", DependsOn: []string{id}})
	faultCode(t, err, "invalid_input")
	_, err = CreateCandidate(id, CreateTask{Title: "Task", DependsOn: []string{one}, ExternalDependsOn: []string{two}})
	faultCode(t, err, "invalid_input")
	current := model.Task{ID: id, Title: "Task", Status: model.TaskTodo, DependsOn: []string{one, two}, ExternalDependsOn: []string{one, two}, Properties: model.TaskProperties{}}
	deps := []string{two}
	values, err := UpdateCandidate(current, UpdateTask{DependsOn: &deps})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values.ExternalDependsOn, []string{two}) {
		t.Fatalf("external dependencies: %v", values.ExternalDependsOn)
	}

	dao := taskDAO{tasks: []model.Task{{ID: one, Status: model.TaskDone}}}
	fault := faultCode(t, ValidateCandidate(context.Background(), dao, id, store.TaskWrite{DependsOn: []string{one, two}}), "invalid_input")
	if !reflect.DeepEqual(fault.TaskIDs, []string{two}) {
		t.Fatalf("missing dependencies: %v", fault.TaskIDs)
	}
	dao.tasks = append(dao.tasks, model.Task{ID: two, Status: model.TaskTodo})
	dao.cycles = map[string]bool{one: true}
	faultCode(t, ValidateCandidate(context.Background(), dao, id, store.TaskWrite{DependsOn: []string{one, two}}), "dependency_cycle")
	dao.cycles = nil
	faultCode(t, ValidateCandidate(context.Background(), dao, id, store.TaskWrite{Status: model.TaskInProgress, DependsOn: []string{one, two}}), "dependency_unsatisfied")
}

func TestStatusCandidateHonorsNoopAndReopenProtection(t *testing.T) {
	current := model.Task{ID: "task", Status: model.TaskDone, Properties: model.TaskProperties{}}
	dao := taskDAO{active: []string{"dependent"}}
	_, changed, err := StatusCandidate(context.Background(), dao, model.Principal{}, current, SetTaskStatus{Status: model.TaskDone}, nil)
	if err != nil || changed {
		t.Fatalf("same-status operation: changed=%v err=%v", changed, err)
	}
	_, _, err = StatusCandidate(context.Background(), dao, model.Principal{}, current, SetTaskStatus{Status: model.TaskTodo}, nil)
	faultCode(t, err, "dependency_unsatisfied")
}

func TestAssignmentTransition(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	current := model.Task{Status: model.TaskInProgress, AssignedTo: &id}
	changed, err := AssignmentChanged(current, store.TaskWrite{AssignedTo: &id})
	if changed || err != nil {
		t.Fatalf("same assignee: changed=%v err=%v", changed, err)
	}
	_, err = AssignmentChanged(current, store.TaskWrite{})
	faultCode(t, err, "invalid_transition")
}

type canceledDAO struct{ store.TaskWriteDAO }

func (canceledDAO) TasksByID(ctx context.Context, _ []string) ([]model.Task, error) {
	return nil, ctx.Err()
}

func TestCandidatePropagatesCanceledRead(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := ValidateCandidate(ctx, canceledDAO{}, "id", store.TaskWrite{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v; want context cancellation", err)
	}
}
