package task_test

import (
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func TestTaskHTTPCancellationPreservesReadableMaterialsAndSatisfiesDependencies(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	predecessor := createHTTPTask(t, handler, project.ID, "Unfinished predecessor")
	task := createHTTPTask(t, handler, project.ID, "Cancelled search target", predecessor.ID)
	task = updateHTTPTask(t, handler, task, map[string]any{
		"allowAgents": true, "requiredPlatform": "linux", "assignedTo": handler.principal.UserID,
		"properties": api.TaskWritableProperties{"pullRequests": rawProperty(t, []api.PullRequestProperty{{URL: "https://example.test/pr/1", Title: "Retained result"}})},
	})
	other := createHTTPTask(t, handler, project.ID, "Other prerequisite")
	external := setHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "External cancelled prerequisite"), "cancelled")
	follower := createHTTPTask(t, handler, project.ID, "Follower", task.ID, other.ID, external.ID)
	follower = updateHTTPTask(t, handler, follower, map[string]any{"externalDependsOn": []string{external.ID}})
	seedHTTPStep(t, database, task.ID, "abcdef01", 0, "Retained step", "Step material")
	stepBefore := decodeResponse[api.StepsResource](t, projectRequest(handler, http.MethodGet, taskPath(task)+"/steps", ""), http.StatusOK)
	message := decodeResponse[api.ThreadMessage](t, projectRequest(handler, http.MethodPost, threadPath(task), `{"body":"Retained discussion"}`), http.StatusCreated)
	attachmentPath := taskPath(task) + "/attachments/files/retained.txt"
	decodeResponse[api.Attachment](t, projectRequest(handler, http.MethodPut, attachmentPath, "Original attachment bytes"), http.StatusCreated)
	beforeSync := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusOK)
	before := readHTTPTask(t, handler, task)
	if before.Ready || !slices.Equal(before.BlockedBy, []string{predecessor.ID}) {
		t.Fatalf("fixture must be blocked: %+v", before)
	}
	response := projectRequest(handler, http.MethodPut, taskPath(task)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: before.Version, Status: "cancelled"}))
	cancelled := decodeResponse[api.Task](t, response, http.StatusOK)
	if cancelled.Status != "cancelled" || cancelled.Ready || cancelled.CancelledAt == nil || cancelled.CancelledAt.Location() != time.UTC ||
		!cancelled.CancelledAt.Equal(cancelled.UpdatedAt) || cancelled.Version != before.Version+1 {
		t.Fatalf("cancelled response does not expose committed terminal timing: %+v", cancelled)
	}
	comparable := cancelled
	comparable.Status, comparable.Version, comparable.UpdatedAt, comparable.CancelledAt = before.Status, before.Version, before.UpdatedAt, before.CancelledAt
	if !reflect.DeepEqual(comparable, before) {
		t.Fatalf("cancellation changed unrelated materials: before=%+v after=%+v", before, cancelled)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields["cancelledAt"]) == 0 {
		t.Fatalf("cancelledAt omitted from wire: %s %v", response.Body, err)
	}
	if !reflect.DeepEqual(setHTTPTask(t, handler, cancelled, "cancelled"), cancelled) {
		t.Fatal("same-state cancellation changed terminal timing")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPut, taskPath(task)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: before.Version, Status: "cancelled"})), http.StatusConflict, "version_conflict")
	for _, status := range []string{"todo", "in_progress", "done"} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, taskPath(task)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: cancelled.Version, Status: status})), http.StatusConflict, "invalid_transition")
	}
	stepAfter := decodeResponse[api.StepsResource](t, projectRequest(handler, http.MethodGet, taskPath(task)+"/steps", ""), http.StatusOK)
	if !reflect.DeepEqual(stepAfter.Steps, stepBefore.Steps) || stepAfter.Version != cancelled.Version {
		t.Fatal("cancelled Steps became unreadable or changed")
	}
	thread := decodeResponse[api.ThreadPage](t, projectRequest(handler, http.MethodGet, threadPath(task), ""), http.StatusOK)
	if len(thread.Items) != 1 || !reflect.DeepEqual(thread.Items[0], message) {
		t.Fatal("cancelled discussion became unreadable or changed")
	}
	attachment := projectRequest(handler, http.MethodGet, attachmentPath, "")
	if attachment.Code != http.StatusOK || attachment.Body.String() != "Original attachment bytes" {
		t.Fatalf("cancelled attachment differs: %d %s", attachment.Code, attachment.Body)
	}
	afterFollower := readHTTPTask(t, handler, follower)
	if afterFollower.Version != follower.Version || afterFollower.Ready || !slices.Equal(afterFollower.BlockedBy, []string{other.ID}) || !slices.Equal(afterFollower.DependsOn, follower.DependsOn) {
		t.Fatalf("mixed dependencies did not keep the remaining blocker: %+v", afterFollower)
	}
	other = setHTTPTask(t, handler, other, "done")
	afterFollower = readHTTPTask(t, handler, follower)
	if !afterFollower.Ready || len(afterFollower.BlockedBy) != 0 || afterFollower.Version != follower.Version {
		t.Fatalf("terminal ordinary/external prerequisites did not allow follower: %+v", afterFollower)
	}
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(project.ID, task.ID), ""), http.StatusOK)
	if graph.Summary.Total != 5 || graph.Summary.Cancelled != 2 || graph.Summary.Done != 1 || graph.Summary.Todo != 2 || graph.Summary.Ready != 2 || graph.Summary.Blocked != 0 {
		t.Fatalf("cancellation graph summary: %+v", graph.Summary)
	}
	for _, node := range graph.Tasks {
		if node.ID == task.ID && (!reflect.DeepEqual(node.CancelledAt, cancelled.CancelledAt) || !slices.Equal(node.DependsOn, before.DependsOn)) {
			t.Fatalf("graph lost cancellation time or dependencies: %+v", node)
		}
	}
	afterSync := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID)+"?epoch="+beforeSync.Epoch, ""), http.StatusOK)
	if afterSync.Epoch != beforeSync.Epoch {
		t.Fatal("cancellation rotated the deletion epoch")
	}
	for _, record := range afterSync.Tasks {
		if record.ID == task.ID && (!reflect.DeepEqual(record.CancelledAt, cancelled.CancelledAt) || record.Status != "cancelled") {
			t.Fatalf("sync lost cancellation contract: %+v", record)
		}
	}
	search := decodeResponse[api.TaskSearchPage](t, projectRequest(handler, http.MethodPost, taskCollection(project.ID)+"/search", `{"query":"Cancelled search target","status":"cancelled"}`), http.StatusOK)
	if len(search.Items) != 1 || search.Items[0].ID != task.ID || !reflect.DeepEqual(search.Items[0].CancelledAt, cancelled.CancelledAt) {
		t.Fatalf("cancelled search filter/timestamp: %+v", search)
	}
}

func TestTaskHTTPCancellationPreservesCompletedIntervalAndReleasedWorkerHistory(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	completed := setHTTPTask(t, handler, setHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Completed interval"), "in_progress"), "done")
	follower := setHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Started follower", completed.ID), "in_progress")
	cancelled := setHTTPTask(t, handler, completed, "cancelled")
	if cancelled.CancelledAt == nil || !reflect.DeepEqual(cancelled.StartedAt, completed.StartedAt) || !reflect.DeepEqual(cancelled.CompletedAt, completed.CompletedAt) {
		t.Fatal("done cancellation replaced the execution interval")
	}
	stamp := *cancelled.CancelledAt
	cancelled = updateHTTPTask(t, handler, cancelled, map[string]any{"description": "Readable edited cancellation"})
	if !cancelled.CancelledAt.Equal(stamp) || !reflect.DeepEqual(cancelled.StartedAt, completed.StartedAt) || !reflect.DeepEqual(cancelled.CompletedAt, completed.CompletedAt) {
		t.Fatal("cancelled metadata edit changed retained terminal timing")
	}
	if got := readHTTPTask(t, handler, follower); !reflect.DeepEqual(got, follower) {
		t.Fatal("done cancellation changed an already started follower")
	}
	workerTask := updateHTTPTask(t, handler, createHTTPWorkerTask(t, handler, project.ID, "Released cancellation"), map[string]any{"allowAgents": true})
	workerTask = claimHTTPWorker(t, handler, workerTask, workerClaimBody(workerTask.Version))
	claim := apiWorker(t, workerTask.Properties).ClaimID
	assertProjectError(t, projectRequest(handler, http.MethodPut, taskPath(workerTask)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: workerTask.Version, Status: "cancelled"})), http.StatusConflict, "invalid_transition")
	if !reflect.DeepEqual(readHTTPTask(t, handler, workerTask), workerTask) {
		t.Fatal("active cancellation altered Worker ownership")
	}
	released := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(workerTask)+"/worker-claim/release", jsonBody(t, map[string]any{"version": workerTask.Version, "claimId": claim, "stoppedConfirmed": true})), http.StatusOK)
	cancelled = setHTTPTask(t, handler, released, "cancelled")
	if !reflect.DeepEqual(cancelled.Properties, released.Properties) || apiWorker(t, cancelled.Properties).State != "released" {
		t.Fatal("released cancellation rewrote the retained execution history")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(cancelled)+"/worker-claim/withdraw", jsonBody(t, map[string]any{"version": cancelled.Version, "claimId": claim})), http.StatusConflict, "invalid_transition")
	resume := workerClaimBody(cancelled.Version)
	resume["previousClaimId"], resume["claimId"], resume["worktreeId"] = claim, uuid.NewString(), uuid.NewString()
	assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(cancelled)+"/worker-claim/resume", jsonBody(t, resume)), http.StatusConflict, "invalid_transition")
	if !reflect.DeepEqual(readHTTPTask(t, handler, cancelled), cancelled) {
		t.Fatal("refused cancelled Worker recovery changed persistent history")
	}
}
