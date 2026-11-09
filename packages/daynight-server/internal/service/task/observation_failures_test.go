package task

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestObservedListSuppressesResultsAfterReadAndSnapshotFailures(t *testing.T) {
	for _, stage := range []string{"anonymous", "invalid query", "credentials", "core error", "core refusal", "cursor encoding", "snapshot clock", "snapshot completion", "fresh credentials"} {
		t.Run(stage, func(t *testing.T) {
			service, _, observer, database := workServiceFixture(t)
			principal := observationActor()
			input := TaskListRequest{PageRequest: model.PageRequest{Limit: 1}}
			failure := errors.New("selected read failed")
			refusal := &model.Fault{Code: "forbidden", Message: "Project membership revoked."}
			selected := observationTask()
			listCalls, authCalls := 0, 0
			service.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error {
				authCalls++
				if stage == "credentials" || stage == "fresh credentials" && authCalls == 2 {
					return refusal
				}
				return nil
			}
			service.operations.list = func(context.Context, taskcore.ReadDAO, string, taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
				listCalls++
				if stage == "core error" {
					return store.TaskPage{}, nil, failure
				}
				if stage == "core refusal" {
					return store.TaskPage{}, refusal, nil
				}
				return store.TaskPage{Items: []model.Task{selected}, HasMore: stage == "cursor encoding"}, nil, nil
			}
			switch stage {
			case "anonymous":
				principal = model.Principal{}
			case "invalid query":
				input.Limit = 1000
			case "cursor encoding":
				selected.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
			case "snapshot clock":
				snapshot := database.snapshot.(workServiceSnapshot)
				snapshot.clockErr = failure
				database.snapshot = snapshot
			case "snapshot completion":
				database.completion = failure
			}
			result, err := service.ObserveList(t.Context(), principal, workProject, input)
			if err == nil || result.Items != nil || result.NextCursor != nil {
				t.Fatalf("published failed list: %#v %v", result, err)
			}
			expectedListCalls := 1
			if stage == "anonymous" || stage == "invalid query" || stage == "credentials" {
				expectedListCalls = 0
			}
			expectedObserverCalls := 0
			if stage == "fresh credentials" {
				expectedObserverCalls = 1
			}
			if listCalls != expectedListCalls || observer.calls != expectedObserverCalls {
				t.Fatalf("operations continued after %s: list=%d observer=%d", stage, listCalls, observer.calls)
			}
			switch stage {
			case "credentials", "core refusal", "fresh credentials":
				if !errors.Is(err, refusal) {
					t.Fatalf("authorization refusal lost: %v", err)
				}
			case "core error", "snapshot clock", "snapshot completion":
				if !errors.Is(err, failure) {
					t.Fatalf("read failure cause lost: %v", err)
				}
			case "cursor encoding":
				var encoding *json.MarshalerError
				if !errors.As(err, &encoding) {
					t.Fatalf("cursor encoding cause lost: %v", err)
				}
			}
		})
	}
}

func TestObservedMCPListSuppressesFailedSelectionExpansionAndRecheck(t *testing.T) {
	for _, stage := range []string{"anonymous", "list error", "full error", "full refusal", "cursor encoding", "snapshot clock", "fresh credentials"} {
		t.Run(stage, func(t *testing.T) {
			service, _, observer, database := workServiceFixture(t)
			principal := observationActor()
			input := taskcore.MCPListRequest{Limit: 1, View: "summary"}
			failure := errors.New("MCP selection failed")
			refusal := &model.Fault{Code: "not_found", Message: "The selected Task is no longer accessible."}
			selected := observationTask()
			listCalls, fullCalls, authCalls := 0, 0, 0
			service.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error {
				authCalls++
				if stage == "fresh credentials" && authCalls == 2 {
					return refusal
				}
				return nil
			}
			service.operations.mcpList = func(context.Context, taskcore.MCPListReader, string, taskcore.MCPListSelection) (taskcore.MCPListPage, error) {
				listCalls++
				if stage == "list error" {
					return taskcore.MCPListPage{}, failure
				}
				return taskcore.MCPListPage{Items: []store.TaskPriorityItem{{Task: selected}}, HasMore: stage == "cursor encoding"}, nil
			}
			service.operations.task = func(_ context.Context, _ taskcore.ReadDAO, project, id string) (model.Task, *model.Fault, error) {
				fullCalls++
				if project != workProject || id != selected.ID {
					t.Fatal("full expansion changed selection")
				}
				if stage == "full error" {
					return model.Task{}, nil, failure
				}
				if stage == "full refusal" {
					return model.Task{}, refusal, nil
				}
				t.Fatal("unexpected full expansion")
				return model.Task{}, nil, nil
			}
			switch stage {
			case "anonymous":
				principal = model.Principal{}
			case "full error", "full refusal":
				input.View = "full"
			case "cursor encoding":
				selected.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
			case "snapshot clock":
				snapshot := database.snapshot.(workServiceSnapshot)
				snapshot.clockErr = failure
				database.snapshot = snapshot
			}
			result, err := service.ObservedMCPList(t.Context(), principal, workProject, input)
			if err == nil || result.Items != nil || result.NextCursor != nil {
				t.Fatalf("published failed MCP list: %#v %v", result, err)
			}
			expectedListCalls, expectedFullCalls, expectedObserverCalls := 1, 0, 0
			if stage == "anonymous" {
				expectedListCalls = 0
			}
			if input.View == "full" {
				expectedFullCalls = 1
			}
			if stage == "fresh credentials" {
				expectedObserverCalls = 1
			}
			if listCalls != expectedListCalls || fullCalls != expectedFullCalls || observer.calls != expectedObserverCalls {
				t.Fatalf("operations continued after %s: list=%d full=%d observer=%d", stage, listCalls, fullCalls, observer.calls)
			}
			switch stage {
			case "full refusal", "fresh credentials":
				if !errors.Is(err, refusal) {
					t.Fatalf("refusal lost: %v", err)
				}
			case "list error", "full error", "snapshot clock":
				if !errors.Is(err, failure) {
					t.Fatalf("read failure cause lost: %v", err)
				}
			case "cursor encoding":
				var encoding *json.MarshalerError
				if !errors.As(err, &encoding) {
					t.Fatalf("cursor encoding cause lost: %v", err)
				}
			}
		})
	}
}

func TestObservedListSourceFailuresPreserveTasksButNeverHideAuthorityOrCancellation(t *testing.T) {
	for _, stage := range []string{"source unavailable", "source authority refused", "cancelled"} {
		t.Run(stage, func(t *testing.T) {
			service, _, observer, database := workServiceFixture(t)
			selected := observationTask()
			var failure error = errors.New("private storage diagnostic")
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if stage == "source authority refused" {
				failure = &model.Fault{Code: "forbidden", Message: "Access revoked."}
			}
			if stage == "cancelled" {
				failure = context.Canceled
				cancel()
			}
			source := &observationBatchReader{t: t, fail: failure}
			snapshot := database.snapshot.(workServiceSnapshot)
			snapshot.sessions = source
			database.snapshot = snapshot
			service.operations.list = func(actual context.Context, _ taskcore.ReadDAO, project string, _ taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
				if actual != ctx || project != workProject {
					t.Fatal("selection lost request scope")
				}
				return store.TaskPage{Items: []model.Task{selected}}, nil, nil
			}
			result, err := service.ObserveList(ctx, observationActor(), workProject, TaskListRequest{PageRequest: model.PageRequest{Limit: 1}})
			if source.calls != 1 || observer.calls != 0 {
				t.Fatalf("failed source was retried or sampled: source=%d observer=%d", source.calls, observer.calls)
			}
			if stage != "source unavailable" {
				if !errors.Is(err, failure) || result.Items != nil {
					t.Fatalf("authority/cancellation was hidden: %#v %v", result, err)
				}
				return
			}
			if err != nil || !result.Partial || len(result.Items) != 1 || result.Items[0].Task.ID != selected.ID {
				t.Fatalf("source failure discarded Task: %#v %v", result, err)
			}
			observation := result.Items[0].Session
			if observation.Observation != "unavailable" || observation.Reason != "observation_unavailable" || observation.Send.Allowed != nil || observation.Error == nil || observation.Error.Message == failure.Error() {
				t.Fatalf("source failure became normal or leaked diagnostic: %#v", observation)
			}
		})
	}
}
