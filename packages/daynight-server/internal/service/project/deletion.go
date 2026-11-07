package project

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	session "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

const deletionPreviewBudget = 1 << 20

func deletionTextBytes(values ...string) int {
	total := 0
	for _, value := range values {
		encoded, _ := json.Marshal(value)
		total += len(encoded)
	}
	return total
}

type DeletionClaim struct {
	TaskID, Title, MachineName string
	Platform                   model.TaskPlatform
	Phase                      model.WorkerPhase
	Paused                     bool
	Connectivity               string
}
type DeletionPreview struct {
	ObservedAt   time.Time
	Project      model.Project
	OwnerTeam    model.TeamRef
	Summary      store.ProjectDeletionSummary
	ActiveClaims []DeletionClaim
	NextCursor   *string
}
type DeletionReceipt struct {
	ProjectID string
	Deleted   bool
}

// DeletionFailure retains the transaction's observed durable outcome.
type DeletionFailure struct {
	Outcome store.TransactionOutcome
	Cause   error
}

func (e *DeletionFailure) Error() string { return "project deletion failed" }
func (e *DeletionFailure) Unwrap() error { return e.Cause }

func ownerAdmin(access model.ProjectAccess) error {
	if access.TeamRole == nil || *access.TeamRole != model.ProjectAdmin {
		return &model.Fault{Code: "forbidden", Message: "Owner Team administrator access is required."}
	}
	return nil
}

func (s *Projects) DeletionPreview(ctx context.Context, p model.Principal, id string, request model.PageRequest) (DeletionPreview, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return DeletionPreview{}, err
	}
	scope := query.ListScope{Kind: "project-deletion-claims", UserID: p.UserID, ProjectID: id}
	page, err := query.ListPage(request, scope)
	if err != nil {
		return DeletionPreview{}, err
	}
	reader, ok := s.store.(store.ProjectDeletionReader)
	if !ok {
		return DeletionPreview{}, errors.New("project deletion reader unavailable")
	}
	var out DeletionPreview
	var refusal *model.Fault
	err = reader.ReadProjectDeletion(ctx, id, func(snapshot store.ProjectDeletionSnapshot) error {
		return completion.Capture(func() error {
			project, access, err := core.Get(ctx, snapshot.ProjectDAO(), p, id)
			if err != nil {
				return err
			}
			if err = ownerAdmin(access); err != nil {
				return err
			}
			out.Project, out.OwnerTeam = project, access.OwnerTeam
			ownerName := ""
			if access.OwnerTeam.Name != nil {
				ownerName = *access.OwnerTeam.Name
			}
			used := 4096 + deletionTextBytes(project.Name, project.RepoURL, ownerName)
			if used > deletionPreviewBudget {
				return &model.Fault{Code: "payload_too_large", Message: "Project deletion preview exceeds the response budget."}
			}
			if out.ObservedAt, err = snapshot.ObservedAt(ctx); err != nil {
				return err
			}
			if out.Summary, err = snapshot.Summary(ctx); err != nil {
				return err
			}
			out.ActiveClaims = make([]DeletionClaim, 0, request.Limit)
			more := false
			err = snapshot.VisitTaskWorkers(ctx, func(f store.ProjectDeletionWorker) error {
				if f.Worker == nil || f.Worker.State != model.WorkerActive || (page.After != nil && f.TaskID <= page.After.ID) {
					return nil
				}
				if more || len(out.ActiveClaims) == request.Limit {
					more = true
					return nil
				}
				size := 512 + deletionTextBytes(f.Title, f.Worker.Machine.Name)
				if used+size > deletionPreviewBudget {
					if len(out.ActiveClaims) == 0 {
						return &model.Fault{Code: "payload_too_large", Message: "A Worker claim exceeds the preview response budget."}
					}
					more = true
					return nil
				}
				used += size
				connectivity := "unknown"
				if f.LastSeenAt != nil {
					connectivity = "offline"
					if out.ObservedAt.Sub(*f.LastSeenAt) < 120*time.Second {
						connectivity = "online"
					}
				}
				out.ActiveClaims = append(out.ActiveClaims, DeletionClaim{TaskID: f.TaskID, Title: f.Title, MachineName: f.Worker.Machine.Name, Platform: f.Worker.Platform, Phase: f.Worker.Phase, Paused: f.Paused, Connectivity: connectivity})
				return nil
			})
			if err != nil {
				return err
			}
			if more {
				cursor, err := query.EncodeListCursor(scope, time.Unix(1, 0).UTC(), out.ActiveClaims[len(out.ActiveClaims)-1].TaskID)
				if err != nil {
					return err
				}
				out.NextCursor = &cursor
			}
			return nil
		}, &refusal)
	})
	if err != nil {
		return DeletionPreview{}, err
	}
	if refusal != nil {
		return DeletionPreview{}, refusal
	}
	return out, nil
}

func (s *Projects) Delete(ctx context.Context, p model.Principal, id string) (DeletionReceipt, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return DeletionReceipt{}, err
	}
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
	writer, ok := s.store.(store.ProjectDeletionWriter)
	if !ok || s.engine == nil {
		return DeletionReceipt{}, &DeletionFailure{Outcome: store.TransactionNotCommitted, Cause: errors.New("project deletion dependencies unavailable")}
	}
	var candidate *DeletionReceipt
	var ticket *session.ProjectRetirementTicket
	c, err := writer.WriteProjectDeletion(ctx, id, func(scope store.ProjectDeletionScope) error {
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
		marked, err := dao.MarkDeleted(ctx)
		if err != nil {
			return err
		}
		if !marked {
			return errors.New("project deletion did not mark a project")
		}
		if err = session.RetireProject(ctx, scope.SessionDAO(), id); err != nil {
			return err
		}
		if err = scope.WebhookEligibilityDAO().RefreshAffected(ctx, store.WebhookEligibilityChange{ProjectIDs: []string{id}}); err != nil {
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
