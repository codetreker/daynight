package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Projects) Access(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	if err := requirePrincipal(principal); err != nil {
		return model.ProjectAccess{}, err
	}
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return model.ProjectAccess{}, err
	}
	var result model.ProjectAccess
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		var err error
		result, err = RequireProjectRead(ctx, snapshot, principal, projectID)
		if errors.As(err, &refusal) {
			return nil
		}
		return err
	})
	if err != nil {
		return model.ProjectAccess{}, fmt.Errorf("read project access: %w", err)
	}
	if refusal != nil {
		return model.ProjectAccess{}, refusal
	}
	return result, nil
}
