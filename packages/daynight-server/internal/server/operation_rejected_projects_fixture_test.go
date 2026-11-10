package server

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"testing"
)

type operationRejectedProjects struct{ t *testing.T }

func (r *operationRejectedProjects) CreateWithAccess(context.Context, model.Principal, projectcore.CreateProject) (model.Project, model.ProjectAccess, error) {
	r.t.Errorf("unexpected Projects.CreateWithAccess call")
	var result0 model.Project
	var result1 model.ProjectAccess
	return result0, result1, errors.New("unexpected Projects.CreateWithAccess")
}

func (r *operationRejectedProjects) GetWithAccess(context.Context, model.Principal, string) (model.Project, model.ProjectAccess, error) {
	r.t.Errorf("unexpected Projects.GetWithAccess call")
	var result0 model.Project
	var result1 model.ProjectAccess
	return result0, result1, errors.New("unexpected Projects.GetWithAccess")
}

func (r *operationRejectedProjects) ListScoped(context.Context, model.Principal, projectcore.ProjectListRequest) (projectcore.ProjectPage, error) {
	r.t.Errorf("unexpected Projects.ListScoped call")
	var result0 projectcore.ProjectPage
	return result0, errors.New("unexpected Projects.ListScoped")
}

func (r *operationRejectedProjects) Access(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	r.t.Errorf("unexpected Projects.Access call")
	var result0 model.ProjectAccess
	return result0, errors.New("unexpected Projects.Access")
}

func (r *operationRejectedProjects) UpdateSettings(context.Context, model.Principal, string, projectcore.UpdateProjectSettings) (model.Project, error) {
	r.t.Errorf("unexpected Projects.UpdateSettings call")
	var result0 model.Project
	return result0, errors.New("unexpected Projects.UpdateSettings")
}

func (r *operationRejectedProjects) TransferPreview(context.Context, model.Principal, string, string) (projectcore.TransferPreview, error) {
	r.t.Errorf("unexpected Projects.TransferPreview call")
	var result0 projectcore.TransferPreview
	return result0, errors.New("unexpected Projects.TransferPreview")
}

func (r *operationRejectedProjects) Transfer(context.Context, model.Principal, string, projectcore.TransferInput) (projectcore.TransferReceipt, error) {
	r.t.Errorf("unexpected Projects.Transfer call")
	var result0 projectcore.TransferReceipt
	return result0, errors.New("unexpected Projects.Transfer")
}

func (r *operationRejectedProjects) DeletionPreview(context.Context, model.Principal, string, model.PageRequest) (project.DeletionPreview, error) {
	r.t.Errorf("unexpected Projects.DeletionPreview call")
	var result0 project.DeletionPreview
	return result0, errors.New("unexpected Projects.DeletionPreview")
}

func (r *operationRejectedProjects) Delete(context.Context, model.Principal, string) (project.DeletionReceipt, error) {
	r.t.Errorf("unexpected Projects.Delete call")
	var result0 project.DeletionReceipt
	return result0, errors.New("unexpected Projects.Delete")
}

func (r *operationRejectedProjects) RegisterRepository(context.Context, model.Principal, projectcore.CreateProject, bool) (model.Project, bool, error) {
	r.t.Errorf("unexpected Projects.RegisterRepository call")
	var result0 model.Project
	var result1 bool
	return result0, result1, errors.New("unexpected Projects.RegisterRepository")
}

func (r *operationRejectedProjects) ResolveRepository(context.Context, model.Principal, string) (model.Project, error) {
	r.t.Errorf("unexpected Projects.ResolveRepository call")
	var result0 model.Project
	return result0, errors.New("unexpected Projects.ResolveRepository")
}

func (r *operationRejectedProjects) Get(context.Context, model.Principal, string) (model.Project, error) {
	r.t.Errorf("unexpected Projects.Get call")
	var result0 model.Project
	return result0, errors.New("unexpected Projects.Get")
}
