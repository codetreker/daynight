package tasksteps

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestChangeCandidatePreservesOmittedValuesAndCurrentRows(t *testing.T) {
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	current := []core.TaskStep{{ID: "00000000", Position: 0, Title: "same", Description: "original", Status: core.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}, {ID: "abcdef01", Position: 1, Title: "same", Description: "other", Status: core.TaskStepDone, CreatedAt: stamp, UpdatedAt: stamp}}
	original := append([]core.TaskStep{}, current...)
	title, description, status := "  <原值&> 😀 \uFEFF  ", "  # Markdown\n\"\\\u2028\u2029  ", core.TaskStepInProgress
	for _, tc := range []struct {
		name    string
		changes Changes
		want    core.TaskStep
		changed bool
	}{
		{"title", Changes{Title: &title}, core.TaskStep{Title: title, Description: "original", Status: core.TaskStepTodo}, true},
		{"description", Changes{Description: &description}, core.TaskStep{Title: "same", Description: description, Status: core.TaskStepTodo}, true},
		{"paired", Changes{Title: &title, Description: &description}, core.TaskStep{Title: title, Description: description, Status: core.TaskStepTodo}, true},
		{"clear", Changes{Description: new("")}, core.TaskStep{Title: "same", Description: "", Status: core.TaskStepTodo}, true},
		{"status", Changes{Status: &status}, core.TaskStep{Title: "same", Description: "original", Status: status}, true},
		{"same title", Changes{Title: new("same")}, core.TaskStep{Title: "same", Description: "original", Status: core.TaskStepTodo}, false},
		{"same description", Changes{Description: new("original")}, core.TaskStep{Title: "same", Description: "original", Status: core.TaskStepTodo}, false},
		{"same state", Changes{Status: new(core.TaskStepTodo)}, core.TaskStep{Title: "same", Description: "original", Status: core.TaskStepTodo}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate, index, changed, err := ChangeCandidate(current, "00000000", tc.changes)
			if err != nil || index != 0 || changed != tc.changed {
				t.Fatalf("candidate result: %d %t %v", index, changed, err)
			}
			expected := current[0]
			expected.Title, expected.Description, expected.Status = tc.want.Title, tc.want.Description, tc.want.Status
			if candidate[0] != expected || candidate[1] != current[1] || !reflect.DeepEqual(current, original) {
				t.Fatal("change altered omitted values, identity, order, time or source rows")
			}
			candidate[0].Title = "mutated copy"
			if !reflect.DeepEqual(current, original) {
				t.Fatal("candidate shares mutable row storage")
			}
		})
	}
	if _, _, _, err := ChangeCandidate(current, "ffffffff", Changes{Title: &title}); !errors.Is(err, ErrTargetNotFound) {
		t.Fatal("missing task-local target accepted")
	}
}
