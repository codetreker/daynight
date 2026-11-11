package server

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type mcpStepsRejectedTaskReader struct{ t *testing.T }

func (d mcpStepsRejectedTaskReader) TaskBodies(context.Context, string, []string) ([]model.Task, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskBodies")
	panic("unreachable")
}
func (d mcpStepsRejectedTaskReader) GoalProgresses(context.Context, string, []string) (map[string]model.GoalProgress, error) {
	unexpectedHTTPCall(d.t, "TaskReader.GoalProgresses")
	panic("unreachable")
}
func (d mcpStepsRejectedTaskReader) Task(context.Context, string, string) (model.Task, error) {
	unexpectedHTTPCall(d.t, "TaskReader.Task")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) Tasks(context.Context, string, store.TaskQuery) (store.TaskPage, error) {
	unexpectedHTTPCall(d.t, "TaskReader.Tasks")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskListFence(context.Context, string) (store.TaskListFence, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskListFence")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskPriorityList(context.Context, string, store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskPriorityList")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskPresence(context.Context, string, string) (store.TaskPresence, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskPresence")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskHeader(context.Context, string, string) (model.TaskHeader, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskHeader")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskStep(context.Context, string, string) (model.TaskStep, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskStep")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskSteps(context.Context, string) ([]model.TaskStep, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskSteps")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskStepPage(context.Context, string, int64, int, bool) ([]store.TaskStepProjection, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskStepPage")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskStepSummary(context.Context, string, string) (store.TaskStepProjection, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskStepSummary")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) ThreadMessage(context.Context, string, string) (model.ThreadMessage, error) {
	unexpectedHTTPCall(d.t, "TaskReader.ThreadMessage")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) ThreadCandidates(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error) {
	unexpectedHTTPCall(d.t, "TaskReader.ThreadCandidates")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) ThreadSides(context.Context, string, model.ThreadPosition, model.ThreadPosition) (bool, bool, error) {
	unexpectedHTTPCall(d.t, "TaskReader.ThreadSides")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskAssignees(context.Context, string) ([]model.TaskAssigneeFact, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskAssignees")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) ResolveTaskAssignees(context.Context, string, []string) ([]model.TaskAssigneeFact, error) {
	unexpectedHTTPCall(d.t, "TaskReader.ResolveTaskAssignees")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskGraphTasks(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskGraphTasks")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskCacheEpoch(context.Context, string) (string, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskCacheEpoch")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskSyncTasks(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskSyncTasks")
	panic("unreachable")
}

type mcpStepsRejectedProjectReader struct{ t *testing.T }

func (d mcpStepsRejectedProjectReader) Project(context.Context, string) (model.Project, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.Project")
	panic("unreachable")
}

func (d mcpStepsRejectedProjectReader) Projects(context.Context, store.Page) (store.ProjectPage, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.Projects")
	panic("unreachable")
}

func (d mcpStepsRejectedProjectReader) DirectProjectMember(context.Context, string, string) (model.ProjectMember, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.DirectProjectMember")
	panic("unreachable")
}

func (d mcpStepsRejectedProjectReader) ProjectParticipants(context.Context, string) ([]model.ProjectParticipant, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.ProjectParticipants")
	panic("unreachable")
}

func (d mcpStepsRejectedProjectReader) Invitation(context.Context, []byte) (model.ProjectInvitation, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.Invitation")
	panic("unreachable")
}

func (d mcpStepsRejectedProjectReader) Invitations(context.Context, string, time.Time) ([]model.ProjectInvitation, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.Invitations")
	panic("unreachable")
}

func (d mcpStepsRejectedProjectReader) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.ProjectAccess")
	panic("unreachable")
}

func (d mcpStepsRejectedProjectReader) AccessibleProjects(context.Context, model.Principal, store.Page) (store.ProjectPage, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.AccessibleProjects")
	panic("unreachable")
}

func (d mcpStepsRejectedProjectReader) ScopedProjects(context.Context, model.Principal, store.ProjectScope, store.Page) (store.ProjectPage, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.ScopedProjects")
	panic("unreachable")
}

func (d mcpStepsRejectedProjectReader) TransferTeam(context.Context, string) (store.TransferTeam, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.TransferTeam")
	panic("unreachable")
}

func (d mcpStepsRejectedProjectReader) TransferRole(context.Context, string, string, string) (*model.ProjectRole, error) {
	unexpectedHTTPCall(d.t, "ProjectReader.TransferRole")
	panic("unreachable")
}

type mcpStepsRejectedWebhookCaptureDAO struct{ t *testing.T }

func (d mcpStepsRejectedWebhookCaptureDAO) FreezeAudience(context.Context, string, []string) ([]store.WebhookAudience, error) {
	unexpectedHTTPCall(d.t, "WebhookCaptureDAO.FreezeAudience")
	panic("unreachable")
}

func (d mcpStepsRejectedWebhookCaptureDAO) RecordedAt(context.Context) (time.Time, error) {
	unexpectedHTTPCall(d.t, "WebhookCaptureDAO.RecordedAt")
	panic("unreachable")
}

func (d mcpStepsRejectedWebhookCaptureDAO) Policy(context.Context, int64) (webhook.Policy, error) {
	unexpectedHTTPCall(d.t, "WebhookCaptureDAO.Policy")
	panic("unreachable")
}

func (d mcpStepsRejectedWebhookCaptureDAO) SaveCapture(context.Context, store.WebhookCapturedEvent, []store.WebhookCapturedDelivery) error {
	unexpectedHTTPCall(d.t, "WebhookCaptureDAO.SaveCapture")
	panic("unreachable")
}

func (d mcpStepsRejectedTaskReader) TaskWorkGroups(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskWorkGroups")
	panic("unreachable")
}
func (d mcpStepsRejectedTaskReader) TaskWorkTargets(context.Context, string, []string, *store.TaskWorkTargetPosition, int) (store.TaskWorkTargets, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskWorkTargets")
	panic("unreachable")
}
