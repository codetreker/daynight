// Package attachment owns the attachment wire projections shared by readers and HTTP.
package attachment

import (
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func REST(item model.Attachment) api.Attachment {
	return api.Attachment{Path: item.Path, ContentType: item.ContentType, SizeBytes: item.SizeBytes,
		CreatedAt: item.CreatedAt.UTC(), UpdatedAt: item.UpdatedAt.UTC()}
}
