package task

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func invalidTagFilter() error {
	return &model.Fault{Code: "invalid_tag_filter", Message: "Tag filter must use existing Project tags and a valid match mode."}
}

func NormalizeTagFilter(filter store.TagFilter) (store.TagFilter, error) {
	if filter.TagMatch == "" {
		filter.TagMatch = "all"
	}
	if filter.TagMatch != "all" && filter.TagMatch != "any" || filter.Untagged && len(filter.TagIDs) != 0 {
		return store.TagFilter{}, invalidTagFilter()
	}
	ids := make([]string, len(filter.TagIDs))
	for i, id := range filter.TagIDs {
		canonical, err := model.CanonicalID(id)
		if err != nil {
			return store.TagFilter{}, invalidTagFilter()
		}
		ids[i] = canonical
	}
	slices.Sort(ids)
	filter.TagIDs = slices.Compact(ids)
	return filter, nil
}

type TagFilterReader interface {
	ResolveTags(context.Context, string, []string) ([]model.Tag, error)
}

// RequireTagFilter runs before selection in the same authorized snapshot.
func RequireTagFilter(ctx context.Context, reader TagFilterReader, projectID string, filter store.TagFilter) error {
	if len(filter.TagIDs) == 0 {
		return nil
	}
	tags, err := reader.ResolveTags(ctx, projectID, filter.TagIDs)
	if err != nil {
		return err
	}
	if len(tags) != len(filter.TagIDs) {
		return invalidTagFilter()
	}
	return nil
}

// TagFilterIdentity keeps cursor size independent of the number of selected tags.
func TagFilterIdentity(filter store.TagFilter) string {
	raw, _ := json.Marshal(filter)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}
