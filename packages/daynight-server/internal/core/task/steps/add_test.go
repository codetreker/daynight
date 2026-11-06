package steps

import (
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestAddCandidatePreservesInputAndIdentityPrecedence(t *testing.T) {
	current := []model.TaskStep{{ID: "00000000", Position: 0, Title: "same"}, {ID: "abcdef01", Position: 1, Title: "same"}}
	before := append([]model.TaskStep{}, current...)
	for _, tc := range []struct {
		before, after *string
		order         []string
	}{
		{nil, nil, []string{"00000000", "abcdef01", "12345678"}},
		{new("abcdef01"), nil, []string{"00000000", "12345678", "abcdef01"}},
		{nil, new("00000000"), []string{"00000000", "12345678", "abcdef01"}},
	} {
		candidate, _, err := AddCandidate(current, model.TaskStep{ID: "12345678"}, tc.before, tc.after)
		if err != nil {
			t.Fatal(err)
		}
		for index, step := range candidate {
			if step.ID != tc.order[index] || step.Position != int64(index) {
				t.Fatal(candidate)
			}
		}
		if !reflect.DeepEqual(current, before) {
			t.Fatal("candidate changed current rows")
		}
	}
	if _, _, err := AddCandidate(current, model.TaskStep{ID: "00000000"}, new("ffffffff"), nil); !errors.Is(err, ErrIDConflict) {
		t.Fatal("anchor outranked duplicate identity")
	}
	if _, _, err := AddCandidate(current, model.TaskStep{ID: "12345678"}, nil, new("ffffffff")); !errors.Is(err, ErrAnchorNotFound) {
		t.Fatal("missing anchor accepted")
	}
}
