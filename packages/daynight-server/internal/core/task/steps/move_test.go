package steps

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestMoveCandidatePreservesRecordsAndResolvesFinalOrder(t *testing.T) {
	ids := []string{"00000000", "11111111", "abcdef01", "fedcba98"}
	current := make([]model.TaskStep, len(ids))
	for index, id := range ids {
		stamp := time.Date(2026, 1, index+1, 2, 3, 4, index*1000, time.UTC)
		current[index] = model.TaskStep{ID: id, Position: int64(index), Title: "same", Description: id + "\n<原值&>", Status: []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}[index], CreatedAt: stamp, UpdatedAt: stamp.Add(time.Hour)}
	}
	original := append([]model.TaskStep{}, current...)
	for _, tc := range []struct {
		name, target string
		placement    Placement
		order        []int
		from, to     int
	}{
		{"forward after", ids[0], Placement{After: &ids[2]}, []int{1, 2, 0, 3}, 0, 2},
		{"backward before", ids[3], Placement{Before: &ids[1]}, []int{0, 3, 1, 2}, 3, 1},
		{"forward before", ids[0], Placement{Before: &ids[3]}, []int{1, 2, 0, 3}, 0, 2},
		{"backward after", ids[3], Placement{After: &ids[0]}, []int{0, 3, 1, 2}, 3, 1},
		{"first", ids[2], Placement{Position: new("first")}, []int{2, 0, 1, 3}, 2, 0},
		{"last", ids[1], Placement{Position: new("last")}, []int{0, 2, 3, 1}, 1, 3},
		{"first already", ids[0], Placement{Position: new("first")}, []int{0, 1, 2, 3}, 0, 0},
		{"last already", ids[3], Placement{Position: new("last")}, []int{0, 1, 2, 3}, 3, 3},
		{"adjacent before", ids[1], Placement{Before: &ids[2]}, []int{0, 1, 2, 3}, 1, 1},
		{"adjacent after", ids[2], Placement{After: &ids[1]}, []int{0, 1, 2, 3}, 2, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate, from, to, err := MoveCandidate(current, tc.target, tc.placement)
			if err != nil || from != tc.from || to != tc.to || len(candidate) != len(current) {
				t.Fatalf("move indices: %d %d %v", from, to, err)
			}
			for index, source := range tc.order {
				expected := current[source]
				expected.Position = int64(index)
				if candidate[index] != expected {
					t.Fatalf("move altered a record at %d: %+v", index, candidate[index])
				}
			}
			if !reflect.DeepEqual(current, original) {
				t.Fatal("candidate changed source collection")
			}
			candidate[0].Title = "mutated copy"
			if !reflect.DeepEqual(current, original) {
				t.Fatal("candidate shares mutable row storage")
			}
		})
	}
	for _, position := range []string{"first", "last"} {
		candidate, from, to, err := MoveCandidate(current[:1], ids[0], Placement{Position: &position})
		if err != nil || from != 0 || to != 0 || !reflect.DeepEqual(candidate, current[:1]) {
			t.Fatal("singleton move changed identity/time or index")
		}
	}
}

func TestMoveCandidateTargetPrecedesSelfAndAnchorChecks(t *testing.T) {
	current := []model.TaskStep{{ID: "00000000", Position: 0}, {ID: "abcdef01", Position: 1}}
	for _, tc := range []struct {
		rows      []model.TaskStep
		target    string
		placement Placement
		cause     error
	}{
		{nil, "ffffffff", Placement{Position: new("first")}, ErrTargetNotFound},
		{current, "ffffffff", Placement{Before: new("ffffffff")}, ErrTargetNotFound},
		{current, "00000000", Placement{Before: new("00000000")}, ErrSelfAnchor},
		{current, "00000000", Placement{After: new("00000000")}, ErrSelfAnchor},
		{current, "00000000", Placement{Before: new("ffffffff")}, ErrAnchorNotFound},
		{current, "00000000", Placement{After: new("ffffffff")}, ErrAnchorNotFound},
	} {
		if _, _, _, err := MoveCandidate(tc.rows, tc.target, tc.placement); !errors.Is(err, tc.cause) {
			t.Fatalf("wrong local identity error: %v", err)
		}
	}
}
