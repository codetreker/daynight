package task

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	threadcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/thread"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

const threadOperationTimeout = 10 * time.Second

type TaskThreads struct {
	store interface {
		store.SnapshotReader
		store.ThreadWriter
	}
	capturer Capturer
}

func NewTaskThreads(database interface {
	store.SnapshotReader
	store.ThreadWriter
}, capture ...Capturer) *TaskThreads {
	return &TaskThreads{store: database, capturer: capturer(capture)}
}

type CreateThreadMessage struct {
	Body    string
	ReplyTo *string
	ClaimID *string
}

type ThreadListRequest struct {
	BeforeID      *string
	AfterID       *string
	Count         int
	Details       bool
	FromBeginning bool
}

type ThreadMessageDocument struct {
	Message model.ThreadMessage
	JSON    []byte
}

type ThreadPageDocument struct {
	Page model.ThreadPage
	JSON []byte
}

// ThreadMessageError retains safe attribution available before a write failed.
// MessageID identifies a candidate, and does not imply that it was committed.
type ThreadMessageError struct {
	MessageID string
	Execution *model.ThreadExecution
	Outcome   store.TransactionOutcome
	Cause     error
}

func (err *ThreadMessageError) Error() string { return "post thread message failed" }
func (err *ThreadMessageError) Unwrap() error { return err.Cause }

// TransactionOutcome reports the store's actual completion fact, including a
// successful rollback. It is independent of any cleanup error in the cause.
func (err *ThreadMessageError) TransactionOutcome() store.TransactionOutcome { return err.Outcome }

func threadScope(principal model.Principal, projectID, taskID string) (string, string, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return "", "", err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return "", "", err
	}
	taskID, err = model.CanonicalID(taskID)
	return projectID, taskID, err
}

func threadAccessError(err error) error {
	if errors.Is(err, store.ErrProjectDeleted) {
		return &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: err}
	}
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "forbidden", Message: "Project access is required.", Cause: err}
	}
	return err
}

func threadCredentialError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return model.Unauthenticated(err)
	}
	return err
}

func threadPresence(presence store.TaskPresence) error {
	if !presence.Found {
		return taskcore.NotFound(model.ErrNotFound)
	}
	if presence.DeletedAt != nil {
		return taskcore.NotFound(model.ErrTaskDeleted)
	}
	return nil
}

func (s *TaskThreads) Post(ctx context.Context, principal model.Principal, projectID, taskID string, input CreateThreadMessage) (ThreadMessageDocument, error) {
	ctx, cancel := context.WithTimeout(ctx, threadOperationTimeout)
	defer cancel()
	projectID, taskID, err := threadScope(principal, projectID, taskID)
	if err != nil {
		return ThreadMessageDocument{}, err
	}
	input.ReplyTo, input.ClaimID, err = threadcore.ValidateMessage(input.Body, input.ReplyTo, input.ClaimID)
	if err != nil {
		return ThreadMessageDocument{}, err
	}
	var result ThreadMessageDocument
	failure := &ThreadMessageError{}
	completion, err := s.store.WriteThread(ctx, func(tx store.ThreadScope) error {
		presence, err := tx.TaskDAO().LockTaskPresence(ctx, projectID, taskID)
		if err != nil {
			return err
		}
		credential, err := tx.CredentialDAO().Credential(ctx, principal)
		if err != nil {
			return threadCredentialError(err)
		}
		if _, err := tx.ProjectDAO().LockProjectAuthorization(ctx, principal, projectID); err != nil {
			return threadAccessError(err)
		}
		if err := threadPresence(presence); err != nil {
			return err
		}
		message, encoded, err := threadcore.Append(ctx, tx.TaskDAO(), tx.CredentialDAO(), tx.ThreadDAO(), principal, projectID, taskID, input.Body, input.ReplyTo, input.ClaimID, credential)
		failure.MessageID = message.ID
		failure.Execution = message.Author.Execution
		if err != nil {
			return err
		}
		result = ThreadMessageDocument{Message: message, JSON: encoded}
		f := protocol.Fact{Type: protocol.ThreadPosted, ProjectID: projectID, TaskID: taskID, MessageID: message.ID, OccurredAt: message.CreatedAt, CreatedAt: &message.CreatedAt, ReplyTo: message.ReplyTo}
		return s.capturer.CaptureBatch(ctx, tx.CaptureDAO(), []protocol.Fact{f})
	})
	if err == nil && completion.Outcome != store.TransactionCommitted {
		err = errors.New("thread write did not commit")
		if completion.Outcome == store.TransactionUnknown {
			err = &store.ThreadTransactionError{Phase: "completion", OutcomeUnknown: true, Cause: err}
		}
	}
	if err != nil {
		failure.Outcome = completion.Outcome
		failure.Cause = err
		return ThreadMessageDocument{}, failure
	}
	return result, nil
}

func (s *TaskThreads) List(ctx context.Context, principal model.Principal, projectID, taskID string, input ThreadListRequest) (ThreadPageDocument, error) {
	ctx, cancel := context.WithTimeout(ctx, threadOperationTimeout)
	defer cancel()
	projectID, taskID, err := threadScope(principal, projectID, taskID)
	if err != nil {
		return ThreadPageDocument{}, err
	}
	pageRequest, err := threadcore.ValidatePage(threadcore.PageRequest{BeforeID: input.BeforeID, AfterID: input.AfterID, Count: input.Count, Details: input.Details, FromBeginning: input.FromBeginning})
	if err != nil {
		return ThreadPageDocument{}, err
	}
	var result ThreadPageDocument
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := snapshot.CredentialDAO().Credential(ctx, principal); err != nil {
			return threadCredentialError(err)
		}
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			return threadAccessError(err)
		}
		presence, err := snapshot.TaskDAO().TaskPresence(ctx, projectID, taskID)
		if err != nil {
			return err
		}
		if err := threadPresence(presence); err != nil {
			return err
		}
		page, encoded, err := threadcore.ReadPage(ctx, snapshot.TaskDAO(), taskID, pageRequest)
		if err != nil {
			return err
		}
		result = ThreadPageDocument{Page: page, JSON: encoded}
		return nil
	})
	if err != nil {
		return ThreadPageDocument{}, fmt.Errorf("list thread messages: %w", err)
	}
	return result, nil
}

// ThreadResponseFault classifies Thread-local outcomes before the general HTTP
// error mapper examines their causes. A failed cleanup always remains internal.
func ThreadResponseFault(err error) (*model.Fault, bool) {
	var transaction *store.ThreadTransactionError
	if !errors.As(err, &transaction) {
		return nil, false
	}
	if transaction.RollbackFailed {
		return &model.Fault{Code: "internal_error", Message: "The request could not be completed.", Cause: err}, true
	}
	if transaction.OutcomeUnknown {
		return &model.Fault{Code: "message_outcome_unknown", Message: "Message outcome is unknown. Keep the draft and read the thread before deciding whether to send again.", Cause: err}, true
	}
	var clock *store.ThreadClockError
	if !transaction.CommitAttempted && errors.As(err, &clock) {
		return &model.Fault{Code: "clock_not_advanced", Message: "A reliable forward message position was not obtained within the clock budget.", Cause: err}, true
	}
	return nil, false
}

func ThreadWriteOutcomeUnknown(err error) bool {
	fault, ok := ThreadResponseFault(err)
	return ok && fault.Code == "message_outcome_unknown"
}
