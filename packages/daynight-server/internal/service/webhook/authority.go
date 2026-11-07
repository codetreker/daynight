package webhook

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func fault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func authorize(ctx context.Context, scope store.WebhookReadScope, principal model.Principal, owner Owner) (bool, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return false, err
	}
	if _, err := scope.CredentialDAO().Credential(ctx, principal); err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return false, model.Unauthenticated(err)
		}
		return false, err
	}
	switch owner.Kind {
	case "user":
		if owner.ID != principal.UserID {
			return false, fault("forbidden", "Access to this owner is denied.")
		}
		return true, nil
	case "team":
		t, err := scope.TeamDAO().Team(ctx, principal.UserID, owner.ID)
		if errors.Is(err, model.ErrNotFound) {
			return false, fault("forbidden", "Access to this owner is denied.")
		}
		if err != nil {
			return false, err
		}
		if t.Kind == "personal" {
			return false, fault("forbidden", "A personal team is not a shared webhook owner.")
		}
		return t.Membership.Role == model.ProjectAdmin, nil
	default:
		return false, fault("invalid_input", "Invalid webhook owner.")
	}
}
