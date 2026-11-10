package task

import (
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
)

func NewSessionAggregation(observed time.Time) taskwork.Aggregation {
	return taskwork.Aggregation{Complete: true, ObservedAt: observed}
}
func AddSessionObservation(summary *taskwork.Aggregation, observation sp.TaskSessionObservation) {
	indicator := ""
	if observation.Indicator != nil {
		indicator = *observation.Indicator
	}
	switch indicator {
	case "warning":
		summary.WarningCount++
	case "notice":
		summary.NoticeCount++
	case "working":
		summary.WorkingCount++
	default:
		summary.UnknownCount++
	}
	summary.Complete = summary.Complete && observation.Observation == "observed" && indicator != ""
	result := ""
	if summary.WarningCount > 0 {
		result = "warning"
	} else if summary.NoticeCount > 0 {
		result = "notice"
	} else if summary.WorkingCount > 0 {
		result = "working"
	}
	if result != "" {
		summary.Indicator = &result
	}
}
func ProjectWorkGroup(group store.TaskWorkGroup, assigned string, observed time.Time) taskwork.Group {
	kind := "chain"
	if group.MemberCount == 1 {
		kind = "task"
	}
	result := taskwork.Group{GroupID: group.ID, Kind: kind, DisplayTaskID: group.DisplayTaskID, TitlePreview: group.TitlePreview, TitleTruncated: group.TitleTruncated, AssignedTo: assigned, AggregationScope: "accessible_in_progress_members", MemberCount: group.MemberCount, MatchedCount: group.MatchedCount, InProgressCount: group.InProgressCount, RootCount: group.RootCount, Roots: []taskwork.Root{}, RootsTruncated: group.RootCount > int64(len(group.Roots)), Summary: NewSessionAggregation(observed), Targets: []taskwork.Target{}, ObservedAt: observed}
	for _, root := range group.Roots {
		result.Roots = append(result.Roots, taskwork.Root{TaskID: root.ID, TitlePreview: root.TitlePreview, TitleTruncated: root.TitleTruncated})
	}
	return result
}
func ProjectWorkTarget(task model.Task, assigned string, observation sp.TaskSessionObservation) taskwork.Target {
	return taskwork.Target{TaskID: task.ID, AssignedTo: task.AssignedTo, MatchesAssignee: task.AssignedTo != nil && *task.AssignedTo == assigned, SessionID: observation.SessionID, Indicator: observation.Indicator, Reason: observation.Reason, Send: observation.Send}
}

// FitWorkPage applies only the work-overview budget. It preserves complete
// groups when possible, and resumes after the last actually returned target.
func FitWorkPage(page taskwork.Page, selection WorkSelection, fence store.TaskSearchFence, positions map[string]store.TaskWorkPosition, maxBytes int) (taskwork.Page, error) {
	for {
		raw, err := json.Marshal(page)
		if err != nil {
			return taskwork.Page{}, err
		}
		if len(raw) <= maxBytes {
			return page, nil
		}
		if len(page.Groups) > 1 {
			page.Groups = page.Groups[:len(page.Groups)-1]
			last := page.Groups[len(page.Groups)-1]
			cursor, err := selection.CursorAfter(fence, positions[last.GroupID])
			if err != nil {
				return taskwork.Page{}, err
			}
			page.NextCursor = &cursor
			continue
		}
		if len(page.Groups) == 1 && len(page.Groups[0].Targets) > 1 {
			g := &page.Groups[0]
			g.Targets = g.Targets[:len(g.Targets)-1]
			cursor, err := selection.TargetCursor(fence, store.TaskWorkTargetPosition{GroupID: g.GroupID, TaskID: g.Targets[len(g.Targets)-1].TaskID})
			if err != nil {
				return taskwork.Page{}, err
			}
			g.ContributorCursor = &cursor
			continue
		}
		return taskwork.Page{}, &model.Fault{Code: "resource_limit_exceeded", Message: "The work overview envelope cannot fit one complete result; use a smaller request identifier."}
	}
}

// GraphRelations walks ordinary edges from the requested task. Direct external
// prerequisites remain visible but never contribute to the component summary.
func GraphRelations(graph model.TaskGraph, root string) map[string]string {
	adjacency := make(map[string][]string, len(graph.Tasks))
	known := make(map[string]bool, len(graph.Tasks))
	for _, task := range graph.Tasks {
		known[task.ID] = true
	}
	for _, task := range graph.Tasks {
		external := make(map[string]bool, len(task.ExternalDependsOn))
		for _, id := range task.ExternalDependsOn {
			external[id] = true
		}
		for _, id := range task.DependsOn {
			if !external[id] && known[id] {
				adjacency[task.ID] = append(adjacency[task.ID], id)
				adjacency[id] = append(adjacency[id], task.ID)
			}
		}
	}
	members := map[string]bool{root: true}
	queue := []string{root}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, neighbor := range adjacency[id] {
			if !members[neighbor] {
				members[neighbor] = true
				queue = append(queue, neighbor)
			}
		}
	}
	relations := make(map[string]string, len(graph.Tasks))
	for _, task := range graph.Tasks {
		relations[task.ID] = "external"
		if members[task.ID] {
			relations[task.ID] = "member"
		}
	}
	return relations
}
