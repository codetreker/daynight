package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
)

const (
	monitorUser    = "10000000-0000-4000-8000-000000000001"
	monitorWorker  = "10000000-0000-4000-8000-000000000002"
	monitorProject = "10000000-0000-4000-8000-000000000003"
	monitorTask    = "10000000-0000-4000-8000-000000000004"
	monitorClaim   = "10000000-0000-4000-8000-000000000005"
)

func monitorScope(project, task, claim string) map[string]any {
	return map[string]any{"kind": "claim", "projectId": project, "taskId": task, "claimId": claim}
}
func monitorObservation() monitoring.Observation {
	return monitoring.Observation{"admission": map[string]any{"reasons": []any{}}, "activities": []any{}, "reservations": []any{}, "currentFailures": []any{}, "lastRecovery": nil, "detailCoverage": "complete", "capacity": map[string]any{"limit": int64(2), "occupied": int64(2), "available": int64(0)}}
}
func monitorTaskSource(t *testing.T, status model.TaskStatus, state model.WorkerState, workerID, claimID string) store.WorkerTaskSource {
	t.Helper()
	claim := model.WorkerClaim{ClaimID: claimID, State: state, UserID: monitorUser, WorkerID: workerID, Machine: model.WorkerMachine{ID: monitorWorker, Name: "host"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: monitorWorker, Phase: model.WorkerExecuting, ClaimedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	props, err := properties.WithWorker(nil, &claim)
	if err != nil {
		t.Fatal(err)
	}
	return store.WorkerTaskSource{Task: model.Task{ID: monitorTask, ProjectID: monitorProject, Status: status, Title: "Visible", Properties: props}, ProjectName: "Visible Project"}
}
func TestMonitoringExecutionAdmissionAndCleanup(t *testing.T) {
	source := monitorTaskSource(t, model.TaskInProgress, model.WorkerActive, monitorWorker, monitorClaim)
	scopes := map[string]any{"kind": "execution", "scope": monitorScope(monitorProject, monitorTask, monitorClaim)}
	for _, tc := range []struct {
		name   string
		source store.WorkerTaskSource
		exists bool
		scope  map[string]any
		kind   string
		code   string
	}{
		{"active", source, true, scopes["scope"].(map[string]any), "execution", ""},
		{"missing", source, false, scopes["scope"].(map[string]any), "execution", "not_found"},
		{"project mismatch", source, true, monitorScope("20000000-0000-4000-8000-000000000001", monitorTask, monitorClaim), "execution", "not_found"},
		{"old claim", monitorTaskSource(t, model.TaskInProgress, model.WorkerActive, monitorWorker, "20000000-0000-4000-8000-000000000002"), true, scopes["scope"].(map[string]any), "execution", "invalid_input"},
		{"wrong worker", monitorTaskSource(t, model.TaskInProgress, model.WorkerActive, "20000000-0000-4000-8000-000000000003", monitorClaim), true, scopes["scope"].(map[string]any), "execution", "invalid_input"},
		{"completed", monitorTaskSource(t, model.TaskDone, model.WorkerCompleted, monitorWorker, monitorClaim), true, scopes["scope"].(map[string]any), "execution", "invalid_input"},
		{"cleanup after completion", monitorTaskSource(t, model.TaskDone, model.WorkerCompleted, monitorWorker, monitorClaim), true, scopes["scope"].(map[string]any), "cleanup", ""},
		{"cleanup after revocation", source, false, scopes["scope"].(map[string]any), "cleanup", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := monitorObservation()
			o["activities"] = []any{map[string]any{"kind": tc.kind, "scope": tc.scope}}
			sources := store.WorkerMonitoringSources{Tasks: map[string]store.WorkerTaskSource{}}
			if tc.exists {
				sources.Tasks[monitorTask] = tc.source
			}
			err := ValidateMonitoringExecution(o, sources, monitorUser, monitorWorker)
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				requireFault(t, err, tc.code)
			}
		})
	}
	bad := source
	bad.Task.Properties = model.TaskProperties{"worker": json.RawMessage(`false`)}
	o := monitorObservation()
	o["activities"] = []any{scopes}
	if err := ValidateMonitoringExecution(o, store.WorkerMonitoringSources{Tasks: map[string]store.WorkerTaskSource{monitorTask: bad}}, monitorUser, monitorWorker); err == nil || strings.Contains(err.Error(), "Execution monitoring must refer") {
		t.Fatalf("corrupt claim must not be a normal refusal: %v", err)
	}
}
func TestMonitoringProjectionRevokedAndCompletedCleanup(t *testing.T) {
	hiddenProject := "20000000-0000-4000-8000-000000000001"
	hiddenTask := "20000000-0000-4000-8000-000000000002"
	hiddenClaim := "20000000-0000-4000-8000-000000000003"
	visible := monitorScope(monitorProject, monitorTask, monitorClaim)
	hidden := monitorScope(hiddenProject, hiddenTask, hiddenClaim)
	o := monitorObservation()
	o["admission"].(map[string]any)["reasons"] = []any{map[string]any{"code": "cleanup-capacity-blocked", "scope": map[string]any{"kind": "worker"}}, map[string]any{"code": "project-unavailable", "scope": hidden}}
	o["activities"] = []any{map[string]any{"kind": "cleanup", "scope": visible}, map[string]any{"kind": "cleanup", "scope": hidden}}
	o["reservations"] = []any{map[string]any{"scope": hidden, "reservationId": "private reservation"}}
	o["currentFailures"] = []any{map[string]any{"scope": hidden, "error": "private cause"}}
	o["lastRecovery"] = map[string]any{"scope": hidden, "explanation": "private recovery"}
	source := monitorTaskSource(t, model.TaskDone, model.WorkerCompleted, monitorWorker, "20000000-0000-4000-8000-000000000004")
	result := monitoring.DetailResponse{State: "available", Data: o, DetailCoverage: "complete", PermissionProjection: "current"}
	if err := ProjectMonitoring(&result, store.WorkerMonitoringSources{Projects: map[string]string{monitorProject: "Visible Project"}, Tasks: map[string]store.WorkerTaskSource{monitorTask: source}}); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{hiddenProject, hiddenTask, hiddenClaim, "private reservation", "private cause", "private recovery"} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("private data leaked: %s", b)
		}
	}
	if result.PermissionProjection != "restricted" || o["capacity"].(map[string]any)["occupied"] != int64(2) {
		t.Fatalf("wrong projection %s", b)
	}
	reasons := o["admission"].(map[string]any)["reasons"].([]any)
	if len(reasons) != 1 || reasons[0].(map[string]any)["association"] != nil {
		t.Fatalf("global blocker %v", reasons)
	}
	activities := o["activities"].([]any)
	if len(activities) != 1 || activities[0].(map[string]any)["association"].(map[string]any)["title"] != "Visible" {
		t.Fatalf("completed cleanup: %v", activities)
	}
	if len(o["reservations"].([]any)) != 0 || len(o["currentFailures"].([]any)) != 0 || o["lastRecovery"] != nil {
		t.Fatalf("hidden details retained: %s", b)
	}
}
func TestMonitoringProjectionActualEscapedBudget(t *testing.T) {
	raw := []byte(fmt.Sprintf(`{"runId":%q,"sequence":"1","capturedAt":"2026-01-01T00:00:00Z","lifecycle":"running","scheduler":{"phase":"waiting-poll","coverage":"complete","cycleId":null,"lastCompletedAt":null,"lastSuccessfulAt":null,"lastOutcome":null,"nextPollAt":null},"capacity":{"observedAt":"2026-01-01T00:00:00Z","quality":"current","limit":2,"occupied":2,"available":0,"detailCoverage":"complete"},"admission":{"observedAt":"2026-01-01T00:00:00Z","coverage":"complete","reasons":[]},"reservations":[],"activities":[],"currentFailures":[],"lastRecovery":null,"detailCoverage":"complete","delivery":{"lastSucceededAt":null,"lastFailure":null}}`, monitorClaim))
	o, err := monitoring.ParseObservation(raw)
	if err != nil {
		t.Fatal(err)
	}
	sources := store.WorkerMonitoringSources{Projects: map[string]string{monitorProject: "Project"}, Tasks: map[string]store.WorkerTaskSource{}}
	activities := make([]any, 0, 128)
	for i := 0; i < 128; i++ {
		id := fmt.Sprintf("30000000-0000-4000-8000-%012x", i+1)
		sources.Tasks[id] = store.WorkerTaskSource{Task: model.Task{ID: id, ProjectID: monitorProject, Title: strings.Repeat("<", 1024)}, ProjectName: "Project"}
		activities = append(activities, map[string]any{"kind": "cleanup", "phase": "worktree-removal", "operationId": id, "status": "running", "scope": monitorScope(monitorProject, id, monitorClaim), "startedAt": "2026-01-01T00:00:00Z", "lastProgressAt": nil, "elapsedMs": int64(0), "deadlineAt": nil, "waitReason": nil, "nextAttemptAt": nil})
	}
	o["activities"] = activities
	o["currentFailures"] = []any{map[string]any{"operationId": monitorClaim, "component": "cleanup", "phase": "worktree-removal", "scope": activities[0].(map[string]any)["scope"], "error": map[string]any{"type": "operation", "code": "unknown", "cause": "The operation failed; inspect local Worker diagnostics for details.", "causeTruncated": false}, "firstObservedAt": "2026-01-01T00:00:00Z", "lastObservedAt": "2026-01-01T00:00:00Z", "occurrencesInRun": int64(1), "retryState": "none", "nextAttemptAt": nil}}
	raw, err = json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	o, err = monitoring.ParseObservation(raw)
	if err != nil {
		t.Fatalf("complete input is not legal: %v", err)
	}
	activities = o["activities"].([]any)
	result := monitoring.DetailResponse{State: "available", Data: o, DetailCoverage: "complete", PermissionProjection: "current"}
	if err := ProjectMonitoring(&result, sources); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if len(b)+1 > monitoring.MaxDetail {
		t.Fatalf("budget exceeded: %d", len(b)+1)
	}
	omitted, complete := 0, 0
	for _, a := range activities {
		kind := a.(map[string]any)["association"].(map[string]any)["kind"]
		if kind == "labels-omitted" {
			omitted++
		} else if kind == "task" {
			complete++
		}
	}
	if omitted == 0 || complete == 0 || result.DetailCoverage != "partial" || o["detailCoverage"] != "partial" {
		t.Fatalf("budget partial=%d full=%d coverage=%s bytes=%d", omitted, complete, result.DetailCoverage, len(b)+1)
	}
	if o["currentFailures"].([]any)[0].(map[string]any)["association"].(map[string]any)["kind"] != "task" {
		t.Fatal("failure label was not prioritized")
	}
	t.Logf("legal normalized input: %d bytes; encoded detail: %d bytes; %d labels omitted", len(raw), len(b)+1, omitted)
}

func TestMonitoringScopesUsesEveryAssociationAndDeduplicates(t *testing.T) {
	const projectOnly = "20000000-0000-4000-8000-000000000001"
	const observed = "2026-01-01T00:00:00Z"
	base := fmt.Sprintf(`{"runId":%q,"sequence":"1","capturedAt":%q,"lifecycle":"running","scheduler":{"phase":"waiting-poll","coverage":"complete","cycleId":null,"lastCompletedAt":null,"lastSuccessfulAt":null,"lastOutcome":null,"nextPollAt":null},"capacity":null,"admission":{"observedAt":%q,"coverage":"complete","reasons":[]},"reservations":[],"activities":[],"currentFailures":[],"lastRecovery":null,"detailCoverage":"complete","delivery":{"lastSucceededAt":null,"lastFailure":null}}`, monitorClaim, observed, observed)
	parse := func(raw string) monitoring.Observation {
		t.Helper()
		o, err := monitoring.ParseObservation([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		return o
	}
	item := func(raw string) any {
		t.Helper()
		var result any
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	projectScope := fmt.Sprintf(`{"kind":"project","projectId":%q}`, projectOnly)
	claimScope := fmt.Sprintf(`{"kind":"claim","projectId":%q,"taskId":%q,"claimId":%q}`, monitorProject, monitorTask, monitorClaim)
	workerScope := `{"kind":"worker"}`
	reason := item(fmt.Sprintf(`{"code":"project-unavailable","scope":%s,"observedAt":%q,"nextAttemptAt":null}`, projectScope, observed))
	reservation := item(fmt.Sprintf(`{"reservationId":%q,"scope":%s,"roles":["cleanup"],"occupied":true,"observedAt":%q}`, monitorWorker, claimScope, observed))
	activity := item(fmt.Sprintf(`{"kind":"cleanup","phase":"archive","operationId":%q,"status":"running","scope":%s,"startedAt":%q,"lastProgressAt":null,"elapsedMs":0,"deadlineAt":null,"waitReason":null,"nextAttemptAt":null}`, monitorClaim, claimScope, observed))
	failure := item(fmt.Sprintf(`{"operationId":%q,"component":"project","phase":"project-preparation","scope":%s,"error":{"type":"operation","code":"unknown","cause":"The operation failed; inspect local Worker diagnostics for details.","causeTruncated":false},"firstObservedAt":%q,"lastObservedAt":%q,"occurrencesInRun":1,"retryState":"none","nextAttemptAt":null}`, monitorClaim, projectScope, observed, observed))
	recovery := item(fmt.Sprintf(`{"operationId":%q,"component":"cleanup","scope":%s,"observedAt":%q,"explanation":"The operation recovered.","explanationTruncated":false}`, monitorClaim, claimScope, observed))
	workerReason := item(fmt.Sprintf(`{"code":"cleanup-capacity-blocked","scope":%s,"observedAt":%q,"nextAttemptAt":null}`, workerScope, observed))
	cases := []struct {
		name, key       string
		value           any
		projects, tasks []string
	}{
		{"reason", "reasons", reason, []string{projectOnly}, nil},
		{"reservation", "reservations", reservation, []string{monitorProject}, []string{monitorTask}},
		{"activity", "activities", activity, []string{monitorProject}, []string{monitorTask}},
		{"failure", "currentFailures", failure, []string{projectOnly}, nil},
		{"recovery", "lastRecovery", recovery, []string{monitorProject}, []string{monitorTask}},
		{"worker scope", "reasons", workerReason, nil, nil},
		{"no associations", "", nil, nil, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := parse(base)
			switch tc.key {
			case "reasons":
				o["admission"].(map[string]any)["reasons"] = []any{tc.value}
			case "lastRecovery":
				o[tc.key] = tc.value
			case "":
			default:
				o[tc.key] = []any{tc.value}
			}
			raw, err := json.Marshal(o)
			if err != nil {
				t.Fatal(err)
			}
			o = parse(string(raw))
			projects, tasks := MonitoringScopes(o)
			if !sameMonitoringIDs(projects, tc.projects) || !sameMonitoringIDs(tasks, tc.tasks) {
				t.Fatalf("got projects %v tasks %v; want %v %v", projects, tasks, tc.projects, tc.tasks)
			}
		})
	}
	o := parse(base)
	o["admission"].(map[string]any)["reasons"] = []any{reason, workerReason}
	o["reservations"] = []any{reservation}
	o["activities"] = []any{activity}
	o["currentFailures"] = []any{failure}
	o["lastRecovery"] = recovery
	raw, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	o = parse(string(raw))
	projects, tasks := MonitoringScopes(o)
	if !sameMonitoringIDs(projects, []string{monitorProject, projectOnly}) || !sameMonitoringIDs(tasks, []string{monitorTask}) {
		t.Fatalf("deduplicated IDs projects %v tasks %v", projects, tasks)
	}
}

func sameMonitoringIDs(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	counts := make(map[string]int, len(got))
	for _, id := range got {
		counts[id]++
	}
	for _, id := range want {
		counts[id]--
		if counts[id] < 0 {
			return false
		}
	}
	return true
}
