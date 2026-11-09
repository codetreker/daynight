package steps

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
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

func TestMutationTextAdmission(t *testing.T) {
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 0, time.UTC)
	header := model.TaskHeader{ProjectID: "00000000-0000-4000-8000-000000000001", ID: "00000000-0000-4000-8000-000000000002", Version: 3}
	current := []model.TaskStep{{ID: "00000001", Title: "one", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}}
	for _, tc := range []struct{ title, description, field string }{
		{strings.Repeat("é", 512), strings.Repeat("界", 21845) + "x", ""},
		{strings.Repeat("é", 512) + "x", "", "title"},
		{"valid", strings.Repeat("\\", 65537), "description"},
	} {
		step := model.TaskStep{ID: "00000002", Title: tc.title, Description: tc.description, Status: model.TaskStepTodo}
		_, addErr := AdmitAdd(header, current, step, nil, nil)
		_, changeErr := AdmitChange(header, current, current[0].ID, Changes{Title: &tc.title, Description: &tc.description})
		for _, err := range []error{addErr, changeErr} {
			if tc.field == "" {
				if err != nil {
					t.Fatalf("boundary: %v", err)
				}
				continue
			}
			var fault *model.Fault
			var violation *limit.Violation
			if !errors.As(err, &fault) || fault.Code != "invalid_input" || !errors.As(err, &violation) || violation.Field != tc.field {
				t.Fatalf("%s admission: %v", tc.field, err)
			}
		}
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

func TestMutationAdmissionPreservesRefusalsAndVersionPriority(t *testing.T) {
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 0, time.UTC)
	header := model.TaskHeader{ProjectID: "00000000-0000-4000-8000-000000000001", ID: "00000000-0000-4000-8000-000000000002", Version: 7}
	current := []model.TaskStep{
		{ID: "00000001", Position: 0, Title: "one", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp},
		{ID: "00000002", Position: 1, Title: "two", Status: model.TaskStepDone, CreatedAt: stamp, UpdatedAt: stamp},
	}
	anchor, missing, self, last := "00000001", "ffffffff", "00000002", "last"
	step := model.TaskStep{ID: "00000003", Title: "three", Status: model.TaskStepTodo}
	assertFault := func(err error, code string) {
		t.Helper()
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != code {
			t.Fatalf("fault %q: %v", code, err)
		}
	}
	_, err := AdmitAdd(header, current, current[0], nil, nil)
	assertFault(err, "step_id_conflict")
	_, err = AdmitAdd(header, current, step, &missing, nil)
	assertFault(err, "not_found")
	exhausted := header
	exhausted.Version = math.MaxInt64
	_, err = AdmitAdd(exhausted, current, step, nil, nil)
	assertFault(err, "version_exhausted")
	_, err = AdmitDelete(exhausted, current, current[0].ID)
	assertFault(err, "version_exhausted")
	_, err = AdmitChange(header, current, missing, Changes{Title: &anchor})
	assertFault(err, "not_found")
	var absence *StepAbsence
	if !errors.As(err, &absence) || absence.Version != 7 || !errors.Is(err, ErrTargetNotFound) || absence.Error() == "" {
		t.Fatalf("absence lost version or cause: %v", err)
	}
	_, err = AdmitMove(header, current, missing, Placement{Before: &anchor})
	assertFault(err, "not_found")
	_, err = AdmitMove(header, current, self, Placement{Before: &missing})
	assertFault(err, "not_found")
	if !errors.Is(err, ErrAnchorNotFound) {
		t.Fatalf("anchor cause: %v", err)
	}
	_, err = AdmitMove(header, current, self, Placement{Before: &self})
	assertFault(err, "invalid_input")
	if !errors.Is(err, ErrSelfAnchor) {
		t.Fatalf("self anchor cause: %v", err)
	}
	unchanged, err := AdmitMove(exhausted, current, self, Placement{Position: &last})
	if err != nil || unchanged.Changed {
		t.Fatalf("same position at version limit: %+v %v", unchanged, err)
	}
	_, err = AdmitMove(exhausted, current, anchor, Placement{Position: &last})
	assertFault(err, "version_exhausted")
	for _, operation := range []func() error{
		func() error { _, err := AdmitAdd(header, current[:1], step, nil, nil); return err },
		func() error { _, err := AdmitChange(header, current[:1], anchor, Changes{}); return err },
		func() error { _, err := AdmitDelete(header, current[:1], anchor); return err },
		func() error { _, err := AdmitMove(header, current[:1], anchor, Placement{Position: &last}); return err },
	} {
		corrupt := current[0].Position
		current[0].Position = 3
		if err := operation(); err == nil {
			t.Fatal("invalid stored collection admitted")
		}
		current[0].Position = corrupt
	}
}

func TestMutationsRetainSurvivorTimesAndEncodeChanges(t *testing.T) {
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 0, time.UTC)
	now := stamp.Add(time.Minute)
	header := model.TaskHeader{ProjectID: "00000000-0000-4000-8000-000000000001", ID: "00000000-0000-4000-8000-000000000002", Version: 3}
	current := []model.TaskStep{
		{ID: "00000001", Position: 0, Title: "one", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp},
		{ID: "00000002", Position: 1, Title: "two", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp},
	}
	title := "revised"
	change, err := AdmitChange(header, current, current[0].ID, Changes{Title: &title})
	if err != nil || !change.Changed {
		t.Fatalf("change admission: %+v %v", change, err)
	}
	resource, _, err := EncodeMutation(header, change, now, "change")
	if err != nil || resource.Version != 4 || !change.Candidate[0].CreatedAt.Equal(stamp) || !change.Candidate[0].UpdatedAt.Equal(now) || !change.Candidate[1].UpdatedAt.Equal(stamp) || !current[0].UpdatedAt.Equal(stamp) {
		t.Fatalf("content times: %+v %v", change, err)
	}
	deletion, err := AdmitDelete(header, current, current[0].ID)
	if err != nil || !deletion.Changed || deletion.From != 0 || len(deletion.Candidate) != 1 || deletion.Candidate[0].Position != 0 || !deletion.Candidate[0].UpdatedAt.Equal(stamp) {
		t.Fatalf("delete: %+v %v", deletion, err)
	}
	if _, _, err := EncodeMutation(header, deletion, now, ""); err != nil {
		t.Fatal(err)
	}
	first := "first"
	move, err := AdmitMove(header, current, current[1].ID, Placement{Position: &first})
	if err != nil || !move.Changed || move.From != 1 || move.To != 0 || move.Candidate[0].ID != current[1].ID {
		t.Fatalf("move: %+v %v", move, err)
	}
	resource, _, err = EncodeMutation(header, move, now, "")
	if err != nil || resource.Version != 4 || !move.Candidate[0].UpdatedAt.Equal(stamp) || !move.Candidate[1].UpdatedAt.Equal(stamp) {
		t.Fatalf("move times: %+v %v", move, err)
	}
	unchanged := Mutation{Candidate: current}
	resource, _, err = EncodeMutation(header, unchanged, now, "")
	if err != nil || resource.Version != 3 || !current[0].UpdatedAt.Equal(stamp) {
		t.Fatalf("no-op: %+v %v", resource, err)
	}
}

func TestWriteInputValidationAndCapacityFault(t *testing.T) {
	bad, first, before, after := "bad", "middle", "ABCDEF01", "abcdef02"
	invalidStatus := model.TaskStepStatus("unknown")
	validStatus := model.TaskStepDone
	if _, err := CanonicalID("bad"); err == nil {
		t.Fatal("accepted invalid ID")
	}
	if id, err := CanonicalID(before); err != nil || id != "abcdef01" {
		t.Fatalf("canonical ID: %q %v", id, err)
	}
	for _, test := range []struct {
		title, description string
		status             *model.TaskStepStatus
		before, after      *string
	}{
		{title: " ", description: ""}, {title: "valid", description: "\x00"}, {title: "valid", status: &invalidStatus},
		{title: "valid", before: &before, after: &after}, {title: "valid", before: &bad},
	} {
		_, _, _, err := PrepareAdd("abcdef00", test.title, test.description, test.status, test.before, test.after)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_input" {
			t.Fatalf("invalid add accepted: %+v %v", test, err)
		}
	}
	_, anchor, _, err := PrepareAdd("abcdef00", "valid", "", &validStatus, &before, nil)
	if err != nil || *anchor != "abcdef01" || before != "ABCDEF01" {
		t.Fatalf("add anchor: %v %v", anchor, err)
	}
	for _, change := range []Changes{{Title: new(" ")}, {Description: new("\x00")}, {Status: &invalidStatus}} {
		if err := ValidateChanges(change); err == nil {
			t.Fatalf("accepted invalid changes: %+v", change)
		}
	}
	if err := ValidateChanges(Changes{Status: &validStatus}); err != nil {
		t.Fatal(err)
	}
	for _, placement := range []Placement{{}, {Position: &first}, {Before: &bad}} {
		if _, err := CanonicalPlacement(placement); err == nil {
			t.Fatalf("accepted placement: %+v", placement)
		}
	}
	limit := &codec.LimitError{EncodedBytes: codec.MaxEncodedBytes + 1}
	faultErr := EncodingFault(limit)
	var fault *model.Fault
	if !errors.As(faultErr, &fault) || fault.Code != "steps_limit_exceeded" || fault.StepsLimit == nil || fault.StepsLimit.EncodedBytes != limit.EncodedBytes || fault.StepsLimit.MaxEncodedBytes != codec.MaxEncodedBytes || !errors.Is(faultErr, limit) {
		t.Fatalf("capacity details: %v", faultErr)
	}
}
