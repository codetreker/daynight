package thread

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
)

func MessageTooLarge() error {
	return &model.Fault{Code: "payload_too_large", Message: "Complete encoded message exceeds 64 KiB."}
}

func AdmitMessage(ctx context.Context, message model.ThreadMessage) ([]byte, error) {
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
		return nil, MessageTooLarge()
	}
	return normal, nil
}

func SelectPage(ctx context.Context, candidates []model.ThreadMessage, count int, reverse bool) (model.ThreadPage, error) {
	if err := ctx.Err(); err != nil {
		return model.ThreadPage{}, err
	}
	page := model.ThreadPage{Items: make([]model.ThreadMessage, min(count, len(candidates)))}
	copy(page.Items, candidates)
	if reverse {
		slices.Reverse(page.Items)
	}
	if err := ctx.Err(); err != nil {
		return model.ThreadPage{}, err
	}
	return page, nil
}

// Append freezes attribution and appends under the already acquired Task,
// credential and Project authorization locks. The candidate is returned even on
// failure for safe diagnostics; it does not imply a committed message.
func Append(ctx context.Context, taskDAO store.ThreadTaskDAO, credentialDAO store.ThreadCredentialDAO, dao store.ThreadDAO, principal model.Principal, projectID, taskID, body string, replyTo, claimID *string, credential store.ThreadCredential) (model.ThreadMessage, []byte, error) {
	name, err := credentialDAO.AuthorName(ctx, principal.UserID)
	if err != nil {
		return model.ThreadMessage{}, nil, err
	}
	message := model.ThreadMessage{TaskID: taskID, Author: model.ThreadAuthor{UserID: principal.UserID, DisplayName: name}, Body: body, ReplyTo: replyTo}
	if claimID != nil {
		current, err := taskDAO.SourceTask(ctx, projectID, taskID)
		if err != nil {
			return message, nil, err
		}
		worker, err := taskcore.ActiveWorker(current, *claimID)
		if err != nil {
			return message, nil, err
		}
		if worker.UserID != principal.UserID {
			return message, nil, &model.Fault{Code: "forbidden", Message: "Only the current execution owner may use this claim."}
		}
		message.Author.Agent = true
		message.Author.Execution = &model.ThreadExecution{ClaimID: worker.ClaimID, WorkerID: worker.WorkerID, Provider: string(worker.Agent)}
	}
	head, err := dao.LockHead(ctx, taskID)
	if err != nil {
		return message, nil, err
	}
	if replyTo != nil {
		if _, err := dao.ThreadMessage(ctx, taskID, *replyTo); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				err = &model.Fault{Code: "message_not_found", Message: "Message was not found in this task.", Cause: err}
			}
			return message, nil, err
		}
	}
	inserted, err := dao.InsertMessage(ctx, message)
	if err != nil {
		return message, nil, err
	}
	message = inserted
	if err := dao.PrepareTimestamp(ctx, &message, head); err != nil {
		return message, nil, err
	}
	encoded, err := AdmitMessage(ctx, message)
	if err != nil {
		return message, nil, err
	}
	valid, err := credentialDAO.CredentialValid(ctx, credential)
	if err != nil {
		return message, nil, err
	}
	if !valid {
		return message, nil, model.Unauthenticated(nil)
	}
	if err := dao.AdvanceHead(ctx, taskID, message.Position()); err != nil {
		return message, nil, err
	}
	if err := ctx.Err(); err != nil {
		return message, nil, err
	}
	return message, encoded, nil
}

type PageRequest struct {
	BeforeID      *string
	AfterID       *string
	Count         int
	Details       bool
	FromBeginning bool
}

// ReadPage reads anchors, candidates and both page sides in the same snapshot.
type Reader interface {
	ThreadMessage(context.Context, string, string) (model.ThreadMessage, error)
	ThreadCandidates(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error)
	ThreadSides(context.Context, string, model.ThreadPosition, model.ThreadPosition) (bool, bool, error)
}

func ReadPage(ctx context.Context, dao Reader, taskID string, input PageRequest) (model.ThreadPage, []byte, error) {
	var anchor *model.ThreadPosition
	id := input.AfterID
	if input.BeforeID != nil {
		id = input.BeforeID
	}
	if id != nil {
		message, err := dao.ThreadMessage(ctx, taskID, *id)
		if err != nil {
			if errors.Is(err, model.ErrNotFound) {
				err = &model.Fault{Code: "message_not_found", Message: "Message was not found in this task.", Cause: err}
			}
			return model.ThreadPage{}, nil, err
		}
		position := message.Position()
		anchor = &position
	}
	before := input.AfterID == nil && !input.FromBeginning
	candidates, err := dao.ThreadCandidates(ctx, taskID, anchor, before, input.Count+1)
	if err != nil {
		return model.ThreadPage{}, nil, err
	}
	page, err := SelectPage(ctx, candidates, input.Count, before)
	if err != nil {
		return model.ThreadPage{}, nil, err
	}
	if len(page.Items) > 0 {
		page.HasMoreBefore, page.HasMoreAfter, err = dao.ThreadSides(ctx, taskID, page.Items[0].Position(), page.Items[len(page.Items)-1].Position())
		if err != nil {
			return model.ThreadPage{}, nil, err
		}
	}
	encoded, err := taskcodec.EncodePage(page, input.Details)
	if err != nil {
		return model.ThreadPage{}, nil, fmt.Errorf("encode thread page: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return model.ThreadPage{}, nil, err
	}
	return page, encoded, nil
}

func ValidateMessage(body string, replyTo, claimID *string) (*string, *string, error) {
	if !utf8.ValidString(body) || strings.ContainsRune(body, 0) || strings.TrimSpace(body) == "" {
		return nil, nil, &model.Fault{Code: "invalid_input", Message: "Message body must be nonempty UTF-8 text without NUL characters."}
	}
	if len(body) > taskcodec.MessageLimit {
		return nil, nil, MessageTooLarge()
	}
	reply, err := canonicalID(replyTo)
	if err != nil {
		return nil, nil, err
	}
	claim, err := canonicalID(claimID)
	return reply, claim, err
}

func ValidatePage(input PageRequest) (PageRequest, error) {
	if input.Count == 0 {
		input.Count = 50
	}
	if input.Count < 1 || input.Count > 100 {
		return input, &model.Fault{Code: "invalid_input", Message: "Count must be an integer from 1 to 100."}
	}
	if input.BeforeID != nil && input.AfterID != nil || input.FromBeginning && (input.BeforeID != nil || input.AfterID != nil) {
		return input, &model.Fault{Code: "invalid_input", Message: "Message boundaries and fromBeginning must not be combined."}
	}
	var err error
	input.BeforeID, err = canonicalID(input.BeforeID)
	if err != nil {
		return input, err
	}
	input.AfterID, err = canonicalID(input.AfterID)
	return input, err
}

func canonicalID(id *string) (*string, error) {
	if id == nil {
		return nil, nil
	}
	value, err := model.CanonicalID(*id)
	return &value, err
}
