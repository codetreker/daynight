package task

import (
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tag"
)

// candidateTagNameFilter applies the worker's name keys before pagination.
func candidateTagNameFilter(filter *model.TagNameFilter, args *[]any) (string, error) {
	if filter == nil {
		return "", nil
	}
	keys, err := tag.NameFilterKeys(*filter)
	if err != nil {
		return "", err
	}
	if len(keys) == 0 {
		return "", nil
	}
	*args = append(*args, keys)
	position := len(*args)
	const matchingTag = ` FROM task_tags tt JOIN project_tags pt ON pt.project_id=tt.project_id AND pt.id=tt.tag_id
		WHERE tt.project_id=t.project_id AND tt.task_id=t.id AND `
	if filter.Match == "any" {
		return fmt.Sprintf(" AND EXISTS (SELECT 1"+matchingTag+"pt.name_key=ANY($%d::text[]))", position), nil
	}
	return fmt.Sprintf(" AND NOT EXISTS (SELECT 1 FROM unnest($%d::text[]) requested(key) WHERE NOT EXISTS (SELECT 1"+matchingTag+"pt.name_key=requested.key))", position), nil
}
