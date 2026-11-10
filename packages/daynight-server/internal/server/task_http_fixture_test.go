package server

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"time"
)

func taskHTTPMockModels() (model.Project, model.Task, model.Principal) {
	observed := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	principal := defaultHTTPPrincipal()
	project := model.Project{ID: "33333333-3333-4333-8333-333333333333", Name: "Project", RepoURL: "https://github.com/example/repository", CreatedAt: observed, UpdatedAt: observed, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 120}, Ownership: model.ProjectOwnership{TeamID: "44444444-4444-4444-8444-444444444444", Version: 1, UpdatedAt: observed}}
	task := model.Task{ID: "55555555-5555-4555-8555-555555555555", ProjectID: project.ID, Title: "Task", Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, CreatedAt: observed, UpdatedAt: observed, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, AssignedTo: &principal.UserID, Ready: true}
	return project, task, principal
}

func taskHTTPMockAccess(project model.Project, principal model.Principal) model.ProjectAccess {
	return model.ProjectAccess{ProjectID: project.ID, UserID: principal.UserID, Role: model.ProjectAdmin, OwnerTeam: model.TeamRef{ID: project.Ownership.TeamID, Kind: "personal"}, Ownership: project.Ownership}
}

func taskHTTPMockStep(id string, position int64) model.TaskStep {
	observed := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	return model.TaskStep{ID: id, Position: position, Title: "Step", Status: model.TaskStepTodo, CreatedAt: observed, UpdatedAt: observed}
}
