package task

import (
	"math"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// TagCandidate preserves an omitted collection and canonicalizes an explicit one.
// The original Task version is checked even when the resulting set is unchanged.
func TagCandidate(current model.Task, version int64, requested *[]string) ([]string, bool, error) {
	if err := RequireVersion(current.Version, version); err != nil {
		return nil, false, err
	}
	original := make([]string, 0, len(current.Tags))
	for _, tag := range current.Tags {
		original = append(original, tag.ID)
	}
	slices.Sort(original)
	if requested == nil {
		return original, false, nil
	}
	ids := make([]string, 0, len(*requested))
	for _, id := range *requested {
		canonical, err := model.CanonicalID(id)
		if err != nil {
			return nil, false, err
		}
		ids = append(ids, canonical)
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	changed := !slices.Equal(original, ids)
	if changed && current.Version == math.MaxInt64 {
		return nil, false, &model.Fault{Code: "version_exhausted", Message: "Task version is exhausted."}
	}
	return ids, changed, nil
}
