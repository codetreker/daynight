package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
)

type StepsStore interface {
	store.SnapshotReader
	store.ProjectWriter
}

type TaskSteps struct {
	store           StepsStore
	capturer        Capturer
	readOperations  taskStepReadOperations
	writeOperations taskStepWriteOperations
}

type taskStepReadOperations struct {
	requireProjectRead func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error)
}

type taskStepWriteOperations struct {
	requireProjectWrite func(context.Context, store.ProjectWriteDAO, model.Principal) (model.ProjectAccess, error)
	admitAdd            func(model.TaskHeader, []model.TaskStep, model.TaskStep, *string, *string) (tasksteps.Mutation, error)
	admitChange         func(model.TaskHeader, []model.TaskStep, string, tasksteps.Changes) (tasksteps.Mutation, error)
	admitMove           func(model.TaskHeader, []model.TaskStep, string, tasksteps.Placement) (tasksteps.Mutation, error)
	admitDelete         func(model.TaskHeader, []model.TaskStep, string) (tasksteps.Mutation, error)
}

func NewTaskSteps(database StepsStore, capture ...Capturer) *TaskSteps {
	return &TaskSteps{
		store:          database,
		capturer:       capturer(capture),
		readOperations: taskStepReadOperations{requireProjectRead: projectcore.RequireProjectRead},
		writeOperations: taskStepWriteOperations{
			requireProjectWrite: projectcore.RequireProjectWrite,
			admitAdd:            tasksteps.AdmitAdd,
			admitChange:         tasksteps.AdmitChange,
			admitMove:           tasksteps.AdmitMove,
			admitDelete:         tasksteps.AdmitDelete,
		},
	}
}

type StepsDocument struct {
	Resource taskcodec.StepsResource
	JSON     []byte
}

type StepDocument struct {
	Resource taskcodec.StepResource
	JSON     []byte
}

// StepsPage is read under one snapshot with its parent version. Items are
// ordered by position; summary items do not contain descriptions.
type StepsPage struct {
	Header  model.TaskHeader
	Items   []store.TaskStepProjection
	HasMore bool
}

type StepSummary struct {
	Header model.TaskHeader
	Item   store.TaskStepProjection
}

// ListPage returns one batch and rejects a cursor from another parent
// version before reading the page. afterPosition is -1 for the first page.
func (s *TaskSteps) ListPage(ctx context.Context, principal model.Principal, projectID, taskID string, afterPosition int64, limit int, expectedVersion *int64, summary bool) (StepsPage, error) {
	if afterPosition < -1 || limit < 1 || limit > 100 || (expectedVersion != nil && *expectedVersion < 1) {
		return StepsPage{}, &model.Fault{Code: "invalid_input", Message: "Invalid Step page bounds or version."}
	}
	var page StepsPage
	err := s.read(ctx, principal, projectID, taskID, func(reader store.TaskReader, header model.TaskHeader) error {
		if expectedVersion != nil {
			if err := taskcore.RequireVersion(header.Version, *expectedVersion); err != nil {
				return err
			}
		}
		items, err := reader.TaskStepPage(ctx, header.ID, afterPosition, limit+1, summary)
		if err != nil {
			return err
		}
		page = StepsPage{Header: header, Items: items, HasMore: len(items) > limit}
		if page.HasMore {
			page.Items = page.Items[:limit]
		}
		return nil
	})
	if err != nil {
		return StepsPage{}, err
	}
	return page, nil
}

// GetSummary retains the observed parent version even for a missing Step via
// the same StepAbsence fault used by Get.
func (s *TaskSteps) GetSummary(ctx context.Context, principal model.Principal, projectID, taskID, stepID string) (StepSummary, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return StepSummary{}, err
	}
	id, err := tasksteps.CanonicalID(stepID)
	if err != nil {
		return StepSummary{}, err
	}
	var result StepSummary
	err = s.read(ctx, principal, projectID, taskID, func(reader store.TaskReader, header model.TaskHeader) error {
		item, err := reader.TaskStepSummary(ctx, header.ID, id)
		if errors.Is(err, model.ErrNotFound) {
			return tasksteps.NotFound(header.Version, err)
		}
		if err != nil {
			return err
		}
		result = StepSummary{Header: header, Item: item}
		return nil
	})
	if err != nil {
		return StepSummary{}, err
	}
	return result, nil
}

func (s *TaskSteps) read(ctx context.Context, principal model.Principal, projectID, taskID string, operation func(store.TaskReader, model.TaskHeader) error) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return err
	}
	taskID, err = model.CanonicalID(taskID)
	if err != nil {
		return err
	}
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := s.readOperations.requireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			return err
		}
		header, err := snapshot.TaskDAO().TaskHeader(ctx, projectID, taskID)
		if errors.Is(err, model.ErrNotFound) {
			return taskcore.NotFound(err)
		}
		if err != nil {
			return err
		}
		if header.DeletedAt != nil {
			return taskcore.NotFound(model.ErrTaskDeleted)
		}
		if err := taskcore.CheckStepsForType(header.Type); err != nil {
			return err
		}
		return operation(snapshot.TaskDAO(), header)
	})
	if err != nil {
		return fmt.Errorf("read task steps: %w", err)
	}
	return nil
}

func (s *TaskSteps) List(ctx context.Context, principal model.Principal, projectID, taskID string) (StepsDocument, error) {
	var document StepsDocument
	err := s.read(ctx, principal, projectID, taskID, func(reader store.TaskReader, header model.TaskHeader) error {
		steps, err := reader.TaskSteps(ctx, header.ID)
		if err != nil {
			return err
		}
		document.Resource = taskcodec.ProjectCollection(header, steps)
		document.JSON, err = json.Marshal(document.Resource)
		if err == nil {
			document.JSON = append(document.JSON, '\n')
		}
		return err
	})
	if err != nil {
		return StepsDocument{}, err
	}
	return document, nil
}

func (s *TaskSteps) Get(ctx context.Context, principal model.Principal, projectID, taskID, stepID string) (StepDocument, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return StepDocument{}, err
	}
	id, err := tasksteps.CanonicalID(stepID)
	if err != nil {
		return StepDocument{}, err
	}
	var document StepDocument
	err = s.read(ctx, principal, projectID, taskID, func(reader store.TaskReader, header model.TaskHeader) error {
		step, err := reader.TaskStep(ctx, header.ID, id)
		if errors.Is(err, model.ErrNotFound) {
			return tasksteps.NotFound(header.Version, err)
		}
		if err != nil {
			return err
		}
		document.Resource = taskcodec.ProjectItem(header, step)
		document.JSON, err = json.Marshal(document.Resource)
		if err == nil {
			document.JSON = append(document.JSON, '\n')
		}
		return err
	})
	if err != nil {
		return StepDocument{}, err
	}
	return document, nil
}

// The store may join its exact not-found marker around a wrapped business
// refusal. Other joined branches can represent failed transaction cleanup and
// must keep the whole operation an internal failure.
func TaskStepsFault(err error) (*model.Fault, bool) {
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
		return nil, false
	}
	fault, pure := taskStepsFault(err)
	return fault, pure && fault != nil
}

func taskStepsFault(err error) (*model.Fault, bool) {
	if failure, ok := err.(*store.TransactionError); ok {
		if failure.Phase != "operation" || failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted {
			return nil, false
		}
		return taskStepsFault(failure.Cause)
	}
	if err == model.ErrNotFound {
		return nil, true
	}
	if fault, ok := err.(*model.Fault); ok {
		return fault, true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var fault *model.Fault
		for _, child := range joined.Unwrap() {
			candidate, pure := taskStepsFault(child)
			if !pure {
				return nil, false
			}
			if candidate != nil {
				fault = candidate
			}
		}
		return fault, true
	}
	if cause := errors.Unwrap(err); cause != nil {
		return taskStepsFault(cause)
	}
	return nil, false
}

type AddTaskStep struct {
	Version     int64
	ID          string
	Title       string
	Description string
	Status      *model.TaskStepStatus
	Before      *string
	After       *string
}

type StepsWriteResult struct {
	StepsDocument
	Changed            bool
	Phase              string
	TransactionOutcome store.TransactionOutcome
	CleanupFailed      bool
}

func (s *TaskSteps) Add(ctx context.Context, principal model.Principal, projectID, taskID string, input AddTaskStep) (StepsWriteResult, error) {
	result := StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	projectID, taskID, err := taskWriteIdentity(principal, projectID, taskID, input.Version)
	if err != nil {
		return result, err
	}
	step, before, after, err := tasksteps.PrepareAdd(input.ID, input.Title, input.Description, input.Status, input.Before, input.After)
	if err != nil {
		return result, err
	}
	projectLocked := false
	completion, err := s.store.WriteProject(ctx, projectID, func(tx store.ProjectWriteScope) error {
		projectLocked = true
		if _, err := s.writeOperations.requireProjectWrite(ctx, tx.ProjectDAO(), principal); err != nil {
			return err
		}
		header, err := taskWriteHeader(ctx, tx, taskID, input.Version)
		if err != nil {
			return err
		}
		current, err := tx.TaskDAO().TaskSteps(ctx, taskID)
		if err != nil {
			return err
		}
		mutation, err := s.writeOperations.admitAdd(header, current, step, before, after)
		if err != nil {
			return err
		}
		observed, err := tx.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		result.Resource, result.JSON, err = tasksteps.EncodeMutation(header, mutation, observed, "add")
		if err != nil {
			return err
		}
		result.Changed = true
		result.Phase = "persist"
		if err := tx.TaskDAO().InsertTaskStep(ctx, taskID, mutation.Candidate[mutation.To]); err != nil {
			return err
		}
		if err := tx.TaskDAO().TouchTask(ctx, taskID, observed); err != nil {
			return err
		}
		return s.captureStep(ctx, tx, projectID, taskID, step.ID, "created", observed, nil, nil, nil, nil)
	})
	return finishStepsWrite(result, projectLocked, completion, err)
}

func finishStepsWrite(result StepsWriteResult, projectLocked bool, completion store.Completion, err error) (StepsWriteResult, error) {
	result.TransactionOutcome = completion.Outcome
	if err != nil {
		var transaction *store.TransactionError
		if errors.As(err, &transaction) {
			result.TransactionOutcome, result.CleanupFailed = transaction.Outcome, transaction.CleanupFailed
			if transaction.CommitAttempted {
				result.Phase = "commit"
			}
		}
		if !projectLocked && errors.Is(err, model.ErrNotFound) && transaction != nil && transaction.Phase == "operation" && transaction.Outcome == store.TransactionNotCommitted && !transaction.CleanupFailed {
			err = projectcore.ProjectNotFound(err)
		}
		result.StepsDocument = StepsDocument{}
		return result, fmt.Errorf("write task steps: %w", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		result.StepsDocument = StepsDocument{}
		return result, fmt.Errorf("write task steps: transaction did not confirm commit")
	}
	result.Phase = "commit"
	return result, nil
}
