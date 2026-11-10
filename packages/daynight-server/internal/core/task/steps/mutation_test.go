package steps

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"slices"
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

func receiverHeader(version int64) model.TaskHeader {
	return model.TaskHeader{ProjectID: "22222222-2222-4222-8222-222222222222", ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Version: version}
}

func receiverRows() []model.TaskStep {
	return []model.TaskStep{
		{ID: "00000000", Position: 0, Title: "same", Description: "original body", Status: model.TaskStepTodo, CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC), UpdatedAt: time.Date(2026, 2, 3, 4, 5, 6, 654321000, time.UTC)},
		{ID: "abcdef01", Position: 1, Title: "same", Description: "other body", Status: model.TaskStepInProgress, CreatedAt: time.Date(2026, 1, 3, 3, 4, 5, 123456000, time.UTC), UpdatedAt: time.Date(2026, 2, 4, 4, 5, 6, 654321000, time.UTC)},
	}
}

func receiverFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func receiverCandidate(t *testing.T, current, before []model.TaskStep, mutation Mutation) {
	t.Helper()
	if !reflect.DeepEqual(current, before) {
		t.Fatal("admission changed source rows")
	}
	if len(current) > 0 && len(mutation.Candidate) > 0 && &current[0] == &mutation.Candidate[0] {
		t.Fatal("candidate aliases source rows")
	}
}

func receiverEncoded(t *testing.T, header model.TaskHeader, mutation Mutation, observed time.Time, kind string, expected []model.TaskStep) {
	t.Helper()
	resource, data, err := EncodeMutation(header, mutation, observed, kind)
	if err != nil {
		t.Fatal(err)
	}
	if mutation.Changed {
		header.Version++
	}
	wantResource, wantData, err := codec.EncodeCollection(header, expected)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(resource, wantResource) || !bytes.Equal(data, wantData) || !reflect.DeepEqual(mutation.Candidate, expected) {
		t.Fatalf("encoded resource or candidate differs: got %+v want %+v", resource, wantResource)
	}
}

func TestWriteReceiverOriginalTextLimits(t *testing.T) {
	cases := []struct {
		name, title, description, field string
		parserReject, valid             bool
	}{
		{"title boundary multibyte", strings.Repeat("界", 341) + "x", "", "", false, true},
		{"title over multibyte", strings.Repeat("界", 341) + "xx", "", "title", false, false},
		{"description boundary multibyte", "x", strings.Repeat("界", 21845) + "x", "", false, true},
		{"description over multibyte", "x", strings.Repeat("界", 21845) + "xx", "description", false, false},
		{"escaped boundary", strings.Repeat("<", 1024), strings.Repeat("<", 65536), "", false, true},
		{"title over escaped", strings.Repeat("<", 1025), "", "title", false, false},
		{"description over escaped", "x", strings.Repeat("<", 65537), "description", false, false},
		{"empty description", "title", "", "", false, true},
		{"whitespace title", " \u0085\t", "", "title", true, false},
		{"nul title", "x\x00", "", "title", true, false},
		{"nul description", "x", "\x00", "description", true, false},
		{"invalid title UTF-8", string([]byte{0xff}), "", "title", true, false},
		{"invalid description UTF-8", "x", string([]byte{0xff}), "description", true, false},
	}
	observed := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	for i, tc := range cases {
		for _, operation := range []string{"add", "change"} {
			t.Run(tc.name+"/"+operation, func(t *testing.T) {
				header := receiverHeader(1)
				originalHeader := header
				current := receiverRows()
				original := slices.Clone(current)
				id := fmt.Sprintf("%08x", i+2)
				var mutation Mutation
				var err error
				if operation == "add" {
					var step model.TaskStep
					var before, after *string
					step, before, after, err = PrepareAdd(id, tc.title, tc.description, nil, nil, nil)
					if err == nil {
						if tc.parserReject {
							t.Fatal("parser accepted invalid text")
						}
						mutation, err = AdmitAdd(header, current, step, before, after)
					}
				} else {
					id = "00000000"
					changes := Changes{Title: &tc.title, Description: &tc.description}
					err = ValidateChanges(changes)
					if err == nil {
						if tc.parserReject {
							t.Fatal("parser accepted invalid text")
						}
						mutation, err = AdmitChange(header, current, id, changes)
					}
				}
				if !tc.valid {
					receiverFault(t, err, "invalid_input")
					if tc.parserReject {
						if !strings.Contains(err.Error(), tc.field) {
							t.Fatalf("parser refusal lost %s reason: %v", tc.field, err)
						}
					} else {
						var violation *limit.Violation
						actual, maximum := len(tc.title), int64(1024)
						if tc.field == "description" {
							actual, maximum = len(tc.description), 65536
						}
						if !errors.As(err, &violation) || violation.Field != tc.field || violation.Actual != int64(actual) || violation.Max != maximum || violation.Unit != "bytes" {
							t.Fatalf("byte refusal lost field or measured bytes: %v", err)
						}
					}
					if !reflect.DeepEqual(mutation, Mutation{}) || !reflect.DeepEqual(current, original) || header != originalHeader {
						t.Fatal("refusal changed input or returned mutation")
					}
					return
				}
				if err != nil || !mutation.Changed {
					t.Fatalf("admission: %+v %v", mutation, err)
				}
				expected := slices.Clone(original)
				position := 0
				if operation == "add" {
					position = 2
					expected = append(expected, model.TaskStep{ID: id, Position: 2, Title: tc.title, Description: tc.description, Status: model.TaskStepTodo, CreatedAt: observed, UpdatedAt: observed})
				} else {
					expected[0].Title, expected[0].Description, expected[0].UpdatedAt = tc.title, tc.description, observed
				}
				if mutation.To != position {
					t.Fatalf("target position = %d, want %d", mutation.To, position)
				}
				receiverCandidate(t, current, original, mutation)
				resource, data, err := EncodeMutation(header, mutation, observed, operation)
				if err != nil {
					t.Fatal(err)
				}
				var decoded codec.StepsResource
				if err := json.Unmarshal(data, &decoded); err != nil || !reflect.DeepEqual(decoded, resource) {
					t.Fatalf("encoded resource differs: %v", err)
				}
				if resource.ProjectID != header.ProjectID || resource.TaskID != header.ID || resource.Version != 2 || len(resource.Steps) != len(expected) || !reflect.DeepEqual(mutation.Candidate, expected) {
					t.Fatal("encoded mutation lost parent or complete candidate")
				}
				for j, row := range expected {
					want := codec.Step{ID: row.ID, Title: row.Title, Description: row.Description, Status: row.Status, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
					if resource.Steps[j] != want {
						t.Fatalf("encoded row %d differs", j)
					}
				}
				receiverCandidate(t, current, original, mutation)
				if header != originalHeader {
					t.Fatal("encoding changed source header")
				}
			})
		}
	}
}

func TestWriteReceiverOriginalCollectionCapacity(t *testing.T) {
	const count = 170
	body := strings.Repeat("<", 65536)
	at := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	header := receiverHeader(1)
	originalHeader := header
	full := make([]model.TaskStep, count+1)
	for i := range full {
		full[i] = model.TaskStep{ID: fmt.Sprintf("%08x", i), Position: int64(i), Title: "x", Description: body, Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	}
	_, encoded, err := codec.EncodeCollection(header, full[:count])
	if err != nil || len(encoded) >= codec.MaxEncodedBytes {
		t.Fatalf("170 complete descriptions must fit actual codec: size=%d err=%v", len(encoded), err)
	}
	encoded = nil
	current := slices.Clone(full)
	current[count].Description = ""
	original := slices.Clone(current)
	changes := Changes{Description: &body}
	if err := ValidateChanges(changes); err != nil {
		t.Fatal(err)
	}
	change, err := AdmitChange(header, current, "000000aa", changes)
	if err != nil || !change.Changed || change.To != count || !reflect.DeepEqual(change.Candidate, full) {
		t.Fatalf("171-row change candidate differs: %v", err)
	}
	receiverCandidate(t, current, original, change)
	_, _, err = EncodeMutation(header, change, at, "change")
	var fault *model.Fault
	var actualLimit *codec.LimitError
	if !errors.As(err, &fault) || fault.Code != "steps_limit_exceeded" || !errors.As(err, &actualLimit) || actualLimit.EncodedBytes <= codec.MaxEncodedBytes || fault.StepsLimit == nil || fault.StepsLimit.MaxEncodedBytes != 64*1024*1024 || fault.StepsLimit.EncodedBytes != actualLimit.EncodedBytes || !errors.Is(err, actualLimit) {
		t.Fatalf("actual 171-row overflow lost fault, details or cause: %v", err)
	}
	if !reflect.DeepEqual(change.Candidate, full) || header != originalHeader {
		t.Fatal("encoding changed candidate or source header")
	}
	receiverCandidate(t, current, original, change)
	step, before, after, err := PrepareAdd("000000ab", "x", body, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	add, err := AdmitAdd(header, current, step, before, after)
	if err != nil || !add.Changed || add.To != count+1 || len(add.Candidate) != count+2 {
		t.Fatalf("172-row add admission: %v", err)
	}
	for i, got := range add.Candidate {
		var want model.TaskStep
		if i < len(original) {
			want = original[i]
		} else {
			want = model.TaskStep{ID: "000000ab", Position: count + 1, Title: "x", Description: body, Status: model.TaskStepTodo}
		}
		if got != want || got.Position != int64(i) {
			t.Fatalf("add candidate row %d differs", i)
		}
	}
	receiverCandidate(t, current, original, add)
	if header != originalHeader {
		t.Fatal("add changed source header")
	}
}

func TestWriteReceiverAddCases(t *testing.T) {
	header := receiverHeader(1)
	observed := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	current := []model.TaskStep{}
	step, beforeAnchor, afterAnchor, err := PrepareAdd("ABCDEF01", "same", "", nil, nil, nil)
	if err != nil || step != (model.TaskStep{ID: "abcdef01", Title: "same", Status: model.TaskStepTodo}) || beforeAnchor != nil || afterAnchor != nil {
		t.Fatalf("first preparation: %+v %v", step, err)
	}
	mutation, err := AdmitAdd(header, current, step, beforeAnchor, afterAnchor)
	if err != nil || !mutation.Changed || mutation.To != 0 {
		t.Fatalf("first admission: %+v %v", mutation, err)
	}
	first := model.TaskStep{ID: "abcdef01", Position: 0, Title: "same", Status: model.TaskStepTodo, CreatedAt: observed, UpdatedAt: observed}
	receiverEncoded(t, header, mutation, observed, "add", []model.TaskStep{first})
	if current == nil || len(current) != 0 {
		t.Fatal("empty source changed")
	}

	header.Version++
	current = []model.TaskStep{first}
	original := slices.Clone(current)
	anchor, status := "ABCDEF01", model.TaskStepSkipped
	step, beforeAnchor, afterAnchor, err = PrepareAdd("00000000", "same", "  # 原值\n<>&  ", &status, &anchor, nil)
	if err != nil || beforeAnchor == nil || *beforeAnchor != "abcdef01" || afterAnchor != nil || anchor != "ABCDEF01" {
		t.Fatalf("second preparation: %+v %v", step, err)
	}
	mutation, err = AdmitAdd(header, current, step, beforeAnchor, afterAnchor)
	if err != nil || !mutation.Changed || mutation.To != 0 {
		t.Fatalf("second admission: %+v %v", mutation, err)
	}
	receiverCandidate(t, current, original, mutation)
	observed = observed.Add(time.Microsecond)
	inserted := model.TaskStep{ID: "00000000", Position: 0, Title: "same", Description: "  # 原值\n<>&  ", Status: status, CreatedAt: observed, UpdatedAt: observed}
	first.Position = 1
	receiverEncoded(t, header, mutation, observed, "add", []model.TaskStep{inserted, first})
	receiverCandidate(t, current, original, mutation)
}

func TestWriteReceiverAddRefusals(t *testing.T) {
	missing := "ffffffff"
	for _, tc := range []struct {
		name    string
		version int64
		id      string
		before  *string
		code    string
	}{
		{"duplicate", 2, "00000000", &missing, "step_id_conflict"},
		{"anchor", 2, "12345678", &missing, "not_found"},
		{"exhausted duplicate", math.MaxInt64, "00000000", nil, "step_id_conflict"},
		{"exhausted anchor", math.MaxInt64, "12345678", &missing, "not_found"},
		{"exhausted", math.MaxInt64, "12345678", nil, "version_exhausted"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			current := receiverRows()[:1]
			original := slices.Clone(current)
			step, before, after, err := PrepareAdd(tc.id, "x", "", nil, tc.before, nil)
			if err != nil {
				t.Fatal(err)
			}
			mutation, err := AdmitAdd(receiverHeader(tc.version), current, step, before, after)
			receiverFault(t, err, tc.code)
			if !reflect.DeepEqual(mutation, Mutation{}) || !reflect.DeepEqual(current, original) {
				t.Fatal("refusal changed input or returned mutation")
			}
		})
	}
	current := receiverRows()[:1]
	current[0].Position = 2
	original := slices.Clone(current)
	step, before, after, err := PrepareAdd("abcdef01", "x", "", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	mutation, err := AdmitAdd(receiverHeader(2), current, step, before, after)
	var fault *model.Fault
	if err == nil || errors.As(err, &fault) || !reflect.DeepEqual(mutation, Mutation{}) || !reflect.DeepEqual(current, original) {
		t.Fatalf("corrupt add collection was not rejected as technical error: %v", err)
	}
}

func TestWriteReceiverChangeNoOpAndRefusals(t *testing.T) {
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			header := receiverHeader(version)
			for _, tc := range []struct {
				name    string
				changes Changes
			}{
				{"title", Changes{Title: new("same")}},
				{"description", Changes{Description: new("original body")}},
				{"paired", Changes{Title: new("same"), Description: new("original body")}},
				{"status", Changes{Status: new(model.TaskStepTodo)}},
			} {
				t.Run(tc.name, func(t *testing.T) {
					current := receiverRows()
					original := slices.Clone(current)
					if err := ValidateChanges(tc.changes); err != nil {
						t.Fatal(err)
					}
					mutation, err := AdmitChange(header, current, "00000000", tc.changes)
					if err != nil || mutation.Changed || mutation.To != 0 {
						t.Fatalf("no-op: %+v %v", mutation, err)
					}
					receiverCandidate(t, current, original, mutation)
					receiverEncoded(t, header, mutation, time.Time{}, "change", original)
					receiverCandidate(t, current, original, mutation)
				})
			}
		})
	}
	for _, tc := range []struct {
		name, id, code string
		changes        Changes
	}{
		{"changed title", "00000000", "version_exhausted", Changes{Title: new("changed")}},
		{"changed status", "00000000", "version_exhausted", Changes{Status: new(model.TaskStepDone)}},
		{"missing", "ffffffff", "not_found", Changes{Title: new("changed")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			current := receiverRows()
			original := slices.Clone(current)
			mutation, err := AdmitChange(receiverHeader(math.MaxInt64), current, tc.id, tc.changes)
			receiverFault(t, err, tc.code)
			if tc.name == "missing" {
				var absence *StepAbsence
				if !errors.As(err, &absence) || absence.Version != math.MaxInt64 || !errors.Is(err, ErrTargetNotFound) {
					t.Fatalf("missing target: %v", err)
				}
			}
			if !reflect.DeepEqual(mutation, Mutation{}) || !reflect.DeepEqual(current, original) {
				t.Fatal("refusal changed source or returned mutation")
			}
		})
	}
	missingRows := receiverRows()
	missingOriginal := slices.Clone(missingRows)
	missingMutation, missingErr := AdmitChange(receiverHeader(1), missingRows, "ffffffff", Changes{Title: new("changed")})
	receiverFault(t, missingErr, "not_found")
	var absence *StepAbsence
	if !errors.As(missingErr, &absence) || absence.Version != 1 || !errors.Is(missingErr, ErrTargetNotFound) || !reflect.DeepEqual(missingMutation, Mutation{}) || !reflect.DeepEqual(missingRows, missingOriginal) {
		t.Fatalf("missing target at original version: %v", missingErr)
	}
	current := receiverRows()
	current[1].Position = 3
	original := slices.Clone(current)
	mutation, err := AdmitChange(receiverHeader(1), current, "00000000", Changes{Status: new(model.TaskStepDone)})
	var fault *model.Fault
	if err == nil || errors.As(err, &fault) || !reflect.DeepEqual(mutation, Mutation{}) || !reflect.DeepEqual(current, original) {
		t.Fatalf("corrupt change collection was not rejected as technical error: %v", err)
	}
}

func TestWriteReceiverChangeSequence(t *testing.T) {
	header := receiverHeader(1)
	current := receiverRows()
	original := slices.Clone(current)
	title := "  <原值&> 😀 \uFEFF  "
	description := "  # Markdown\n\"\\\u2028\u2029  "
	observed := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	changes := []Changes{{Title: &title, Description: &description}, {Status: new(model.TaskStepInProgress)}, {Status: new(model.TaskStepDone)}, {Status: new(model.TaskStepSkipped)}, {Status: new(model.TaskStepTodo)}, {Description: new("")}}
	for _, change := range changes {
		before := slices.Clone(current)
		if err := ValidateChanges(change); err != nil {
			t.Fatal(err)
		}
		mutation, err := AdmitChange(header, current, "00000000", change)
		if err != nil || !mutation.Changed || mutation.To != 0 {
			t.Fatalf("change admission: %+v %v", mutation, err)
		}
		receiverCandidate(t, current, before, mutation)
		expected := slices.Clone(current)
		if change.Title != nil {
			expected[0].Title = *change.Title
		}
		if change.Description != nil {
			expected[0].Description = *change.Description
		}
		if change.Status != nil {
			expected[0].Status = *change.Status
		}
		expected[0].UpdatedAt = observed
		receiverEncoded(t, header, mutation, observed, "change", expected)
		receiverCandidate(t, current, before, mutation)
		current = expected
		header.Version++
		observed = observed.Add(time.Microsecond)
	}
	if !reflect.DeepEqual(original, receiverRows()) {
		t.Fatal("original rows changed")
	}
}

func TestTaskStepsChildAbsenceKeepsIdentityAndCause(t *testing.T) {
	absence := &StepAbsence{Version: 9007199254740993, Cause: model.ErrNotFound}
	if absence.Version != 9007199254740993 || absence.Error() != "step is currently absent" || !errors.Is(absence, model.ErrNotFound) {
		t.Fatal("child absence lost safe diagnostic or exact cause")
	}
}

func TestWriteReceiverRootTextSequence(t *testing.T) {
	header := model.TaskHeader{ProjectID: "c3333333-3333-4333-8333-333333333333", ID: "a7777777-7777-4777-8777-777777777777", Version: 1}
	observed := time.Date(2026, 11, 8, 12, 0, 0, 123456000, time.UTC)
	current := []model.TaskStep{}
	for i, tc := range []struct{ field, valid, excess string }{
		{"title", strings.Repeat("é", 512), strings.Repeat("é", 512) + "x"},
		{"description", strings.Repeat("\x01", 65536), strings.Repeat("\x01", 65536) + "x"},
	} {
		id := fmt.Sprintf("%08x", i+1)
		title, description := "x", ""
		if tc.field == "title" {
			title = tc.excess
		} else {
			description = tc.excess
		}
		step, before, after, err := PrepareAdd(id, title, description, nil, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		original := slices.Clone(current)
		mutation, err := AdmitAdd(header, current, step, before, after)
		assertReceiverTextRefusal(t, err, tc.field, mutation)
		if !reflect.DeepEqual(current, original) {
			t.Fatal("refused add changed source")
		}

		if tc.field == "title" {
			title = tc.valid
		} else {
			description = tc.valid
		}
		step, before, after, err = PrepareAdd(id, title, description, nil, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		mutation, err = AdmitAdd(header, current, step, before, after)
		if err != nil || !mutation.Changed || mutation.To != i {
			t.Fatalf("boundary add: %+v %v", mutation, err)
		}
		receiverCandidate(t, current, original, mutation)
		expected := slices.Clone(current)
		expected = append(expected, model.TaskStep{ID: id, Position: int64(i), Title: title, Description: description, Status: model.TaskStepTodo, CreatedAt: observed, UpdatedAt: observed})
		receiverEncoded(t, header, mutation, observed, "add", expected)
		receiverCandidate(t, current, original, mutation)
		current = expected
		header.Version++

		var invalid Changes
		if tc.field == "title" {
			invalid.Title = &tc.excess
		} else {
			invalid.Description = &tc.excess
		}
		if err := ValidateChanges(invalid); err != nil {
			t.Fatal(err)
		}
		original = slices.Clone(current)
		mutation, err = AdmitChange(header, current, id, invalid)
		assertReceiverTextRefusal(t, err, tc.field, mutation)
		if !reflect.DeepEqual(current, original) {
			t.Fatal("refused change changed source")
		}

		for _, value := range []string{"short", tc.valid} {
			var change Changes
			if tc.field == "title" {
				change.Title = &value
			} else {
				change.Description = &value
			}
			if err := ValidateChanges(change); err != nil {
				t.Fatal(err)
			}
			original = slices.Clone(current)
			mutation, err = AdmitChange(header, current, id, change)
			if err != nil || !mutation.Changed || mutation.To != i {
				t.Fatalf("boundary update: %+v %v", mutation, err)
			}
			receiverCandidate(t, current, original, mutation)
			expected = slices.Clone(current)
			if tc.field == "title" {
				expected[i].Title = value
			} else {
				expected[i].Description = value
			}
			expected[i].UpdatedAt = observed
			receiverEncoded(t, header, mutation, observed, "change", expected)
			receiverCandidate(t, current, original, mutation)
			current = expected
			header.Version++
		}
	}
	if header.Version != 7 || current[0].Title != strings.Repeat("é", 512) || current[1].Description != strings.Repeat("\x01", 65536) {
		t.Fatal("root text sequence lost version or original bytes")
	}
}

func assertReceiverTextRefusal(t *testing.T, err error, field string, mutation Mutation) {
	t.Helper()
	receiverFault(t, err, "invalid_input")
	var violation *limit.Violation
	if !errors.As(err, &violation) || violation.Field != field || !strings.Contains(err.Error(), field) || !reflect.DeepEqual(mutation, Mutation{}) {
		t.Fatalf("%s refusal: %+v %v", field, mutation, err)
	}
}

// orderedReceiverRows matches the public ordering scenarios, including each
// record's distinct content and timestamps.
func orderedReceiverRows() []model.TaskStep {
	ids := []string{"00000000", "11111111", "abcdef01", "fedcba98"}
	statuses := []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}
	rows := make([]model.TaskStep, len(ids))
	for i, id := range ids {
		rows[i] = model.TaskStep{
			ID: id, Position: int64(i), Title: "same", Description: "  # " + id + "\n<原值&>  ", Status: statuses[i],
			CreatedAt: time.Date(2026, 1, 2+i, 3, 4, 5, 123456000, time.UTC),
			UpdatedAt: time.Date(2026, 2, 3+i, 4, 5, 6, 654321000, time.UTC),
		}
	}
	return rows
}

// orderedReceiverExpected builds the specified result from independent facts.
func orderedReceiverExpected(t *testing.T, ids ...string) []model.TaskStep {
	t.Helper()
	facts := orderedReceiverRows()
	rows := make([]model.TaskStep, 0, len(ids))
	for position, id := range ids {
		index := slices.IndexFunc(facts, func(row model.TaskStep) bool { return row.ID == id })
		if index < 0 {
			t.Fatalf("unknown expected row %q", id)
		}
		row := facts[index]
		row.Position = int64(position)
		rows = append(rows, row)
	}
	return rows
}

func assertOrderedReceiverIndependent(t *testing.T, current, original []model.TaskStep, candidate []model.TaskStep) {
	t.Helper()
	if !reflect.DeepEqual(current, original) {
		t.Fatalf("source rows changed: got %+v want %+v", current, original)
	}
	for i := range current {
		for j := range candidate {
			if &current[i] == &candidate[j] {
				t.Fatal("candidate shares source row storage")
			}
		}
	}
}

func TestWriteReceiverMoveSequence(t *testing.T) {
	header := receiverHeader(1)
	observed := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	current := orderedReceiverRows()
	for _, tc := range []struct {
		name, target string
		placement    Placement
		from, to     int
		order        []string
	}{
		{"after", "00000000", Placement{After: new("ABCDEF01")}, 0, 2, []string{"11111111", "abcdef01", "00000000", "fedcba98"}},
		{"before", "fedcba98", Placement{Before: new("ABCDEF01")}, 3, 1, []string{"11111111", "fedcba98", "abcdef01", "00000000"}},
		{"first", "abcdef01", Placement{Position: new("first")}, 2, 0, []string{"abcdef01", "11111111", "fedcba98", "00000000"}},
		{"last", "abcdef01", Placement{Position: new("last")}, 0, 3, []string{"11111111", "fedcba98", "00000000", "abcdef01"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			original := slices.Clone(current)
			placement, err := CanonicalPlacement(tc.placement)
			if err != nil {
				t.Fatal(err)
			}
			mutation, err := AdmitMove(header, current, tc.target, placement)
			if err != nil || !mutation.Changed || mutation.From != tc.from || mutation.To != tc.to {
				t.Fatalf("move admission: %+v %v", mutation, err)
			}
			expected := orderedReceiverExpected(t, tc.order...)
			assertOrderedReceiverIndependent(t, current, original, mutation.Candidate)
			receiverEncoded(t, header, mutation, observed, "", expected)
			assertOrderedReceiverIndependent(t, current, original, mutation.Candidate)
			current = expected
			header.Version++
		})
	}
}

func TestWriteReceiverMoveNoOpAndRefusals(t *testing.T) {
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		for _, tc := range []struct {
			name, target string
			placement    Placement
			index        int
		}{
			{"first", "00000000", Placement{Position: new("first")}, 0},
			{"last", "fedcba98", Placement{Position: new("last")}, 3},
			{"before", "11111111", Placement{Before: new("ABCDEF01")}, 1},
			{"after", "abcdef01", Placement{After: new("11111111")}, 2},
		} {
			t.Run(fmt.Sprintf("%d/%s", version, tc.name), func(t *testing.T) {
				header, current := receiverHeader(version), orderedReceiverRows()
				original := slices.Clone(current)
				placement, err := CanonicalPlacement(tc.placement)
				if err != nil {
					t.Fatal(err)
				}
				mutation, err := AdmitMove(header, current, tc.target, placement)
				if err != nil || mutation.Changed || mutation.From != tc.index || mutation.To != tc.index {
					t.Fatalf("no-op: %+v %v", mutation, err)
				}
				assertOrderedReceiverIndependent(t, current, original, mutation.Candidate)
				receiverEncoded(t, header, mutation, time.Time{}, "", original)
				assertOrderedReceiverIndependent(t, current, original, mutation.Candidate)
			})
		}
	}
	for _, position := range []string{"first", "last"} {
		t.Run("singleton/"+position, func(t *testing.T) {
			current := orderedReceiverRows()[:1]
			original := slices.Clone(current)
			placement, err := CanonicalPlacement(Placement{Position: &position})
			if err != nil {
				t.Fatal(err)
			}
			mutation, err := AdmitMove(receiverHeader(math.MaxInt64), current, "00000000", placement)
			if err != nil || mutation.Changed || mutation.From != 0 || mutation.To != 0 {
				t.Fatalf("singleton: %+v %v", mutation, err)
			}
			assertOrderedReceiverIndependent(t, current, original, mutation.Candidate)
			receiverEncoded(t, receiverHeader(math.MaxInt64), mutation, time.Time{}, "", original)
		})
	}
	for _, tc := range []struct {
		name, target, code string
		placement          Placement
		cause              error
		absent             bool
		version            int64
	}{
		{"exhausted", "00000000", "version_exhausted", Placement{Position: new("last")}, nil, false, math.MaxInt64},
		{"max target", "ffffffff", "not_found", Placement{Before: new("eeeeeeee")}, ErrTargetNotFound, true, math.MaxInt64},
		{"max anchor", "00000000", "not_found", Placement{Before: new("ffffffff")}, ErrAnchorNotFound, false, math.MaxInt64},
		{"target", "ffffffff", "not_found", Placement{Before: new("ffffffff")}, ErrTargetNotFound, true, 1},
		{"anchor", "00000000", "not_found", Placement{Before: new("ffffffff")}, ErrAnchorNotFound, false, 1},
		{"self before", "abcdef01", "invalid_input", Placement{Before: new("ABCDEF01")}, ErrSelfAnchor, false, 1},
		{"self after", "abcdef01", "invalid_input", Placement{After: new("ABCDEF01")}, ErrSelfAnchor, false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			current := orderedReceiverRows()
			original := slices.Clone(current)
			placement, err := CanonicalPlacement(tc.placement)
			if err != nil {
				t.Fatal(err)
			}
			mutation, err := AdmitMove(receiverHeader(tc.version), current, tc.target, placement)
			assertOrderedReceiverRefusal(t, mutation, err, tc.code, tc.cause, tc.absent, tc.version)
			if !reflect.DeepEqual(current, original) {
				t.Fatal("refusal changed source rows")
			}
		})
	}
}

func assertOrderedReceiverRefusal(t *testing.T, mutation Mutation, err error, code string, cause error, absent bool, version int64) {
	t.Helper()
	receiverFault(t, err, code)
	if cause != nil && !errors.Is(err, cause) {
		t.Fatalf("missing cause %v: %v", cause, err)
	}
	var absence *StepAbsence
	if found := errors.As(err, &absence); found != absent || found && absence.Version != version {
		t.Fatalf("wrong absence/version: %+v in %v", absence, err)
	}
	if !reflect.DeepEqual(mutation, Mutation{}) {
		t.Fatalf("refusal returned mutation: %+v", mutation)
	}
}

func TestWriteReceiverDeleteSequence(t *testing.T) {
	header := receiverHeader(1)
	observed := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	current := orderedReceiverRows()
	for _, tc := range []struct {
		target string
		from   int
		order  []string
	}{
		{"abcdef01", 2, []string{"00000000", "11111111", "fedcba98"}},
		{"00000000", 0, []string{"11111111", "fedcba98"}},
		{"fedcba98", 1, []string{"11111111"}},
		{"11111111", 0, []string{}},
	} {
		t.Run(tc.target, func(t *testing.T) {
			original := slices.Clone(current)
			mutation, err := AdmitDelete(header, current, tc.target)
			if err != nil || !mutation.Changed || mutation.From != tc.from || mutation.Candidate == nil {
				t.Fatalf("delete admission: %+v %v", mutation, err)
			}
			expected := orderedReceiverExpected(t, tc.order...)
			assertOrderedReceiverIndependent(t, current, original, mutation.Candidate)
			receiverEncoded(t, header, mutation, observed, "", expected)
			assertOrderedReceiverIndependent(t, current, original, mutation.Candidate)
			if len(expected) == 0 {
				resource, data, err := EncodeMutation(header, mutation, observed, "")
				if err != nil || resource.Steps == nil || !bytes.Contains(data, []byte(`"steps":[]`)) {
					t.Fatalf("empty collection: %s %v", data, err)
				}
			}
			current = expected
			header.Version++
		})
	}
}

func TestWriteReceiverDeleteRefusalsAndReuse(t *testing.T) {
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		t.Run(fmt.Sprintf("missing/%d", version), func(t *testing.T) {
			current := orderedReceiverRows()
			original := slices.Clone(current)
			mutation, err := AdmitDelete(receiverHeader(version), current, "ffffffff")
			assertOrderedReceiverRefusal(t, mutation, err, "not_found", ErrTargetNotFound, true, version)
			if !reflect.DeepEqual(current, original) {
				t.Fatal("missing changed source")
			}
		})
	}
	current := orderedReceiverRows()
	original := slices.Clone(current)
	mutation, err := AdmitDelete(receiverHeader(math.MaxInt64), current, "00000000")
	assertOrderedReceiverRefusal(t, mutation, err, "version_exhausted", nil, false, math.MaxInt64)
	if !reflect.DeepEqual(current, original) {
		t.Fatal("exhaustion changed source")
	}

	header := receiverHeader(2)
	current = orderedReceiverExpected(t, "00000000", "11111111", "fedcba98")
	original = slices.Clone(current)
	mutation, err = AdmitDelete(header, current, "abcdef01")
	assertOrderedReceiverRefusal(t, mutation, err, "not_found", ErrTargetNotFound, true, 2)
	if !reflect.DeepEqual(current, original) {
		t.Fatal("missing changed source")
	}
	step, before, after, err := PrepareAdd("ABCDEF01", "New record", "", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	mutation, err = AdmitAdd(header, current, step, before, after)
	if err != nil || !mutation.Changed || mutation.To != 3 {
		t.Fatalf("reuse admission: %+v %v", mutation, err)
	}
	assertOrderedReceiverIndependent(t, current, original, mutation.Candidate)
	observed := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	expected := append(slices.Clone(original), model.TaskStep{ID: "abcdef01", Position: 3, Title: "New record", Status: model.TaskStepTodo, CreatedAt: observed, UpdatedAt: observed})
	receiverEncoded(t, header, mutation, observed, "add", expected)
	assertOrderedReceiverIndependent(t, current, original, mutation.Candidate)
	if expected[3].CreatedAt.Equal(orderedReceiverRows()[2].CreatedAt) || expected[3].UpdatedAt.Equal(orderedReceiverRows()[2].UpdatedAt) {
		t.Fatal("reused ID retained old times")
	}
}

func TestWriteReceiverOrderRejectsCorruptCollection(t *testing.T) {
	for _, kind := range []string{"move", "delete"} {
		t.Run(kind, func(t *testing.T) {
			current := orderedReceiverRows()
			current[2].Position = 9
			original := slices.Clone(current)
			var mutation Mutation
			var err error
			if kind == "move" {
				placement, placementErr := CanonicalPlacement(Placement{Position: new("last")})
				if placementErr != nil {
					t.Fatal(placementErr)
				}
				mutation, err = AdmitMove(receiverHeader(1), current, "00000000", placement)
			} else {
				mutation, err = AdmitDelete(receiverHeader(1), current, "00000000")
			}
			var fault *model.Fault
			if err == nil || errors.As(err, &fault) || !reflect.DeepEqual(mutation, Mutation{}) || !reflect.DeepEqual(current, original) {
				t.Fatalf("corrupt %s collection was not rejected as technical error: %v", kind, err)
			}
		})
	}
}
