package service

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func writeProjectForTest(s *postgres.Store, ctx context.Context, id string, operation func(store.ProjectWriteScope) error) error {
	_, err := s.WriteProject(ctx, id, operation)
	return err
}
