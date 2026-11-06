package task_test

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
)

func taskService(t *testing.T) (*taskservice.Tasks, *postgres.Store, model.Project, string, model.Principal) {
	return testsupport.TaskService(t)
}

func createTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, projectID, title string, dependencies ...string) model.Task {
	return testsupport.CreateTask(t, tasks, principal, projectID, title, dependencies...)
}

func updateTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task, input taskcore.UpdateTask) model.Task {
	return testsupport.UpdateTask(t, tasks, principal, task, input)
}

func setStatusTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task, status model.TaskStatus) model.Task {
	return testsupport.SetStatusTask(t, tasks, principal, task, status)
}

func startTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task) model.Task {
	return testsupport.StartTask(t, tasks, principal, task)
}

func finishTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task) model.Task {
	return testsupport.FinishTask(t, tasks, principal, task)
}

func pointer[T any](value T) *T { return &value }

func assertTaskUnchanged(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, before model.Task) {
	testsupport.AssertTaskUnchanged(t, tasks, principal, before)
}

func serviceDatabaseURL(t *testing.T) string { return testsupport.ServiceDatabaseURL(t) }
func projectService(t *testing.T) (*projectservice.Projects, *postgres.Store, string, model.Principal) {
	return testsupport.ProjectService(t)
}
func servicePrincipal(t *testing.T, db *postgres.Store) model.Principal {
	return testsupport.ServicePrincipal(t, db)
}
func fixtureIdentitySession(t *testing.T, db *postgres.Store, user model.User, session model.Session) model.Principal {
	return testsupport.FixtureIdentitySession(t, db, user, session)
}
