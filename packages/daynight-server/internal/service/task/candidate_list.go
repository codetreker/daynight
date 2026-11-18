package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

func listSelectionRequest(request TaskListRequest) taskcore.ListRequest {
	return taskcore.ListRequest{TagFilter: request.TagFilter, Type: request.Type, Parent: request.Parent,
		PageRequest: request.PageRequest, AssignedTo: request.AssignedTo, Status: request.Status,
		Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform,
		PlatformSpecific: request.PlatformSpecific, AutomaticCandidate: request.AutomaticCandidate,
		WorkerID: request.WorkerID, CandidateWorkerID: request.CandidateWorkerID}
}

// Validate the request before opening a snapshot; a candidate cursor can only
// be checked after the authoritative filter has been read in that snapshot.
func prepareListSelection(projectID, userID string, request TaskListRequest) (taskcore.ListSelection, error) {
	input := listSelectionRequest(request)
	if request.CandidateWorkerID != nil {
		empty := model.TagNameFilter{Names: []string{}, Match: "any"}
		input.CandidateTagFilter = &empty
		input.Cursor = nil
	}
	return taskcore.SelectList(projectID, userID, input)
}

func candidateListSelection(ctx context.Context, snapshot store.SnapshotScope, principal model.Principal, projectID string, request TaskListRequest) (taskcore.ListSelection, error) {
	workerID, err := model.CanonicalID(*request.CandidateWorkerID)
	if err != nil {
		return taskcore.ListSelection{}, err
	}
	resource, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, principal.UserID, workerID)
	if errors.Is(err, model.ErrNotFound) {
		return taskcore.ListSelection{}, &model.Fault{Code: "not_found", Message: "Worker was not found.", Cause: err}
	}
	if err != nil {
		return taskcore.ListSelection{}, err
	}
	filter := model.TagNameFilter{Names: []string{}, Match: "any"}
	if resource.Desired != nil {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(resource.Desired.Raw, &fields); err != nil || fields == nil || len(fields["taskTagFilter"]) == 0 {
			return taskcore.ListSelection{}, fmt.Errorf("stored Worker task tag filter is missing or invalid")
		}
		filter, err = workercore.ParseTaskTagFilter(fields["taskTagFilter"])
		if err != nil {
			return taskcore.ListSelection{}, fmt.Errorf("stored Worker task tag filter is invalid")
		}
	}
	input := listSelectionRequest(request)
	input.CandidateWorkerID = &workerID
	input.CandidateTagFilter = &filter
	return taskcore.SelectList(projectID, principal.UserID, input)
}
