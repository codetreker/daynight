package service

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func writeProjectForTest(s *store.Store, ctx context.Context, id string, operation func(store.ProjectWriteScope) error) error {
	_, err := s.WriteProject(ctx, id, operation)
	return err
}
