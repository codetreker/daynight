package task

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskTagFilterRejectsInvalidDAOInputs(t *testing.T) {
	a, b := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, filter := range []store.TagFilter{
		{TagMatch: "other"}, {TagIDs: []string{a}, Untagged: true}, {TagIDs: []string{"bad"}},
		{TagIDs: []string{"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}}, {TagIDs: []string{a, a}}, {TagIDs: []string{b, a}},
	} {
		args := []any{"project"}
		if _, err := taskTagFilter(filter, &args); err == nil {
			t.Fatalf("accepted invalid filter %#v", filter)
		}
	}
}
