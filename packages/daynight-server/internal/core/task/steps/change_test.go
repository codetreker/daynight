package steps

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestChangeCandidatePreservesOmittedValuesAndCurrentRows(t *testing.T) {
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	current := []model.TaskStep{{ID: "00000000", Position: 0, Title: "same", Description: "original", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}, {ID: "abcdef01", Position: 1, Title: "same", Description: "other", Status: model.TaskStepDone, CreatedAt: stamp, UpdatedAt: stamp}}
	original := append([]model.TaskStep{}, current...)
	title, description, status := "  <原值&> 😀 \uFEFF  ", "  # Markdown\n\"\\\u2028\u2029  ", model.TaskStepInProgress
	for _, tc := range []struct {
		name    string
		changes Changes
		want    model.TaskStep
		changed bool
	}{
		{"title", Changes{Title: &title}, model.TaskStep{Title: title, Description: "original", Status: model.TaskStepTodo}, true},
		{"description", Changes{Description: &description}, model.TaskStep{Title: "same", Description: description, Status: model.TaskStepTodo}, true},
		{"paired", Changes{Title: &title, Description: &description}, model.TaskStep{Title: title, Description: description, Status: model.TaskStepTodo}, true},
		{"clear", Changes{Description: new("")}, model.TaskStep{Title: "same", Description: "", Status: model.TaskStepTodo}, true},
		{"status", Changes{Status: &status}, model.TaskStep{Title: "same", Description: "original", Status: status}, true},
		{"same title", Changes{Title: new("same")}, model.TaskStep{Title: "same", Description: "original", Status: model.TaskStepTodo}, false},
		{"same description", Changes{Description: new("original")}, model.TaskStep{Title: "same", Description: "original", Status: model.TaskStepTodo}, false},
		{"same state", Changes{Status: new(model.TaskStepTodo)}, model.TaskStep{Title: "same", Description: "original", Status: model.TaskStepTodo}, false},
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
