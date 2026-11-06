package attachment

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentpostgres "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/attachment"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
)

func newAttachmentService(database *store.Store, files filestorage.Storage) *Attachments {
	return NewAttachments(database, attachmentpostgres.New(database.Pool), files)
}

func taskService(t *testing.T) (*taskservice.Tasks, *store.Store, model.Project, string, model.Principal) {
	return testsupport.TaskService(t)
}
func projectService(t *testing.T) (*projectservice.Projects, *store.Store, string, model.Principal) {
	return testsupport.ProjectService(t)
}
func createTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, projectID, title string, dependencies ...string) model.Task {
	return testsupport.CreateTask(t, tasks, principal, projectID, title, dependencies...)
}
func updateTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task, input taskcore.UpdateTask) model.Task {
	return testsupport.UpdateTask(t, tasks, principal, task, input)
}
func assertTaskUnchanged(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, before model.Task) {
	testsupport.AssertTaskUnchanged(t, tasks, principal, before)
}
func pointer[T any](value T) *T { return &value }
func propertyPatch(items ...model.PullRequestProperty) model.TaskPropertiesPatch {
	values := make([]map[string]string, len(items))
	for index, item := range items {
		values[index] = map[string]string{"url": item.URL, "title": item.Title}
	}
	data, err := json.Marshal(values)
	if err != nil {
		panic(err)
	}
	return model.TaskPropertiesPatch{"pullRequests": data}
}
func requireFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code || fault.Message == "" {
		t.Fatalf("expected %s fault, got %#v", code, err)
	}
	return fault
}
