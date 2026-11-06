package attachment

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func (s *scope) PutAttachment(ctx context.Context, input model.Attachment) (model.Attachment, bool, error) {
	return putAttachment(ctx, s.tx, input)
}

func (s *scope) DeleteAttachment(ctx context.Context, projectID, taskID, path string) error {
	return deleteAttachment(ctx, s.tx, projectID, taskID, path)
}
