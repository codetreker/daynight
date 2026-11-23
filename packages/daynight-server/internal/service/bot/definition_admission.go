package bot

import (
	"context"
	"errors"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// DefinitionAuthorizationSource supplies current authorization bound to the
// original principal. Write methods must lock the credential and its policy in
// the supplied transaction for the lifetime of that transaction, including
// grant before access for OAuth. They return facts, not scope decisions.
type DefinitionAuthorizationSource interface {
	Read(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error)
	BotWrite(context.Context, store.BotScope, model.Principal) (model.CredentialAuthorization, error)
	SessionWrite(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error)
}

func requireDefinition(p model.Principal, authorization model.CredentialAuthorization, err error, operations ...scopepolicy.Operation) error {
	if err != nil {
		return err
	}
	if authorization.Principal != p {
		return errors.New("definition authorization principal mismatch")
	}
	definition := make([]scopepolicy.Operation, 0, len(operations))
	other := make([]scopepolicy.Operation, 0, len(operations))
	for _, operation := range operations {
		switch operation {
		case scopepolicy.SessionRead, scopepolicy.WorkerRead, scopepolicy.WorkerInspect, scopepolicy.AssistantTaskRead:
			other = append(other, operation)
		default:
			definition = append(definition, operation)
		}
	}
	if err := botcore.RequireDefinition(authorization, definition...); err != nil {
		return err
	}
	if len(other) > 0 && authorization.Policy != nil {
		required, err := scopepolicy.Requirements(other...)
		if err != nil {
			return err
		}
		if err = authorization.Policy.Require(required...); errors.Is(err, scopepolicy.ErrInsufficientScope) {
			return &model.Fault{Code: "insufficient_scope", Message: "Credential scope is insufficient.", Cause: err}
		} else if err != nil {
			return err
		}
	}
	return nil
}

func definitionProjection(ctx context.Context, operations ...scopepolicy.Operation) []scopepolicy.Operation {
	if botcore.AttentionProjectionRequested(ctx) {
		operations = append(operations, scopepolicy.AssistantTaskRead)
	}
	return operations
}

func (s *Bots) discoveryAdmission(ctx context.Context, p model.Principal, operations ...scopepolicy.Operation) error {
	if s.authorization == nil {
		return nil
	}
	err := s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		return s.readAdmission(ctx, scope, p, operations...)
	})
	if err != nil {
		return definitionResultError("discovery", err)
	}
	return nil
}

// A direct refusal from a completed read is known. Transaction errors retain
// their completion and cleanup facts for the existing result classifier.
func definitionResultError(operation string, err error) error {
	if fault, ok := err.(*model.Fault); ok && fault.Code == "insufficient_scope" {
		return fault
	}
	return botcore.ResultError(operation, err)
}

func (s *Bots) readAdmission(ctx context.Context, scope store.SnapshotScope, p model.Principal, operations ...scopepolicy.Operation) error {
	if s.authorization == nil {
		return nil
	}
	authorization, err := s.authorization.Read(ctx, scope, p)
	return requireDefinition(p, authorization, err, operations...)
}
