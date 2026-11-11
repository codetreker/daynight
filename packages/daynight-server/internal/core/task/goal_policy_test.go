package task

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const goalID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const childID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

type goalPolicyDAO struct {
	taskDAO
	rows        map[string]model.Task
	readErr     error
	clockErr    error
	now         time.Time
	clockReads  int
	lockedReads []string
	parentReads []string
}

func (d *goalPolicyDAO) Task(_ context.Context, id string) (model.Task, error) {
	d.lockedReads = append(d.lockedReads, id)
	return d.read(id)
}
func (d *goalPolicyDAO) read(id string) (model.Task, error) {
	if d.readErr != nil {
		return model.Task{}, d.readErr
	}
	if row, ok := d.rows[id]; ok {
		return row, nil
	}
	return model.Task{}, model.ErrNotFound
}
func (d *goalPolicyDAO) ParentTask(_ context.Context, id string) (model.Task, error) {
	d.parentReads = append(d.parentReads, id)
	return d.read(id)
}
func (d *goalPolicyDAO) ObservedAt(context.Context) (time.Time, error) {
	d.clockReads++
	return d.now, d.clockErr
}

func TestGoalCreationPolicy(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, state := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone, model.TaskCancelled} {
		t.Run(string(state), func(t *testing.T) {
			input := CreateTask{Type: model.TaskTypeGoal, Title: "Goal", Status: &state}
			v, err := CreateCandidate(goalID, input)
			if err != nil {
				t.Fatal(err)
			}
			dao := &goalPolicyDAO{now: now}
			m, err := PrepareCreate(t.Context(), dao, goalID, v)
			if err != nil || m.Values.Type != model.TaskTypeGoal || m.Values.Status != state {
				t.Fatalf("candidate=%+v err=%v", m, err)
			}
			want := &store.GoalTiming{ObservedAt: now}
			switch state {
			case model.TaskInProgress:
				want.StartedAt = &now
			case model.TaskDone:
				want.CompletedAt = &now
			case model.TaskCancelled:
				want.CancelledAt = &now
			}
			if !reflect.DeepEqual(m.Values.GoalTiming, want) {
				t.Fatalf("got %+v want %+v", m.Values.GoalTiming, want)
			}
		})
	}
	v, err := CreateCandidate(goalID, CreateTask{Type: model.TaskTypeGoal, Title: "Goal"})
	if err != nil || v.Status != model.TaskTodo {
		t.Fatalf("default=%+v %v", v, err)
	}
	v, err = CreateCandidate(childID, CreateTask{Title: "Task"})
	if err != nil || v.Type != model.TaskTypeTask || v.Status != model.TaskProposed {
		t.Fatalf("ordinary=%+v %v", v, err)
	}
	for _, in := range []CreateTask{
		{Type: "other", Title: "Goal"}, {Type: model.TaskTypeGoal, Title: "Goal", Status: ptr(model.TaskProposed)},
		{Type: model.TaskTypeGoal, Title: "Goal", ParentID: ptr(goalID)},
		{Type: model.TaskTypeGoal, Title: "Goal", DependsOn: []string{childID}},
		{Type: model.TaskTypeGoal, Title: "Goal", RequiredPlatformPresent: true},
		{Type: model.TaskTypeGoal, Title: "Goal", Properties: model.TaskProperties{"paused": []byte("false")}},
	} {
		if _, err := CreateCandidate(goalID, in); err == nil {
			t.Fatalf("accepted %+v", in)
		}
	}
}

func TestGoalStatusTransitionsAndTiming(t *testing.T) {
	now := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	started := now.Add(-time.Hour)
	states := []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone, model.TaskCancelled}
	for _, from := range states {
		for _, to := range states {
			t.Run(string(from)+"_to_"+string(to), func(t *testing.T) {
				dao := &goalPolicyDAO{now: now}
				current := model.Task{Type: model.TaskTypeGoal, Status: from, StartedAt: &started, Properties: model.TaskProperties{}}
				v, changed, err := StatusCandidate(t.Context(), dao, model.Principal{}, current, SetTaskStatus{Status: to}, nil)
				if err != nil || changed != (from != to) {
					t.Fatalf("changed=%v err=%v", changed, err)
				}
				if from == to {
					if dao.clockReads != 0 {
						t.Fatal("noop read clock")
					}
					return
				}
				want := &store.GoalTiming{ObservedAt: now, StartedAt: &started}
				switch to {
				case model.TaskTodo:
					want.StartedAt = nil
				case model.TaskInProgress:
					want.StartedAt = &now
				case model.TaskDone:
					want.CompletedAt = &now
				case model.TaskCancelled:
					want.CancelledAt = &now
				}
				if v.Status != to || !reflect.DeepEqual(v.GoalTiming, want) || dao.clockReads != 1 {
					t.Fatalf("candidate=%+v want=%+v", v, want)
				}
			})
		}
	}
	goal := model.Task{Type: model.TaskTypeGoal, Status: model.TaskDone}
	_, _, err := StatusCandidate(t.Context(), nil, model.Principal{}, goal, SetTaskStatus{Status: model.TaskProposed}, nil)
	faultCode(t, err, "invalid_input")
	_, _, err = StatusCandidate(t.Context(), nil, model.Principal{}, goal, SetTaskStatus{Status: model.TaskDone, ClaimID: ptr(childID)}, nil)
	faultCode(t, err, "invalid_input")
	boom := errors.New("clock")
	_, _, err = StatusCandidate(t.Context(), &goalPolicyDAO{clockErr: boom}, model.Principal{}, goal, SetTaskStatus{Status: model.TaskTodo}, nil)
	if !errors.Is(err, boom) {
		t.Fatalf("clock error: %v", err)
	}
}

func TestGoalCapabilitiesAndParent(t *testing.T) {
	goal := model.Task{ID: goalID, Type: model.TaskTypeGoal, Title: "Goal", Status: model.TaskInProgress, Version: 2, Properties: model.TaskProperties{}}
	for _, in := range []UpdateTask{{ParentID: ptr(ptr(childID))}, {DependsOn: ptr([]string{})}, {AllowAgents: ptr(false)}, {RequiredPlatform: ptr[*model.TaskPlatform](nil)}, {Properties: model.TaskPropertiesPatch{"paused": []byte("false")}}} {
		if _, err := UpdateCandidate(goal, in); err == nil {
			t.Fatalf("accepted %+v", in)
		}
	}
	if err := CheckStepsForType(goal.Type); err == nil {
		t.Fatal("Goal steps accepted")
	}
	if err := CheckPropertyForType(goal.Type, "paused"); err == nil {
		t.Fatal("Goal paused accepted")
	}
	if err := CheckPropertyForType(goal.Type, "pullRequests"); err != nil {
		t.Fatal(err)
	}
	v := CurrentWrite(goal)
	v.AssignedTo = ptr(childID)
	v, changed, err := AssignmentCandidate(goal, v)
	if err != nil || !changed || v.AllowAgents {
		t.Fatalf("Goal assignment: %+v %v", v, err)
	}
	if err := ValidateDelete(t.Context(), nil, goal, false); err != nil {
		t.Fatal(err)
	}
	faultCode(t, ValidateDelete(t.Context(), nil, goal, true), "invalid_input")
	faultCode(t, WorkerReady(goal), "invalid_input")
	_, err = ActiveWorker(goal, childID)
	faultCode(t, err, "invalid_input")
	_, err = WithdrawableWorker(goal, childID)
	faultCode(t, err, "invalid_input")

	dao := &goalPolicyDAO{rows: map[string]model.Task{goalID: goal, childID: {ID: childID, Type: model.TaskTypeTask, Title: "Child", Version: 3, Status: model.TaskTodo, Properties: model.TaskProperties{}}}}
	if err := ValidateParent(t.Context(), dao, ptr(goalID)); err != nil {
		t.Fatal(err)
	}
	faultCode(t, ValidateParent(t.Context(), dao, ptr(childID)), "invalid_input")
	faultCode(t, ValidateParent(t.Context(), dao, ptr("cccccccc-cccc-4ccc-8ccc-cccccccccccc")), "invalid_input")
	dao.readErr = model.ErrTaskDeleted
	faultCode(t, ValidateParent(t.Context(), dao, ptr(goalID)), "invalid_input")
	dao.readErr = nil
	dao.lockedReads, dao.parentReads = nil, nil
	m, err := PrepareUpdate(t.Context(), dao, childID, UpdateTask{Version: 3, ParentID: ptr(ptr(goalID))})
	if err != nil || !m.Changed || *m.Values.ParentID != goalID {
		t.Fatalf("assign: %+v %v", m, err)
	}
	if !reflect.DeepEqual(dao.lockedReads, []string{childID}) || !reflect.DeepEqual(dao.parentReads, []string{goalID}) {
		t.Fatalf("expected target lock and unlocked parent read, got locked=%v parent=%v", dao.lockedReads, dao.parentReads)
	}
	dao.lockedReads, dao.parentReads = nil, nil
	_, err = PrepareUpdate(t.Context(), dao, childID, UpdateTask{Version: 2, ParentID: ptr(ptr(goalID))})
	faultCode(t, err, "version_conflict")
	if len(dao.parentReads) != 0 {
		t.Fatal("stale version read parent")
	}
	dao.lockedReads, dao.parentReads = nil, nil
	for _, state := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone, model.TaskCancelled} {
		goal.Status = state
		dao.rows[goalID] = goal
		err := ClaimParentAdmission(t.Context(), dao, model.Task{ParentID: ptr(goalID)})
		if state.IsTerminal() {
			faultCode(t, err, "invalid_transition")
		} else if err != nil {
			t.Fatal(err)
		}
	}
	if len(dao.lockedReads) != 0 || !reflect.DeepEqual(dao.parentReads, []string{goalID, goalID, goalID, goalID}) {
		t.Fatalf("claim used wrong parent read: locked=%v parent=%v", dao.lockedReads, dao.parentReads)
	}
	if err := ClaimParentAdmission(t.Context(), nil, model.Task{}); err != nil {
		t.Fatal(err)
	}
}
