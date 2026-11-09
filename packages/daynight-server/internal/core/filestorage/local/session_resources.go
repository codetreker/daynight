package local

import (
	"context"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"strings"
)

func (s *Storage) DeleteSessionResources(ctx context.Context, n sessionresource.Namespace) error {
	if n.Directory() == "" {
		return fmt.Errorf("%w: invalid resource namespace", filestorage.ErrInvalidAddress)
	}
	return s.deleteNamespace(ctx, append([]string{sessionresource.Bucket}, strings.Split(n.Directory(), "/")...))
}

func (s *Storage) DeleteSessionUpload(ctx context.Context, n sessionresource.Namespace, uploadID string) error {
	path, err := n.UploadPath(uploadID)
	if err != nil {
		return fmt.Errorf("%w: %w", filestorage.ErrInvalidAddress, err)
	}
	return s.deleteNamespace(ctx, append([]string{sessionresource.Bucket}, strings.Split(path, "/")...))
}
