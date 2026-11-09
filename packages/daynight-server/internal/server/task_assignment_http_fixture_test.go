package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func assignmentHTTPAPI(t *testing.T, row model.Task) api.Task {
	t.Helper()
	result := platformHTTPAPI(row)
	if raw, exists := row.Properties["worker"]; exists {
		var stored map[string]json.RawMessage
		if err := json.Unmarshal(raw, &stored); err != nil {
			t.Fatal(err)
		}
		legacy := make(map[string]json.RawMessage, 13)
		for _, field := range []string{"claimId", "state", "userId", "workerId", "machine", "platform", "agent", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt"} {
			legacy[field] = stored[field]
		}
		result.Properties["worker"] = rawProperty(t, legacy)
	}
	return result
}

type assignmentHTTPProjectDAO struct {
	store.ProjectWriteDAO
	f      *taskHTTPFixture
	target string
	err    error
	plan   *httpCallPlan
}

func (d assignmentHTTPProjectDAO) ProjectAccess(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
	if principal == d.f.principal {
		return d.ProjectWriteDAO.ProjectAccess(ctx, principal)
	}
	d.f.require(ctx, d.f.project.ID)
	d.plan.Called("target")
	platformHTTPCheck(d.f.t, principal, model.Principal{UserID: d.target})
	return model.ProjectAccess{ProjectID: d.f.project.ID, UserID: d.target, Role: model.ProjectMemberRole}, d.err
}

type assignmentHTTPWriteScope struct {
	store.ProjectWriteScope
	project store.ProjectWriteDAO
}

func (s assignmentHTTPWriteScope) ProjectDAO() store.ProjectWriteDAO { return s.project }

func assignmentHTTPMutation(f *taskHTTPFixture, current *model.Task, values *store.TaskWrite, result *model.Task, dependencies []model.Task, validate bool, target *string, targetError error) {
	f.t.Helper()
	extended := &externalHTTPFixture{f}
	extended.mutation(current, values, result, dependencies, validate)
	if target == nil {
		return
	}
	plan := newHTTPCallPlan(f.t, map[string]int{"target": 1})
	write := f.store.WriteProjectCall
	f.store.WriteProjectCall = func(ctx context.Context, project string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		return write(ctx, project, func(scope store.ProjectWriteScope) error {
			dao := assignmentHTTPProjectDAO{ProjectWriteDAO: scope.ProjectDAO(), f: f, target: *target, err: targetError, plan: plan}
			return run(assignmentHTTPWriteScope{ProjectWriteScope: scope, project: dao})
		})
	}
}

func assignmentHTTPCreate(f *taskHTTPFixture, declared model.Task, body string, dependencies []model.Task) (model.Task, *httptest.ResponseRecorder) {
	f.t.Helper()
	declared = copyTaskHTTPTask(declared)
	values := platformHTTPValues(declared)
	assignmentHTTPMutation(f, nil, &values, &declared, dependencies, true, declared.AssignedTo, nil)
	response := projectRequest(f.handler, http.MethodPost, taskCollection(f.project.ID), body)
	got := decodeResponse[api.Task](f.t, response, http.StatusCreated)
	platformHTTPCheck(f.t, got, assignmentHTTPAPI(f.t, declared))
	return declared, response
}

func assignmentHTTPUpdate(f *taskHTTPFixture, before, after model.Task, patch map[string]any, dependencies []model.Task, changed bool) model.Task {
	f.t.Helper()
	before, after = copyTaskHTTPTask(before), copyTaskHTTPTask(after)
	values := platformHTTPValues(after)
	var result *model.Task
	if changed {
		result = &after
	}
	var target *string
	if !reflect.DeepEqual(before.AssignedTo, after.AssignedTo) {
		target = after.AssignedTo
	}
	assignmentHTTPMutation(f, &before, &values, result, dependencies, true, target, nil)
	got := updateHTTPTask(f.t, f.handler, assignmentHTTPAPI(f.t, before), patch)
	platformHTTPCheck(f.t, got, assignmentHTTPAPI(f.t, after))
	return after
}

func assignmentHTTPGraphRow(row model.Task) model.GraphTask {
	row = copyTaskHTTPTask(row)
	result := platformHTTPProjection(row)
	result.DependsOn, result.ExternalDependsOn, result.BlockedBy = row.DependsOn, row.ExternalDependsOn, row.BlockedBy
	return result
}

func assignmentHTTPSyncRow(row model.Task) model.TaskViewRecord {
	row = copyTaskHTTPTask(row)
	return model.TaskViewRecord{ID: row.ID, TitlePreview: row.Title, Properties: row.Properties, Status: row.Status, Version: row.Version,
		AssignedTo: row.AssignedTo, RequiredPlatform: row.RequiredPlatform, AllowAgents: row.AllowAgents, DependsOn: row.DependsOn, ExternalDependsOn: row.ExternalDependsOn,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, StartedAt: row.StartedAt, CompletedAt: row.CompletedAt, CancelledAt: row.CancelledAt}
}
