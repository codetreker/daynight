package task

import (
	"context"
	"math"
	"sort"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const GoalPrerequisiteLimit = 30

type GoalDependencyTarget = store.GoalRelationTarget
type GoalDependencyEndpoint = store.GoalEndpoint
type GoalDependencyReference struct{ EdgeID, ProjectID, GoalID string }
type GoalDependencyEdit struct {
	IfRevision    int64
	Mode          string
	Add           []GoalDependencyEndpoint
	Remove        []string
	Prerequisites []GoalDependencyReference
}
type GoalDependencyPrerequisite struct {
	EdgeID *string
	Target *GoalDependencyTarget
}
type GoalDependencies struct {
	GoalID            string
	CanEdit           bool
	Revision          *int64
	CompletionBlocked bool
	Prerequisites     []GoalDependencyPrerequisite
	Successors        []GoalDependencyTarget
	NextCursor        *string
}
type GoalDependencyReceipt struct {
	GoalID   string
	Revision int64
	Changed  bool
}

func relationFault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func relationInput(message string) error       { return relationFault("invalid_input", message) }

func ValidateGoalDependencyEdit(input GoalDependencyEdit) error {
	if input.IfRevision < 1 {
		return relationInput("ifRevision must be a positive int64.")
	}
	if len(input.Add) > 30 || len(input.Remove) > 30 || len(input.Prerequisites) > 30 {
		return relationInput("Goal dependency operations are limited to 30 entries.")
	}
	switch input.Mode {
	case "edit":
		if input.Prerequisites != nil || len(input.Add)+len(input.Remove) == 0 {
			return relationInput("edit requires add or remove operations only.")
		}
	case "replace":
		if input.Add != nil || input.Remove != nil || input.Prerequisites == nil {
			return relationInput("replace requires an explicit prerequisites array only.")
		}
	default:
		return relationInput("mode must be edit or replace.")
	}
	seen := map[string]bool{}
	check := func(key string) error {
		if seen[key] {
			return relationInput("Goal dependency entries must be unique.")
		}
		seen[key] = true
		return nil
	}
	for _, target := range input.Add {
		if err := validateGoalEndpoint(target); err != nil {
			return err
		}
		if err := check("target:" + target.GoalID); err != nil {
			return err
		}
	}
	for _, edge := range input.Remove {
		if id, err := model.CanonicalID(edge); err != nil || id != edge {
			return relationInput("Invalid Goal edge UUID.")
		}
		if err := check("edge:" + edge); err != nil {
			return err
		}
	}
	for _, ref := range input.Prerequisites {
		if ref.EdgeID != "" {
			if ref.ProjectID != "" || ref.GoalID != "" {
				return relationInput("A prerequisite must identify either an edge or a Goal.")
			}
			if id, err := model.CanonicalID(ref.EdgeID); err != nil || id != ref.EdgeID {
				return relationInput("Invalid Goal edge UUID.")
			}
			if err := check("edge:" + ref.EdgeID); err != nil {
				return err
			}
		} else {
			if err := validateGoalEndpoint(store.GoalEndpoint{ProjectID: ref.ProjectID, GoalID: ref.GoalID}); err != nil {
				return err
			}
			if err := check("target:" + ref.GoalID); err != nil {
				return err
			}
		}
	}
	return nil
}
func validateGoalEndpoint(target store.GoalEndpoint) error {
	for _, value := range []string{target.ProjectID, target.GoalID} {
		if id, err := model.CanonicalID(value); err != nil || id != value {
			return relationInput("Goal endpoints require canonical UUIDs.")
		}
	}
	return nil
}
func GoalDependencyCandidates(input GoalDependencyEdit) []store.GoalEndpoint {
	result := append([]store.GoalEndpoint{}, input.Add...)
	for _, ref := range input.Prerequisites {
		if ref.EdgeID == "" {
			result = append(result, store.GoalEndpoint{ProjectID: ref.ProjectID, GoalID: ref.GoalID})
		}
	}
	return result
}
func RequireGoalRelationSource(source store.GoalRelationSource, write bool) error {
	if !source.CanRead || write && !source.CanEdit {
		return relationFault("not_found", "Project was not found.")
	}
	if source.Deleted {
		return relationFault("task_deleted", "Task has been deleted.")
	}
	if source.Type == "" {
		return relationFault("not_found", "Task was not found.")
	}
	if source.Type != model.TaskTypeGoal {
		return relationInput("Goal dependency operations require a Goal.")
	}
	return nil
}

// PrepareGoalRelations evaluates the authoritative graph, including hidden
// edges. Permission filtering is applied only to the separate read projection.
func PrepareGoalRelations(ctx context.Context, dao store.GoalRelationEditor, goalID string, input GoalDependencyEdit, facts store.GoalRelationAdmission) ([]store.GoalRelationEdge, bool, error) {
	if err := RequireGoalRelationSource(facts.Source, true); err != nil {
		return nil, false, err
	}
	if facts.Source.Revision != input.IfRevision {
		return nil, false, relationFault("goal_dependency_revision_conflict", "Goal dependency revision has changed.")
	}
	current, err := dao.Edges(ctx, goalID)
	if err != nil {
		return nil, false, err
	}
	byEdge := map[string]store.GoalRelationEdge{}
	byGoal := map[string]store.GoalRelationEdge{}
	for _, edge := range current {
		byEdge[edge.ID] = edge
		byGoal[edge.Endpoint.GoalID] = edge
	}
	final := map[string]store.GoalRelationEdge{}
	if input.Mode == "edit" {
		for _, edge := range current {
			final[edge.Endpoint.GoalID] = edge
		}
	}
	removed := map[string]bool{}
	for _, id := range input.Remove {
		edge, ok := byEdge[id]
		if !ok {
			return nil, false, relationInput("Goal dependency edge is unavailable.")
		}
		removed[edge.Endpoint.GoalID] = true
		delete(final, edge.Endpoint.GoalID)
	}
	for _, ref := range input.Prerequisites {
		if ref.EdgeID != "" {
			edge, ok := byEdge[ref.EdgeID]
			if !ok {
				return nil, false, relationInput("Goal dependency edge is unavailable.")
			}
			final[edge.Endpoint.GoalID] = edge
		}
	}
	for _, target := range facts.Targets {
		if !target.Available {
			return nil, false, relationFault("goal_dependency_target_unavailable", "Goal dependency target is unavailable.")
		}
		if target.Endpoint.GoalID == goalID {
			return nil, false, relationInput("A Goal cannot depend on itself.")
		}
		if target.TeamID != facts.Source.TeamID {
			return nil, false, relationFault("goal_dependency_team_mismatch", "Goal dependencies require the same owner Team.")
		}
		if removed[target.Endpoint.GoalID] {
			return nil, false, relationInput("A Goal dependency cannot be added and removed together.")
		}
		if _, duplicate := final[target.Endpoint.GoalID]; duplicate && input.Mode == "replace" {
			return nil, false, relationInput("Goal dependency entries must identify distinct Goals.")
		}
		edge, exists := byGoal[target.Endpoint.GoalID]
		if !exists {
			id, err := uuid.NewRandom()
			if err != nil {
				return nil, false, err
			}
			edge = store.GoalRelationEdge{ID: id.String(), Endpoint: target.Endpoint, Status: target.Status}
		}
		final[target.Endpoint.GoalID] = edge
	}
	if len(final) > GoalPrerequisiteLimit {
		return nil, false, relationInput("A Goal may have at most 30 prerequisites.")
	}
	deleted := []string{}
	changed := len(final) != len(current)
	for _, edge := range current {
		if _, ok := final[edge.Endpoint.GoalID]; !ok {
			deleted = append(deleted, edge.ID)
			changed = true
		}
	}
	result := make([]store.GoalRelationEdge, 0, len(final))
	for _, edge := range final {
		if facts.Source.Status == model.TaskDone && edge.Status != model.TaskDone {
			return nil, false, relationFault("goal_dependency_unsatisfied", "Completed Goals require completed prerequisites.")
		}
		if _, exists := byGoal[edge.Endpoint.GoalID]; !exists {
			changed = true
			cycle, err := dao.Reaches(ctx, edge.Endpoint.ProjectID, edge.Endpoint.GoalID, goalID, deleted)
			if err != nil {
				return nil, false, err
			}
			if cycle {
				return nil, false, relationFault("goal_dependency_cycle", "Goal dependencies must not form a cycle.")
			}
		}
		result = append(result, edge)
	}
	if changed && facts.Source.Revision == math.MaxInt64 {
		return nil, false, relationFault("version_exhausted", "Goal dependency revision is exhausted.")
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, changed, nil
}
