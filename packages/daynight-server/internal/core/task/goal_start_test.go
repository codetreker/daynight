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

type parentStartDAO struct {
	store.TaskWriteDAO
	parent            model.Task
	readErr, clockErr error
	now               time.Time
	parentReads       []string
	clockReads        int
}

func (d *parentStartDAO) ParentTask(_ context.Context, id string) (model.Task, error) {
	d.parentReads = append(d.parentReads, id)
	return d.parent, d.readErr
}

func (d *parentStartDAO) ObservedAt(context.Context) (time.Time, error) {
	d.clockReads++
	return d.now, d.clockErr
}

func TestPrepareParentStart(t *testing.T) {
	now := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	goal := model.Task{ID: goalID, Type: model.TaskTypeGoal, Status: model.TaskTodo, Title: "Goal", Description: "Keep this", Version: 7, Properties: model.TaskProperties{}}
	child := model.Task{ID: childID, Type: model.TaskTypeTask, Status: model.TaskTodo, ParentID: ptr(goalID)}
	starting := Mutation{ID: childID, Current: child, Values: CurrentWrite(child), Changed: true}
	starting.Values.Status = model.TaskInProgress

	for _, from := range []model.TaskStatus{model.TaskProposed, model.TaskTodo, model.TaskDone} {
		t.Run("start from "+string(from), func(t *testing.T) {
			mutation := starting
			mutation.Current.Status = from
			dao := &parentStartDAO{parent: goal, now: now}
			got, err := PrepareParentStart(t.Context(), dao, mutation)
			if err != nil {
				t.Fatal(err)
			}
			wantValues := CurrentWrite(goal)
			wantValues.Status = model.TaskInProgress
			wantValues.GoalTiming = &store.GoalTiming{ObservedAt: now, StartedAt: &now}
			want := Mutation{ID: goalID, Current: goal, Values: wantValues, Changed: true}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("got %+v, want %+v", got, want)
			}
			if !reflect.DeepEqual(dao.parentReads, []string{goalID}) || dao.clockReads != 1 {
				t.Fatalf("parent reads=%v clock reads=%d", dao.parentReads, dao.clockReads)
			}
		})
	}

	for _, state := range []model.TaskStatus{model.TaskInProgress, model.TaskDone, model.TaskCancelled} {
		t.Run("parent "+string(state), func(t *testing.T) {
			parent := goal
			parent.Status = state
			dao := &parentStartDAO{parent: parent, now: now}
			got, err := PrepareParentStart(t.Context(), dao, starting)
			if err != nil || got.Changed {
				t.Fatalf("candidate=%+v err=%v", got, err)
			}
			if !reflect.DeepEqual(dao.parentReads, []string{goalID}) || dao.clockReads != 0 {
				t.Fatalf("parent reads=%v clock reads=%d", dao.parentReads, dao.clockReads)
			}
		})
	}

	tests := []struct {
		name string
		edit func(*Mutation)
	}{
		{"independent task", func(m *Mutation) { m.Current.ParentID = nil; m.Values.ParentID = nil }},
		{"create", func(m *Mutation) { m.Create = true }},
		{"delete", func(m *Mutation) { m.Delete = true }},
		{"unchanged", func(m *Mutation) { m.Changed = false }},
		{"already in progress", func(m *Mutation) { m.Current.Status = model.TaskInProgress }},
		{"edit in progress", func(m *Mutation) { m.Current.Status = model.TaskInProgress; m.Values.Title = "Edited" }},
		{"move in progress", func(m *Mutation) { m.Current.Status = model.TaskInProgress; m.Current.ParentID = nil }},
		{"leave in progress", func(m *Mutation) { m.Current.Status = model.TaskInProgress; m.Values.Status = model.TaskDone }},
		{"goal", func(m *Mutation) { m.Current.Type = model.TaskTypeGoal }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mutation := starting
			tc.edit(&mutation)
			dao := &parentStartDAO{parent: goal, now: now}
			got, err := PrepareParentStart(t.Context(), dao, mutation)
			if err != nil || got.Changed {
				t.Fatalf("candidate=%+v err=%v", got, err)
			}
			if len(dao.parentReads) != 0 || dao.clockReads != 0 {
				t.Fatalf("unexpected reads: parent=%v clock=%d", dao.parentReads, dao.clockReads)
			}
		})
	}
}

func TestPrepareParentStartPropagatesFailures(t *testing.T) {
	boom := errors.New("storage failure")
	child := model.Task{ID: childID, Type: model.TaskTypeTask, Status: model.TaskTodo, ParentID: ptr(goalID)}
	mutation := Mutation{ID: childID, Current: child, Values: CurrentWrite(child), Changed: true}
	mutation.Values.Status = model.TaskInProgress
	goal := model.Task{ID: goalID, Type: model.TaskTypeGoal, Status: model.TaskTodo, Properties: model.TaskProperties{}}
	for _, tc := range []struct {
		name       string
		dao        *parentStartDAO
		clockReads int
	}{
		{"parent read", &parentStartDAO{readErr: boom}, 0},
		{"clock read", &parentStartDAO{parent: goal, clockErr: boom}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := PrepareParentStart(t.Context(), tc.dao, mutation)
			if !errors.Is(err, boom) || got.Changed {
				t.Fatalf("candidate=%+v err=%v", got, err)
			}
			if !reflect.DeepEqual(tc.dao.parentReads, []string{goalID}) || tc.dao.clockReads != tc.clockReads {
				t.Fatalf("parent reads=%v clock reads=%d", tc.dao.parentReads, tc.dao.clockReads)
			}
		})
	}
}
