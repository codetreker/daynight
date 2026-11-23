package project

import (
	"context"
	"errors"
	"time"

	identity "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
)

type DirectMembers struct {
	writer   store.ProjectDirectMemberWriter
	resource string
	now      func() time.Time
}

func NewDirectMembers(writer store.ProjectDirectMemberWriter, resource string) *DirectMembers {
	return &DirectMembers{writer: writer, resource: resource, now: time.Now}
}
func (s *DirectMembers) AddExistingMember(ctx context.Context, p model.Principal, projectID, target, expected string) (core.ExistingMemberResult, error) {
	return s.addExistingMember(ctx, p, projectID, target, expected, nil)
}

func (s *DirectMembers) addExistingMember(ctx context.Context, p model.Principal, projectID, target, expected string, admit func(context.Context, store.ProjectDirectMemberScope) error) (core.ExistingMemberResult, error) {
	id, user, err := core.ValidateExistingMember(p, projectID, target, expected)
	if err != nil {
		return core.ExistingMemberResult{}, err
	}
	var result core.ExistingMemberResult
	credential := identity.NewIdentity("")
	completion, err := s.writer.WriteProjectDirectMember(ctx, id, func(scope store.ProjectDirectMemberScope) error {
		lock := func() error {
			return credential.LockProfileCredential(ctx, scope.IdentityDAO(), scope.CredentialFamilyDAO(), p, s.resource, s.now().UTC())
		}
		if err := lock(); err != nil {
			return err
		}
		if admit != nil {
			access, err := core.RequireProjectWrite(ctx, scope.ProjectDAO(), p)
			if err != nil {
				return err
			}
			if err := core.RequireProjectAdmin(access); err != nil {
				return err
			}
			if err := admit(ctx, scope); err != nil {
				return err
			}
		}
		var err error
		result, err = core.AddExistingMember(ctx, scope.ProjectDAO(), scope.DirectMemberDAO(), p, user)
		if err != nil {
			return err
		}
		if result.Added {
			if err = webhook.RefreshEligibility(ctx, scope.EligibilityDAO(), store.WebhookEligibilityFilter{ProjectID: id, UserID: user}); err != nil {
				return err
			}
		}
		if err := lock(); err != nil {
			return err
		}
		if admit != nil {
			return admit(ctx, scope)
		}
		return nil
	})
	if completion.Outcome == store.TransactionUnknown && err == nil {
		return core.ExistingMemberResult{}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("Project direct member transaction completion was not confirmed")}
	}
	if err != nil {
		return core.ExistingMemberResult{}, core.ProjectWriteError(err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return core.ExistingMemberResult{}, errors.New("Project direct member transaction did not confirm commit")
	}
	return result, nil
}
