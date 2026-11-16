package project

import (
	"context"
	"errors"
	"fmt"

	github "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	session "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
)

func (s *AppProjects) Delete(ctx context.Context, p model.Principal, id string) (DeletionReceipt, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return DeletionReceipt{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, github.OperationTimeout)
	defer cancel()
	access, err := s.Access(ctx, p, id)
	if err != nil {
		if _, ok := err.(*model.Fault); ok {
			return DeletionReceipt{}, err
		}
		return DeletionReceipt{}, &DeletionFailure{Outcome: store.TransactionNotCommitted, Cause: err}
	}
	if err = ownerAdmin(access); err != nil {
		return DeletionReceipt{}, err
	}
	var candidate *DeletionReceipt
	var ticket *session.ProjectRetirementTicket
	c, err := s.lifecycle.WriteGitHubProjectDeletion(ctx, id, func(scope store.GitHubProjectDeletionScope) error {
		dao := scope.ProjectDAO()
		access, err := dao.Authorization(ctx, p)
		if err != nil {
			return core.LookupError(err)
		}
		if err = ownerAdmin(access); err != nil {
			return err
		}
		active := false
		if err = dao.VisitTaskWorkers(ctx, func(f store.ProjectDeletionWorker) error {
			if f.Worker != nil && f.Worker.State == model.WorkerActive {
				active = true
			}
			return nil
		}); err != nil {
			return err
		}
		if active {
			return &model.Fault{Code: "active_worker_claims", Message: "Project has active Worker claims."}
		}
		connection := scope.GitHubDAO()
		if _, err = connection.LockBinding(ctx); err != nil {
			return err
		}
		if err = connection.Stop(ctx, github.DisconnectionDecision()); err != nil {
			return err
		}
		if err = connection.AdvanceImpact(ctx); err != nil {
			return err
		}
		marked, err := dao.MarkDeleted(ctx)
		if err != nil {
			return err
		}
		if !marked {
			return errors.New("project deletion did not mark a project")
		}
		if err = webhook.RefreshEligibility(ctx, scope.EligibilityDAO(), store.WebhookEligibilityFilter{ProjectID: id}); err != nil {
			return err
		}
		if err = session.RetireProject(ctx, scope.SessionDAO(), id); err != nil {
			return err
		}
		ticket = s.engine.CaptureProjectRetirement(id)
		candidate = &DeletionReceipt{ProjectID: id, Deleted: true}
		return nil
	})
	var transaction *store.TransactionError
	if c.Outcome != store.TransactionCommitted && errors.As(err, &transaction) && transaction.CleanupFailed {
		c.Outcome = store.TransactionUnknown
	}
	if c.Outcome == store.TransactionCommitted && candidate != nil {
		ticket.Retire()
		return *candidate, nil
	}
	if err == nil {
		err = fmt.Errorf("project deletion did not produce a confirmed receipt")
	}
	if c.Outcome == store.TransactionNotCommitted {
		err = core.ProjectWriteError(err)
	}
	if c.Outcome == store.TransactionCommitted {
		return DeletionReceipt{}, &DeletionFailure{Outcome: store.TransactionUnknown, Cause: err}
	}
	return DeletionReceipt{}, &DeletionFailure{Outcome: c.Outcome, Cause: err}
}
