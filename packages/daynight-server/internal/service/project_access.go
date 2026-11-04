package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Projects) Access(ctx context.Context, principal core.Principal, projectID string) (core.ProjectAccess, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.ProjectAccess{}, err
	}
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return core.ProjectAccess{}, err
	}
	var result core.ProjectAccess
	var refusal *Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		var err error
		result, err = RequireProjectRead(ctx, snapshot, principal, projectID)
		if errors.As(err, &refusal) {
			return nil
		}
		return err
	})
	if err != nil {
		return core.ProjectAccess{}, fmt.Errorf("read project access: %w", err)
	}
	if refusal != nil {
		return core.ProjectAccess{}, refusal
	}
	return result, nil
}
