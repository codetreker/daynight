package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/attachment"
)

func (s *Store) PutAttachment(ctx context.Context, value model.Attachment) (model.Attachment, bool, error) {
	return attachment.NewWriter(s.Pool).PutAttachment(ctx, value)
}

func (s *Store) DeleteAttachment(ctx context.Context, projectID, taskID, path string) error {
	return attachment.NewWriter(s.Pool).DeleteAttachment(ctx, projectID, taskID, path)
}
