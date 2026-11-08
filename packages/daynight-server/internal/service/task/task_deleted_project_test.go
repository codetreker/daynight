package task_test

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestDeletedProjectThreadListAndLiveProjectDenial(t *testing.T) {
	for _, scenario := range []struct {
		name           string
		post           bool
		projectDeleted bool
		taskDeleted    bool
		outsider       bool
		want           string
	}{
		{name: "live/post/outsider", post: true, outsider: true, want: "forbidden"},
		{name: "live/list/outsider", outsider: true, want: "forbidden"},
		{name: "deleted-task/list", taskDeleted: true, want: "task_deleted"},
		{name: "deleted-project/live-task", projectDeleted: true, want: "not_found"},
		{name: "deleted-project/deleted-task", projectDeleted: true, taskDeleted: true, want: "not_found"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f := newThreadFailureFixture(t)
			if scenario.taskDeleted {
				f.task.ID = "88888888-8888-4888-8888-888888888888"
				f.taskRead.TaskPresenceFn = func(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
					if projectID != f.project.ID || taskID != f.task.ID {
						t.Fatal("deleted Task presence was read outside its Project")
					}
					return store.TaskPresence{Found: true, DeletedAt: &f.task.UpdatedAt}, ctx.Err()
				}
			}
			if scenario.outsider {
				f.principal.UserID = "99999999-9999-4999-8999-999999999999"
				f.projectWrite.LockProjectAuthorizationFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
					return model.ProjectAccess{}, model.ErrNotFound
				}
				f.projectRead.ProjectAccessFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
					return model.ProjectAccess{}, model.ErrNotFound
				}
			}
			if scenario.projectDeleted {
				f.projectRead.ProjectAccessFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
					return model.ProjectAccess{}, store.ErrProjectDeleted
				}
				f.taskRead.TaskPresenceFn = nil
			}
			f.taskRead.ThreadCandidatesFn = nil
			f.credential.AuthorNameFn = nil
			var err error
			if scenario.post {
				_, err = f.service.Post(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.CreateThreadMessage{Body: "denied"})
			} else {
				_, err = f.service.List(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.ThreadListRequest{})
			}
			requireThreadFault(t, err, scenario.want)
		})
	}
}
