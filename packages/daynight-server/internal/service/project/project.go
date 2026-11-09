package project

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	session "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
	"github.com/google/uuid"
)

type database interface {
	store.SnapshotReader
	store.ProjectWriter
	store.ProjectCreationWriter
}
type Projects struct {
	store  database
	engine *session.Engine
}
type Memberships struct {
	store database
	now   func() time.Time
}

func NewProjects(db database, engines ...*session.Engine) *Projects {
	engine := session.NewEngine(nil)
	if len(engines) > 0 {
		engine = engines[0]
	}
	return &Projects{store: db, engine: engine}
}
func NewMemberships(db database) *Memberships { return &Memberships{store: db, now: time.Now} }
func completed(c store.Completion, err error, refusal *model.Fault) error {
	if err != nil {
		return err
	}
	if c.Outcome != store.TransactionCommitted {
		return errors.New("Project transaction did not confirm commit")
	}
	if refusal != nil {
		return refusal
	}
	return nil
}
func read(ctx context.Context, db store.SnapshotReader, op func(store.ProjectReader) error) error {
	var refusal *model.Fault
	err := db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		return completion.Capture(func() error { return op(s.ProjectDAO()) }, &refusal)
	})
	if err != nil {
		return err
	}
	if refusal != nil {
		return refusal
	}
	return nil
}
func write(ctx context.Context, db store.ProjectWriter, id string, op func(store.ProjectWriteDAO) error) error {
	var refusal *model.Fault
	c, err := db.WriteProject(ctx, id, func(s store.ProjectWriteScope) error {
		return completion.Capture(func() error { return op(s.ProjectDAO()) }, &refusal)
	})
	return completed(c, err, refusal)
}
func (s *Projects) Create(ctx context.Context, p model.Principal, input core.CreateProject) (model.Project, error) {
	project, _, err := s.CreateWithAccess(ctx, p, input)
	return project, err
}
func (s *Projects) CreateWithAccess(ctx context.Context, p model.Principal, input core.CreateProject) (model.Project, model.ProjectAccess, error) {
	if err := core.ValidateCreate(p, input); err != nil {
		return model.Project{}, model.ProjectAccess{}, err
	}
	return s.createValidated(ctx, p, input)
}

// createValidated requires the caller to validate identity, authorization inputs,
// name and repository syntax before allocating an ID or starting a transaction.
func (s *Projects) createValidated(ctx context.Context, p model.Principal, input core.CreateProject) (model.Project, model.ProjectAccess, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return model.Project{}, model.ProjectAccess{}, fmt.Errorf("generate project ID: %w", err)
	}
	var result model.Project
	var access model.ProjectAccess
	var refusal *model.Fault
	c, err := s.store.WriteProjectCreation(ctx, p.UserID, func(dao store.ProjectCreationDAO) error {
		return completion.Capture(func() error {
			var err error
			result, access, err = core.Create(ctx, dao, p.UserID, id.String(), input)
			return err
		}, &refusal)
	})
	if err := completed(c, err, refusal); err != nil {
		return model.Project{}, model.ProjectAccess{}, fmt.Errorf("create project: %w", err)
	}
	return result, access, nil
}
func (s *Projects) Get(ctx context.Context, p model.Principal, id string) (model.Project, error) {
	result, _, err := s.GetWithAccess(ctx, p, id)
	return result, err
}
func (s *Projects) GetWithAccess(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return model.Project{}, model.ProjectAccess{}, err
	}
	var result model.Project
	var access model.ProjectAccess
	err = read(ctx, s.store, func(dao store.ProjectReader) error {
		var err error
		result, access, err = core.Get(ctx, dao, p, id)
		return err
	})
	if err != nil {
		if _, ok := err.(*model.Fault); ok {
			return model.Project{}, model.ProjectAccess{}, err
		}
		return model.Project{}, model.ProjectAccess{}, fmt.Errorf("get project: %w", err)
	}
	return result, access, nil
}
func (s *Projects) List(ctx context.Context, p model.Principal, request model.PageRequest) (core.ProjectPage, error) {
	return s.ListScoped(ctx, p, core.ProjectListRequest{Page: request})
}
func (s *Projects) ListScoped(ctx context.Context, p model.Principal, request core.ProjectListRequest) (core.ProjectPage, error) {

	if err := core.ValidateList(p, request); err != nil {
		return core.ProjectPage{}, err
	}
	var result store.ProjectPage
	err := read(ctx, s.store, func(dao store.ProjectReader) error {
		var err error
		result, err = core.ReadList(ctx, dao, p, request)
		return err
	})
	if err != nil {
		if _, ok := err.(*model.Fault); ok {
			return core.ProjectPage{}, err
		}
		return core.ProjectPage{}, fmt.Errorf("list projects: %w", err)
	}
	return core.FinishList(p, request, result)
}
func (s *Projects) Access(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return model.ProjectAccess{}, err
	}
	var result model.ProjectAccess
	err = read(ctx, s.store, func(dao store.ProjectReader) error {
		var err error
		result, err = core.RequireProjectRead(ctx, dao, p, id)
		return err
	})
	if err != nil {
		if _, ok := err.(*model.Fault); ok {
			return model.ProjectAccess{}, err
		}
		return model.ProjectAccess{}, fmt.Errorf("read project access: %w", err)
	}
	return result, nil
}
func (s *Projects) UpdateSettings(ctx context.Context, p model.Principal, id string, input core.UpdateProjectSettings) (model.Project, error) {
	id, err := core.ValidateSettings(p, id, input)
	if err != nil {
		return model.Project{}, err
	}
	var result model.Project
	err = write(ctx, s.store, id, func(dao store.ProjectWriteDAO) error {
		var err error
		result, err = core.UpdateSettings(ctx, dao, p, input)
		return err
	})
	if err != nil {
		return model.Project{}, core.ProjectWriteError(err)
	}
	return result, nil
}
func (s *Projects) TransferPreview(ctx context.Context, p model.Principal, id, target string) (core.TransferPreview, error) {
	id, target, err := core.ValidateTransferPreview(p, id, target)
	if err != nil {
		return core.TransferPreview{}, err
	}
	var result core.TransferPreview
	err = read(ctx, s.store, func(dao store.ProjectReader) error {
		var err error
		result, err = core.TransferPreviewFor(ctx, dao, p, id, target)
		return err
	})
	return result, err
}
func (s *Projects) Transfer(ctx context.Context, p model.Principal, id string, input core.TransferInput) (core.TransferReceipt, error) {
	id, source, target, err := core.ValidateTransfer(p, id, input)
	if err != nil {
		return core.TransferReceipt{}, err
	}
	var result core.TransferReceipt
	c, err := s.store.WriteProject(ctx, id, func(scope store.ProjectWriteScope) error {
		var err error
		result, err = core.Transfer(ctx, scope.ProjectDAO(), p, id, source, target, input)
		if err != nil {
			return err
		}
		return webhook.RefreshEligibility(ctx, scope.EligibilityDAO(), store.WebhookEligibilityFilter{ProjectID: id})
	})
	if err := completed(c, err, nil); err != nil {
		return core.TransferReceipt{}, err
	}
	return result, nil
}
