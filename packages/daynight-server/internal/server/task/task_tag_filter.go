package task

import (
	"net/url"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func taskTagFilter(values url.Values) (store.TagFilter, error) {
	filter := store.TagFilter{}
	if value, exists := values["tagIds"]; exists {
		filter.TagIDs = strings.Split(value[0], ",")
	}
	if value, exists := values["tagMatch"]; exists {
		filter.TagMatch = value[0]
	}
	if value, exists := values["untagged"]; exists {
		if value[0] != "true" && value[0] != "false" {
			return store.TagFilter{}, &model.Fault{Code: "invalid_tag_filter", Message: "untagged must be true or false."}
		}
		filter.Untagged = value[0] == "true"
	}
	return taskcore.NormalizeTagFilter(filter)
}
