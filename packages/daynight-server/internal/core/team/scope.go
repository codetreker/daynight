package team

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// RequireScope checks the authenticated policy without replacing Team role or
// resource authorization. Fixed profiles retain their existing restrictions.
func RequireScope(auth model.CredentialAuthorization, operations ...scopepolicy.Operation) error {
	if err := auth.Validate(); err != nil {
		return fmt.Errorf("invalid Team credential authorization: %w", err)
	}
	required, err := scopepolicy.Requirements(operations...)
	if err != nil {
		return err
	}
	if auth.Policy == nil {
		return nil
	}
	if err := auth.Policy.Require(required...); err != nil {
		if errors.Is(err, scopepolicy.ErrInsufficientScope) {
			return &model.Fault{Code: "insufficient_scope", Message: "Credential scope is insufficient.", Cause: err}
		}
		return err
	}
	return nil
}

type scopeCheckKey struct{}

// WithScopeCheck installs the request's business admission at the Team boundary.
// A scoped service must supply this check; legacy assembly leaves it absent.
func WithScopeCheck(ctx context.Context, check func(context.Context, model.Principal, ...scopepolicy.Operation) error) context.Context {
	return context.WithValue(ctx, scopeCheckKey{}, check)
}

func checkScope(ctx context.Context, p model.Principal, operations ...scopepolicy.Operation) error {
	check, ok := ctx.Value(scopeCheckKey{}).(func(context.Context, model.Principal, ...scopepolicy.Operation) error)
	if !ok || check == nil {
		return nil
	}
	return check(ctx, p, operations...)
}
