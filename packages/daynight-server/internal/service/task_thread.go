package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
)

const threadOperationTimeout = 10 * time.Second

type TaskThreads struct {
	store *store.Store
}

func NewTaskThreads(database *store.Store) *TaskThreads {
	return &TaskThreads{store: database}
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
	Cause     error
}

func (err *ThreadMessageError) Error() string { return "post thread message failed" }
func (err *ThreadMessageError) Unwrap() error { return err.Cause }

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

func canonicalThreadID(id *string) (*string, error) {
	if id == nil {
		return nil, nil
	}
	value, err := model.CanonicalID(*id)
	return &value, err
}

func threadAccessError(err error) error {
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
		return taskNotFound(model.ErrNotFound)
	}
	if presence.DeletedAt != nil {
		return taskNotFound(model.ErrTaskDeleted)
	}
	return nil
}

func threadMessageError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "message_not_found", Message: "Message was not found in this task.", Cause: err}
	}
	return err
}

func (s *TaskThreads) Post(ctx context.Context, principal model.Principal, projectID, taskID string, input CreateThreadMessage) (ThreadMessageDocument, error) {
	ctx, cancel := context.WithTimeout(ctx, threadOperationTimeout)
	defer cancel()
	projectID, taskID, err := threadScope(principal, projectID, taskID)
	if err != nil {
		return ThreadMessageDocument{}, err
	}
	if !utf8.ValidString(input.Body) || strings.ContainsRune(input.Body, 0) || strings.TrimSpace(input.Body) == "" {
		return ThreadMessageDocument{}, invalidInput("Message body must be nonempty UTF-8 text without NUL characters.")
	}
	if len(input.Body) > taskcodec.MessageLimit {
		return ThreadMessageDocument{}, threadMessageTooLarge()
	}
	input.ReplyTo, err = canonicalThreadID(input.ReplyTo)
	if err != nil {
		return ThreadMessageDocument{}, err
	}
	input.ClaimID, err = canonicalThreadID(input.ClaimID)
	if err != nil {
		return ThreadMessageDocument{}, err
	}
	var result ThreadMessageDocument
	failure := &ThreadMessageError{}
	err = s.store.WriteThread(ctx, func(tx *store.ThreadTx) error {
		presence, err := tx.LockTaskPresence(ctx, projectID, taskID)
		if err != nil {
			return err
		}
		credential, err := tx.Credential(ctx, principal)
		if err != nil {
			return threadCredentialError(err)
		}
		if _, err := tx.LockProjectAuthorization(ctx, principal, projectID); err != nil {
			return threadAccessError(err)
		}
		if err := threadPresence(presence); err != nil {
			return err
		}
		name, err := tx.AuthorName(ctx, principal.UserID)
		if err != nil {
			return err
		}
		author := model.ThreadAuthor{UserID: principal.UserID, DisplayName: name}
		if input.ClaimID != nil {
			current, err := tx.SourceTask(ctx, projectID, taskID)
			if err != nil {
				return err
			}
			worker, err := activeWorker(current, *input.ClaimID)
			if err != nil {
				return err
			}
			if worker.UserID != principal.UserID {
				return &model.Fault{Code: "forbidden", Message: "Only the current execution owner may use this claim."}
			}
			author.Agent = true
			author.Execution = &model.ThreadExecution{ClaimID: worker.ClaimID, WorkerID: worker.WorkerID, Provider: string(worker.Agent)}
			failure.Execution = author.Execution
		}
		head, err := tx.LockHead(ctx, taskID)
		if err != nil {
			return err
		}
		if input.ReplyTo != nil {
			if _, err := tx.ThreadMessage(ctx, taskID, *input.ReplyTo); err != nil {
				return threadMessageError(err)
			}
		}
		message, err := tx.InsertMessage(ctx, model.ThreadMessage{TaskID: taskID, Author: author, Body: input.Body, ReplyTo: input.ReplyTo})
		if err != nil {
			return err
		}
		failure.MessageID = message.ID
		if err := tx.PrepareTimestamp(ctx, &message, head); err != nil {
			return err
		}
		encoded, err := admitThreadMessage(ctx, message)
		if err != nil {
			return err
		}
		valid, err := tx.CredentialValid(ctx, credential)
		if err != nil {
			return err
		}
		if !valid {
			return model.Unauthenticated(nil)
		}
		if err := tx.AdvanceHead(ctx, taskID, message.Position()); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		result = ThreadMessageDocument{Message: message, JSON: encoded}
		return nil
	})
	if err != nil {
		failure.Cause = err
		return ThreadMessageDocument{}, failure
	}
	return result, nil
}

func threadMessageTooLarge() error {
	return &model.Fault{Code: "payload_too_large", Message: "Complete encoded message exceeds 64 KiB."}
}

func admitThreadMessage(ctx context.Context, message model.ThreadMessage) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	normal, err := taskcodec.EncodeMessage(message, false)
	if err != nil {
		return nil, fmt.Errorf("encode thread message: %w", err)
	}
	details, err := taskcodec.EncodeMessage(message, true)
	if err != nil {
		return nil, fmt.Errorf("encode detailed thread message: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(normal) > taskcodec.MessageLimit || len(details) > taskcodec.MessageLimit {
		return nil, threadMessageTooLarge()
	}
	return normal, nil
}

func (s *TaskThreads) List(ctx context.Context, principal model.Principal, projectID, taskID string, input ThreadListRequest) (ThreadPageDocument, error) {
	ctx, cancel := context.WithTimeout(ctx, threadOperationTimeout)
	defer cancel()
	projectID, taskID, err := threadScope(principal, projectID, taskID)
	if err != nil {
		return ThreadPageDocument{}, err
	}
	if input.Count == 0 {
		input.Count = 50
	}
	if input.Count < 1 || input.Count > 100 {
		return ThreadPageDocument{}, invalidInput("Count must be an integer from 1 to 100.")
	}
	if input.BeforeID != nil && input.AfterID != nil || input.FromBeginning && (input.BeforeID != nil || input.AfterID != nil) {
		return ThreadPageDocument{}, invalidInput("Message boundaries and fromBeginning must not be combined.")
	}
	input.BeforeID, err = canonicalThreadID(input.BeforeID)
	if err != nil {
		return ThreadPageDocument{}, err
	}
	input.AfterID, err = canonicalThreadID(input.AfterID)
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
		var anchor *model.ThreadPosition
		id := input.AfterID
		if input.BeforeID != nil {
			id = input.BeforeID
		}
		if id != nil {
			message, err := snapshot.TaskDAO().ThreadMessage(ctx, taskID, *id)
			if err != nil {
				return threadMessageError(err)
			}
			position := message.Position()
			anchor = &position
		}
		before := input.AfterID == nil && !input.FromBeginning
		candidates, err := snapshot.TaskDAO().ThreadCandidates(ctx, taskID, anchor, before, input.Count+1)
		if err != nil {
			return err
		}
		page, err := selectThreadPage(ctx, candidates, input.Count, input.Details, before)
		if err != nil {
			return err
		}
		if len(page.Items) > 0 {
			page.HasMoreBefore, page.HasMoreAfter, err = snapshot.TaskDAO().ThreadSides(ctx, taskID, page.Items[0].Position(), page.Items[len(page.Items)-1].Position())
			if err != nil {
				return err
			}
		}
		encoded, err := taskcodec.EncodePage(page, input.Details)
		if err != nil {
			return fmt.Errorf("encode thread page: %w", err)
		}
		if len(encoded) > taskcodec.PageLimit {
			return errors.New("encoded thread page exceeds byte budget")
		}
		if err := ctx.Err(); err != nil {
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

func selectThreadPage(ctx context.Context, candidates []model.ThreadMessage, count int, details, reverse bool) (model.ThreadPage, error) {
	page := model.ThreadPage{Items: make([]model.ThreadMessage, 0, min(count, len(candidates)))}
	empty, err := taskcodec.EncodePage(page, details)
	if err != nil {
		return model.ThreadPage{}, err
	}
	size := len(empty)
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return model.ThreadPage{}, err
		}
		if len(page.Items) == count {
			break
		}
		encoded, err := taskcodec.EncodeMessage(candidate, details)
		if err != nil {
			return model.ThreadPage{}, err
		}
		extra := len(encoded)
		if len(page.Items) > 0 {
			extra++
		}
		if size+extra > taskcodec.PageLimit {
			if len(page.Items) == 0 {
				return model.ThreadPage{}, errors.New("stored thread message cannot fit in a page")
			}
			break
		}
		size += extra
		page.Items = append(page.Items, candidate)
	}
	if reverse {
		slices.Reverse(page.Items)
	}
	if err := ctx.Err(); err != nil {
		return model.ThreadPage{}, err
	}
	return page, nil
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
