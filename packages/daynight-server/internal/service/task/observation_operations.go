package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

type observationOperations struct {
	credential func(context.Context, store.CredentialReader, model.Principal) error
	access     func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error)
	task       func(context.Context, taskcore.ReadDAO, string, string) (model.Task, *model.Fault, error)
	list       func(context.Context, taskcore.ReadDAO, string, taskcore.ListSelection) (store.TaskPage, *model.Fault, error)
	graph      func(context.Context, taskcore.GraphReader, taskcore.SnapshotClock, string, string, model.Project) (model.TaskGraph, *model.Fault, error)
	mcpList    func(context.Context, taskcore.MCPListReader, string, taskcore.MCPListSelection) (taskcore.MCPListPage, error)
}

func observationDefaults() observationOperations {
	return observationOperations{credential: sessioncore.AuthorizeTaskObservation, access: projectcore.RequireProjectRead, task: taskcore.ReadTask, list: taskcore.ReadList, graph: taskcore.ReadGraph, mcpList: taskcore.ReadMCPList}
}
