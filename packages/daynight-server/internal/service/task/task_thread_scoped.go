package task

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ScopedTaskThreads preserves the original resource transaction while admitting
// each operation against its authenticated credential policy.
type ScopedTaskThreads struct{ threads *TaskThreads }

func NewScopedTaskThreads(threads *TaskThreads) *ScopedTaskThreads {
	return &ScopedTaskThreads{threads: threads}
}

func (s *ScopedTaskThreads) List(ctx context.Context, auth model.CredentialAuthorization, projectID, taskID string, input ThreadListRequest) (ThreadPageDocument, error) {
	if err := auth.Validate(); err != nil {
		return ThreadPageDocument{}, err
	}
	threads := *s.threads
	threads.admitRead = func(credential store.ThreadCredential) error {
		current := auth
		if auth.Profile == model.ScopedPATProfile || auth.Profile == model.ScopedMCPProfile {
			current.Policy = credential.ScopePolicy
		}
		return scopeadmission.Require(current, scopepolicy.ThreadRead)
	}
	return threads.List(ctx, auth.Principal, projectID, taskID, input)
}

func (s *ScopedTaskThreads) Post(ctx context.Context, auth model.CredentialAuthorization, projectID, taskID string, input CreateThreadMessage) (ThreadMessageDocument, error) {
	if err := auth.Validate(); err != nil {
		return ThreadMessageDocument{}, err
	}
	threads := *s.threads
	receipt := input.Receipt
	threads.admitPost = func(credential store.ThreadCredential) error {
		current := auth
		if auth.Profile == model.ScopedMCPProfile || auth.Profile == model.ScopedPATProfile {
			// The transaction reads the policy after locking the credential
			// (grant then access for MCP), so edits cannot race admission.
			current.Policy = credential.ScopePolicy
		}
		if input.AutoReceipt {
			if err := scopeadmission.Require(current, scopepolicy.ThreadPost); err != nil {
				return err
			}
			if err := scopeadmission.Require(current, scopepolicy.ThreadRead); err != nil {
				if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
					return err
				}
				receipt = true
			}
			return nil
		}
		if !receipt {
			return scopeadmission.Require(current, scopepolicy.ThreadPost, scopepolicy.ThreadRead)
		}
		return scopeadmission.Require(current, scopepolicy.ThreadPost)
	}
	doc, err := threads.Post(ctx, auth.Principal, projectID, taskID, input)
	if err != nil || !receipt {
		return doc, err
	}
	// This receipt contains only the identity of the newly committed message.
	projectID, _ = model.CanonicalID(projectID)
	doc.JSON, _ = json.Marshal(struct {
		ProjectID string `json:"projectId"`
		TaskID    string `json:"taskId"`
		MessageID string `json:"messageId"`
	}{projectID, doc.Message.TaskID, doc.Message.ID})
	doc.JSON = append(doc.JSON, '\n')
	return doc, nil
}
