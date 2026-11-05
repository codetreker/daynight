package steps

import (
	"errors"
	"math"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestMutationAdmissionAndObservedTime(t *testing.T) {
	timestamp := time.Date(2026, 11, 3, 10, 11, 12, 0, time.UTC)
	header := model.TaskHeader{ProjectID: "00000000-0000-4000-8000-000000000001", ID: "00000000-0000-4000-8000-000000000002", Version: 3}
	current := []model.TaskStep{{ID: "abcdef01", Position: 0, Title: "one", Status: model.TaskStepTodo, CreatedAt: timestamp, UpdatedAt: timestamp}}
	step, before, after, err := PrepareAdd("ABCDEF02", "two", "", nil, nil, nil)
	if err != nil || step.ID != "abcdef02" || step.Status != model.TaskStepTodo {
		t.Fatalf("prepare: %+v %v", step, err)
	}
	mutation, err := AdmitAdd(header, current, step, before, after)
	if err != nil {
		t.Fatal(err)
	}
	observed := timestamp.Add(time.Minute)
	resource, _, err := EncodeMutation(header, mutation, observed, "add")
	if err != nil || resource.Version != 4 || len(resource.Steps) != 2 || !mutation.Candidate[1].CreatedAt.Equal(observed) || !mutation.Candidate[0].UpdatedAt.Equal(timestamp) {
		t.Fatalf("add: %+v %v", mutation, err)
	}
	if current[0].UpdatedAt != timestamp {
		t.Fatal("candidate changed existing input")
	}

	header.Version = math.MaxInt64
	title := "one"
	unchanged, err := AdmitChange(header, current, current[0].ID, Changes{Title: &title})
	if err != nil || unchanged.Changed {
		t.Fatalf("same value at version limit: %+v %v", unchanged, err)
	}
	title = "changed"
	_, err = AdmitChange(header, current, current[0].ID, Changes{Title: &title})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_exhausted" {
		t.Fatalf("version admission: %v", err)
	}
	_, err = AdmitDelete(header, current, "00000000")
	var absence *StepAbsence
	if !errors.As(err, &absence) || absence.Version != math.MaxInt64 {
		t.Fatalf("absence: %v", err)
	}
}

func TestPlacementAndCandidateFailures(t *testing.T) {
	before, after := "ABCDEF01", "abcdef02"
	if _, err := CanonicalPlacement(Placement{Before: &before, After: &after}); err == nil {
		t.Fatal("accepted ambiguous placement")
	}
	placement, err := CanonicalPlacement(Placement{Before: &before})
	if err != nil || *placement.Before != "abcdef01" || before != "ABCDEF01" {
		t.Fatalf("placement: %+v %v", placement, err)
	}
	if _, _, _, err := PrepareAdd("abc", "valid", "", nil, nil, nil); err == nil {
		t.Fatal("accepted invalid ID")
	}
	if err := ValidateChanges(Changes{}); err == nil {
		t.Fatal("accepted empty change")
	}
}
