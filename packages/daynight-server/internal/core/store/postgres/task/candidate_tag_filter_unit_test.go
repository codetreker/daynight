package task

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestCandidateTagNameFilterRejectsInvalidInput(t *testing.T) {
	for _, filter := range []model.TagNameFilter{
		{Names: nil, Match: "any"}, {Names: []string{""}, Match: "any"}, {Names: []string{"tag"}, Match: "other"},
	} {
		args := []any{"project"}
		if _, err := candidateTagNameFilter(&filter, &args); err == nil {
			t.Fatalf("accepted invalid filter %#v", filter)
		}
	}
}
