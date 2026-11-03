package tasksteps

import (
	"bytes"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestDeleteCandidatePreservesSurvivorsAndSourceRows(t *testing.T) {
	ids := []string{"00000000", "11111111", "abcdef01", "fedcba98"}
	current := make([]core.TaskStep, len(ids))
	for index, id := range ids {
		stamp := time.Date(2026, 1, index+1, 2, 3, 4, index*1000, time.UTC)
		current[index] = core.TaskStep{ID: id, Position: int64(index), Title: "same", Description: id + "\n<原值&>", Status: []core.TaskStepStatus{core.TaskStepTodo, core.TaskStepInProgress, core.TaskStepDone, core.TaskStepSkipped}[index], CreatedAt: stamp, UpdatedAt: stamp.Add(time.Hour)}
	}
	original := append([]core.TaskStep{}, current...)
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
	for _, rows := range [][]core.TaskStep{nil, {}, current} {
		if _, _, err := DeleteCandidate(rows, "ffffffff"); !errors.Is(err, ErrTargetNotFound) {
			t.Fatal("missing current target became successful deletion")
		}
	}
}

func TestDeleteCandidateSingletonEncodesExplicitEmptyCollection(t *testing.T) {
	header, step := fixture()
	candidate, index, err := DeleteCandidate([]core.TaskStep{step}, step.ID)
	if err != nil || index != 0 || candidate == nil || len(candidate) != 0 {
		t.Fatal("singleton deletion lost explicit empty collection")
	}
	resource, data, err := EncodeCollection(header, candidate)
	if err != nil || resource.Steps == nil || len(resource.Steps) != 0 || !bytes.Contains(data, []byte(`"steps":[]`)) {
		t.Fatal("singleton deletion cannot produce complete empty public resource")
	}
}
