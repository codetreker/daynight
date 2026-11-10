package server

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"time"
)

func assertMCPUnstartedObservation(t *testing.T, item map[string]any) {
	t.Helper()
	observation, ok := item["session"].(map[string]any)
	if !ok || observation["observation"] != "observed" || observation["registration"] != "not_applicable" || observation["reason"] != "not_started" {
		t.Fatalf("unstarted Task observation: %#v", item)
	}
	send, ok := observation["send"].(map[string]any)
	if !ok || send["allowed"] != false || send["reason"] != "not_started" {
		t.Fatalf("unstarted Task send eligibility: %#v", observation)
	}
}

type mcpIsolationTasks struct {
	operationRejectedTasks
	ready func(context.Context, model.Principal, string, taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error)
}

func (o *mcpIsolationTasks) MCPReady(ctx context.Context, p model.Principal, project string, in taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error) {
	mcpOperationContext(o.t, ctx, p)
	if o.ready == nil {
		return o.operationRejectedTasks.MCPReady(ctx, p, project, in)
	}
	return o.ready(ctx, p, project, in)
}

type mcpIsolationObservations struct {
	operationRejectedTaskObservations
	list  func(context.Context, model.Principal, string, taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error)
	graph func(context.Context, model.Principal, string, string) (taskservice.ObservedGraph, error)
}

func (o *mcpIsolationObservations) ObservedMCPList(ctx context.Context, p model.Principal, project string, in taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error) {
	mcpOperationContext(o.t, ctx, p)
	if o.list == nil {
		return o.operationRejectedTaskObservations.ObservedMCPList(ctx, p, project, in)
	}
	return o.list(ctx, p, project, in)
}
func (o *mcpIsolationObservations) ObserveGraph(ctx context.Context, p model.Principal, project, id string) (taskservice.ObservedGraph, error) {
	mcpOperationContext(o.t, ctx, p)
	if o.graph == nil {
		return o.operationRejectedTaskObservations.ObserveGraph(ctx, p, project, id)
	}
	return o.graph(ctx, p, project, id)
}
func mcpIsolationTaskRead(t *testing.T, tasks *mcpIsolationTasks, observations *mcpIsolationObservations, p model.Principal, project model.Project, target model.Task, name, view string) {
	t.Helper()
	frozen := copyTaskHTTPTask(target)
	count := projectHTTPCount(t, 1)
	observation := func() sp.TaskSessionObservation {
		allowed := false
		at := target.UpdatedAt
		fresh := at.Add(30 * time.Second)
		return sp.TaskSessionObservation{SchemaVersion: 1, Observation: "observed", Registration: "not_applicable", Reason: "not_started", Send: sp.TaskSessionSend{Allowed: &allowed, Reason: "not_started"}, ObservedAt: &at, FreshUntil: &fresh}
	}
	if name == "task_ready" {
		tasks.ready = func(ctx context.Context, actor model.Principal, pid string, request taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error) {
			count()
			mcpAttachmentCheck(t, actor, p)
			mcpAttachmentCheck(t, pid, project.ID)
			mcpAttachmentCheck(t, request, taskcore.MCPReadyRequest{Limit: 5, View: view})
			row := copyTaskHTTPTask(frozen)
			if view != "full" {
				row.Description = ""
			}
			return []store.TaskPriorityItem{{Task: row}}, nil
		}
		return
	}
	if name == "task_list" {
		observations.list = func(ctx context.Context, actor model.Principal, pid string, request taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error) {
			count()
			mcpAttachmentCheck(t, actor, p)
			mcpAttachmentCheck(t, pid, project.ID)
			mcpAttachmentCheck(t, request, taskcore.MCPListRequest{Limit: 50, View: view})
			row := copyTaskHTTPTask(frozen)
			if view != "full" {
				row.Description = ""
			}
			return taskservice.ObservedMCPPage{Items: []taskservice.ObservedMCPItem{{Item: store.TaskPriorityItem{Task: row}, Session: observation()}}, ObservedAt: target.UpdatedAt}, nil
		}
		return
	}
	observations.graph = func(ctx context.Context, actor model.Principal, pid, id string) (taskservice.ObservedGraph, error) {
		count()
		mcpAttachmentCheck(t, actor, p)
		mcpAttachmentCheck(t, []string{pid, id}, []string{project.ID, target.ID})
		row := model.GraphTask{ID: frozen.ID, Version: frozen.Version, TitlePreview: frozen.Title, Status: frozen.Status, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: frozen.CreatedAt, UpdatedAt: frozen.UpdatedAt}
		return taskservice.ObservedGraph{Graph: model.TaskGraph{Project: project, ObservedAt: target.UpdatedAt, Summary: model.TaskGraphSummary{Total: 1, Todo: 1, Ready: 1}, Tasks: []model.GraphTask{row}}, Sessions: map[string]sp.TaskSessionObservation{target.ID: observation()}, Relations: map[string]string{target.ID: "member"}, Aggregation: taskwork.Aggregation{Complete: true, ObservedAt: target.UpdatedAt}, ObservedAt: target.UpdatedAt}, nil
	}
}

type mcpIsolationDownloads struct {
	operationRejectedDownloads
	call func(context.Context, mcptransfer.Actor, mcpdownload.Input, bool) (map[string]any, error)
}

func (o *mcpIsolationDownloads) Read(ctx context.Context, actor mcptransfer.Actor, in mcpdownload.Input) (map[string]any, error) {
	mcpOperationContext(o.t, ctx, actor.Principal)
	if o.call == nil {
		return o.operationRejectedDownloads.Read(ctx, actor, in)
	}
	return o.call(ctx, actor, in, false)
}
func (o *mcpIsolationDownloads) ReadAdmitted(ctx context.Context, actor mcptransfer.Actor, in mcpdownload.Input, admit func(context.Context) error) (map[string]any, error) {
	mcpOperationContext(o.t, ctx, actor.Principal)
	if o.call == nil {
		return o.operationRejectedDownloads.ReadAdmitted(ctx, actor, in, admit)
	}
	if admit == nil {
		o.t.Error("download omitted actual content admission")
		return nil, errors.New("content admission unavailable")
	}
	if err := admit(ctx); err != nil {
		return nil, err
	}
	return o.call(ctx, actor, in, true)
}
func (o *mcpIsolationDownloads) expect(actor mcptransfer.Actor, in mcpdownload.Input, result map[string]any, resultErr error) {
	o.t.Helper()
	count := projectHTTPCount(o.t, 1)
	frozen := cloneMCPUploadData(result)
	o.call = func(ctx context.Context, actual mcptransfer.Actor, input mcpdownload.Input, admitted bool) (map[string]any, error) {
		count()
		mcpAttachmentCheck(o.t, actual, actor)
		mcpAttachmentCheck(o.t, input, in)
		mcpAttachmentCheck(o.t, admitted, in.Action == "open")
		return cloneMCPUploadData(frozen), resultErr
	}
}

func mcpIsolationAttachment(item model.Attachment) map[string]any {
	return map[string]any{"path": item.Path, "contentType": item.ContentType, "sizeBytes": strconv.FormatInt(item.SizeBytes, 10), "createdAt": item.CreatedAt.UTC(), "updatedAt": item.UpdatedAt.UTC()}
}
