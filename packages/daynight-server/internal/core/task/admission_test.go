package task_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestCandidateSizePolicy(t *testing.T) {
	candidate := store.TaskWrite{Title: "Task", DependsOn: make([]string, 15)}
	if err := task.AdmitCandidate(candidate); err != nil {
		t.Fatal(err)
	}
	candidate.DependsOn = append(candidate.DependsOn, "extra")
	var v *limit.Violation
	if err := task.AdmitCandidate(candidate); !errors.As(err, &v) || v.Field != "dependsOn" || v.Actual != 16 || v.Max != 15 || v.Unit != "items" {
		t.Fatalf("%v", err)
	}
	candidate.DependsOn = nil
	candidate.Title = strings.Repeat("x", 1025)
	if err := task.AdmitCandidate(candidate); !errors.As(err, &v) || v.Field != "title" {
		t.Fatalf("%v", err)
	}
}
