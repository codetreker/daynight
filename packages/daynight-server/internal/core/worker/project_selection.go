package worker

import (
	"context"
	"encoding/json"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RemoveProjectSelections removes the project from the selected snapshot in the
// caller's transaction. Later selections and first imports remain independent.
func RemoveProjectSelections(ctx context.Context, dao store.WorkerProjectSelectionDAO, projectID string) error {
	_, err := RemoveProjectSelectionsCount(ctx, dao, projectID)
	return err
}

// RemoveProjectSelectionsCount reports rows changed inside the caller's
// transaction. The count is durable only if that transaction commits.
func RemoveProjectSelectionsCount(ctx context.Context, dao store.WorkerProjectSelectionDAO, projectID string) (int, error) {
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return 0, err
	}
	candidates, err := dao.ProjectSelectionCandidates(ctx, id)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, candidate := range candidates {
		target, err := dao.LockProjectSelection(ctx, candidate)
		if err != nil {
			return 0, err
		}
		if target == nil {
			continue
		}
		updated, changed, err := removeProjectSelection(target.Raw, id)
		if err != nil {
			return 0, err
		}
		if !changed {
			continue
		}
		if target.Revision == math.MaxInt64 {
			return 0, &model.Fault{Code: "version_exhausted", Message: "Worker configuration revision is exhausted."}
		}
		if err := dao.SaveProjectSelection(ctx, candidate, target.Revision+1, updated); err != nil {
			return 0, err
		}
		count++
	}
	return count, nil
}

func removeProjectSelection(raw json.RawMessage, projectID string) (json.RawMessage, bool, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, false, invalidInput("Stored Worker configuration is invalid.")
	}
	var projects []json.RawMessage
	if err := json.Unmarshal(fields["projects"], &projects); err != nil || projects == nil {
		return nil, false, nil
	}
	kept := make([]json.RawMessage, 0, len(projects))
	changed := false
	for _, project := range projects {
		var identity struct {
			ProjectID string `json:"projectId"`
		}
		if json.Unmarshal(project, &identity) == nil && identity.ProjectID == projectID {
			changed = true
			continue
		}
		kept = append(kept, project)
	}
	if !changed {
		return nil, false, nil
	}
	encoded, err := json.Marshal(kept)
	if err != nil {
		return nil, false, err
	}
	fields["projects"] = encoded
	updated, err := json.Marshal(fields)
	return updated, true, err
}
