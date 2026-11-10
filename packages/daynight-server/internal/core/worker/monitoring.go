package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
)

// monitoringScopeVisible uses the same current-resource rule for details and
// compact summary references. A claim's former identity is not proof of access.
func monitoringScopeVisible(projectID, taskID string, sources store.WorkerMonitoringSources) bool {
	if projectID == "" {
		return taskID == ""
	}
	if _, ok := sources.Projects[projectID]; !ok {
		return false
	}
	if taskID == "" {
		return true
	}
	task, ok := sources.Tasks[taskID]
	return ok && task.Task.ProjectID == projectID
}

// MonitoringSummaryScopes returns unique resource IDs required to qualify the
// private summary references against one current permission snapshot.
func MonitoringSummaryScopes(summaries []monitoring.StoredSummary) ([]string, []string) {
	projects, tasks := map[string]bool{}, map[string]bool{}
	for _, summary := range summaries {
		for _, reason := range summary.Admission.Reasons {
			if reason.ProjectID != "" {
				projects[reason.ProjectID] = true
			}
			if reason.TaskID != "" {
				tasks[reason.TaskID] = true
			}
		}
	}
	p, t := make([]string, 0, len(projects)), make([]string, 0, len(tasks))
	for id := range projects {
		p = append(p, id)
	}
	for id := range tasks {
		t = append(t, id)
	}
	sort.Strings(p)
	sort.Strings(t)
	return p, t
}

// ProjectMonitoringSummary filters before deduplicating so a visible reason
// cannot reveal whether another, inaccessible scope reported the same code.
func ProjectMonitoringSummary(summary monitoring.StoredSummary, sources store.WorkerMonitoringSources) (json.RawMessage, error) {
	codes := make(map[int]string)
	restricted := false
	for _, reason := range summary.Admission.Reasons {
		if !monitoringScopeVisible(reason.ProjectID, reason.TaskID, sources) {
			restricted = true
			continue
		}
		codes[reason.CodeIndex] = reason.Code
	}
	indexes := make([]int, 0, len(codes))
	for index := range codes {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	visible := make([]string, 0, len(indexes))
	for _, index := range indexes {
		visible = append(visible, codes[index])
	}
	projection := "current"
	if restricted {
		projection = "restricted"
	}
	return monitoring.EncodePublicSummary(summary, visible, projection)
}

// MonitoringScopes returns the unique project and task IDs needed for current permission checks.
func MonitoringScopes(o monitoring.Observation) ([]string, []string) {
	projects, tasks := map[string]bool{}, map[string]bool{}
	for _, item := range monitoringItems(o) {
		s := item["scope"].(map[string]any)
		if p, ok := s["projectId"].(string); ok {
			projects[p] = true
		}
		if t, ok := s["taskId"].(string); ok {
			tasks[t] = true
		}
	}
	p, t := make([]string, 0, len(projects)), make([]string, 0, len(tasks))
	for id := range projects {
		p = append(p, id)
	}
	for id := range tasks {
		t = append(t, id)
	}
	return p, t
}
func monitoringItems(o monitoring.Observation) []map[string]any {
	var items []map[string]any
	for _, key := range []string{"reasons", "reservations", "activities", "currentFailures"} {
		var v any
		if key == "reasons" {
			v = o["admission"].(map[string]any)[key]
		} else {
			v = o[key]
		}
		for _, x := range v.([]any) {
			items = append(items, x.(map[string]any))
		}
	}
	if r, ok := o["lastRecovery"].(map[string]any); ok {
		items = append(items, r)
	}
	return items
}

// ValidateMonitoringExecution checks claims that represent execution, while cleanup and reservations remain self-reported resource facts.
func ValidateMonitoringExecution(o monitoring.Observation, sources store.WorkerMonitoringSources, userID, workerID string) error {
	for _, raw := range o["activities"].([]any) {
		a := raw.(map[string]any)
		if a["kind"] != "execution" {
			continue
		}
		scope := a["scope"].(map[string]any)
		if scope["kind"] != "claim" {
			continue
		}
		source, ok := sources.Tasks[scope["taskId"].(string)]
		if !ok || source.Task.ProjectID != scope["projectId"] {
			return &model.Fault{Code: "not_found", Message: "Monitoring association was not found."}
		}
		claim, err := taskcore.ActiveWorker(source.Task, scope["claimId"].(string))
		if err != nil {
			var fault *model.Fault
			if errors.As(err, &fault) && fault.Code == "claim_conflict" {
				return &model.Fault{Code: "invalid_input", Message: "Execution monitoring must refer to the current worker claim.", Cause: err}
			}
			return fmt.Errorf("decode execution monitoring claim: %w", err)
		}
		if claim.UserID != userID || claim.WorkerID != workerID {
			return &model.Fault{Code: "invalid_input", Message: "Execution monitoring must refer to the current worker claim."}
		}
	}
	return nil
}

// ProjectMonitoring filters each scoped detail before attaching current labels.
// Budgeting uses the same HTML-escaped JSON and trailing newline as the HTTP encoder.
func ProjectMonitoring(result *monitoring.DetailResponse, sources store.WorkerMonitoringSources) error {
	o := result.Data
	originalCoverage := o["detailCoverage"].(string)
	type pending struct {
		item  map[string]any
		label any
	}
	var labels []pending
	project := func(item map[string]any) bool {
		scope := item["scope"].(map[string]any)
		kind := scope["kind"].(string)
		if kind == "worker" {
			item["association"] = nil
			return true
		}
		projectID := scope["projectId"].(string)
		taskID, _ := scope["taskId"].(string)
		if !monitoringScopeVisible(projectID, taskID, sources) {
			return false
		}
		name, ok := sources.Projects[projectID]
		if !ok {
			return false
		}
		var label any = map[string]any{"kind": "project", "projectName": name}
		if kind == "claim" {
			source := sources.Tasks[taskID]
			label = map[string]any{"kind": "task", "projectName": source.ProjectName, "title": source.Task.Title}
		}
		item["association"] = map[string]any{"kind": "labels-omitted"}
		labels = append(labels, pending{item, label})
		return true
	}
	restricted := false
	for _, key := range []string{"currentFailures", "reasons"} {
		var owner map[string]any = map[string]any(o)
		if key == "reasons" {
			owner = o["admission"].(map[string]any)
		}
		old := owner[key].([]any)
		kept := make([]any, 0, len(old))
		for _, raw := range old {
			item := raw.(map[string]any)
			if project(item) {
				kept = append(kept, item)
			} else {
				restricted = true
			}
		}
		owner[key] = kept
	}
	if raw := o["lastRecovery"]; raw != nil {
		if !project(raw.(map[string]any)) {
			o["lastRecovery"] = nil
			restricted = true
		}
	}
	for _, key := range []string{"reservations", "activities"} {
		old := o[key].([]any)
		kept := make([]any, 0, len(old))
		for _, raw := range old {
			item := raw.(map[string]any)
			if project(item) {
				kept = append(kept, item)
			} else {
				restricted = true
			}
		}
		o[key] = kept
	}
	if restricted {
		result.PermissionProjection = "restricted"
	}
	// Reserve space for the explicit partial flag before adding optional labels.
	result.DetailCoverage = "partial"
	o["detailCoverage"] = "partial"
	encoded, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("encode monitoring projection: %w", err)
	}
	// Both coverage fields may grow by one byte when complete is restored.
	used := len(encoded) + 1
	if originalCoverage == "complete" {
		used += 2
	}
	if used > monitoring.MaxDetail {
		return fmt.Errorf("monitoring projection exceeds response budget")
	}
	placeholder, err := json.Marshal(map[string]any{"kind": "labels-omitted"})
	if err != nil {
		return err
	}
	omitted := false
	for _, p := range labels {
		label, err := json.Marshal(p.label)
		if err != nil {
			return err
		}
		delta := len(label) - len(placeholder)
		if used+delta > monitoring.MaxDetail {
			omitted = true
			continue
		}
		p.item["association"] = p.label
		used += delta
	}
	if !omitted {
		result.DetailCoverage = originalCoverage
		o["detailCoverage"] = originalCoverage
	}
	return nil
}
