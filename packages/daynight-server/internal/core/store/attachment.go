package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type AttachmentQuery struct {
	After *string
	Limit int
	// MaxFieldBytes bounds each projected path and content type. Zero preserves
	// the full fields. Oversized values are omitted and marked in the result.
	MaxFieldBytes int
}

type AttachmentPage struct {
	Items     []model.Attachment
	HasMore   bool
	Oversized []bool
}
