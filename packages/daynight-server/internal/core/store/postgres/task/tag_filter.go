package task

import (
	"fmt"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func taskTagFilter(filter store.TagFilter, args *[]any) (string, error) {
	if filter.TagMatch != "" && filter.TagMatch != "all" && filter.TagMatch != "any" || filter.Untagged && len(filter.TagIDs) != 0 {
		return "", fmt.Errorf("invalid tag filter")
	}
	for i, id := range filter.TagIDs {
		canonical, err := model.CanonicalID(id)
		if err != nil || canonical != id || i > 0 && filter.TagIDs[i-1] >= id {
			return "", fmt.Errorf("tag filter IDs must be canonical, sorted and unique")
		}
	}
	if filter.Untagged {
		return " AND NOT EXISTS (SELECT 1 FROM task_tags tt WHERE tt.project_id=t.project_id AND tt.task_id=t.id)", nil
	}
	if len(filter.TagIDs) == 0 {
		return "", nil
	}
	*args = append(*args, slices.Clone(filter.TagIDs))
	position := len(*args)
	if filter.TagMatch == "any" {
		return fmt.Sprintf(" AND EXISTS (SELECT 1 FROM task_tags tt WHERE tt.project_id=t.project_id AND tt.task_id=t.id AND tt.tag_id=ANY($%d::uuid[]))", position), nil
	}
	return fmt.Sprintf(" AND NOT EXISTS (SELECT 1 FROM unnest($%d::uuid[]) requested(id) WHERE NOT EXISTS (SELECT 1 FROM task_tags tt WHERE tt.project_id=t.project_id AND tt.task_id=t.id AND tt.tag_id=requested.id))", position), nil
}
