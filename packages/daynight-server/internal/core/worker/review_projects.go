package worker

import (
	"encoding/json"
	"sort"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// ReviewProjectIDs projects the latest desired configuration independently of
// its unrelated fields, using the same retained-project interpretation as
// configuration updates. A missing target has no eligible projects.
func ReviewProjectIDs(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	projects := retainedProjects(&model.WorkerDesiredConfiguration{Raw: raw})
	ids := make([]string, 0, len(projects))
	for id := range projects {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
