package steps

import (
	"bytes"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
)

func TestDeleteCandidatePreservesSurvivorsAndSourceRows(t *testing.T) {
	ids := []string{"00000000", "11111111", "abcdef01", "fedcba98"}
	current := make([]model.TaskStep, len(ids))
	for index, id := range ids {
		stamp := time.Date(2026, 1, index+1, 2, 3, 4, index*1000, time.UTC)
		current[index] = model.TaskStep{ID: id, Position: int64(index), Title: "same", Description: id + "\n<原值&>", Status: []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}[index], CreatedAt: stamp, UpdatedAt: stamp.Add(time.Hour)}
	}
	original := append([]model.TaskStep{}, current...)
	for deleted, id := range ids {
		t.Run(id, func(t *testing.T) {
			candidate, index, err := DeleteCandidate(current, id)
			if err != nil || index != deleted || len(candidate) != len(current)-1 || candidate == nil {
				t.Fatalf("delete candidate: index=%d candidate=%+v err=%v", index, candidate, err)
			}
			for position, actual := range candidate {
				source := position
				if position >= deleted {
					source++
				}
				expected := current[source]
				expected.Position = int64(position)
				if actual != expected {
					t.Fatalf("deletion changed survivor identity/content/time at %d", position)
				}
			}
			if !reflect.DeepEqual(current, original) {
				t.Fatal("deletion changed input rows")
			}
			candidate[0].Title = "mutated copy"
			if !reflect.DeepEqual(current, original) {
				t.Fatal("candidate shares mutable row storage")
			}
		})
	}
	for _, rows := range [][]model.TaskStep{nil, {}, current} {
		if _, _, err := DeleteCandidate(rows, "ffffffff"); !errors.Is(err, ErrTargetNotFound) {
			t.Fatal("missing current target became successful deletion")
		}
	}
}

func TestDeleteCandidateSingletonEncodesExplicitEmptyCollection(t *testing.T) {
	header := model.TaskHeader{ProjectID: "00000000-0000-4000-8000-000000000001", ID: "00000000-0000-4000-8000-000000000002", Version: 1}
	step := model.TaskStep{ID: "00abcdef"}
	candidate, index, err := DeleteCandidate([]model.TaskStep{step}, step.ID)
	if err != nil || index != 0 || candidate == nil || len(candidate) != 0 {
		t.Fatal("singleton deletion lost explicit empty collection")
	}
	resource, data, err := codec.EncodeCollection(header, candidate)
	if err != nil || resource.Steps == nil || len(resource.Steps) != 0 || !bytes.Contains(data, []byte(`"steps":[]`)) {
		t.Fatal("singleton deletion cannot produce complete empty public resource")
	}
}
