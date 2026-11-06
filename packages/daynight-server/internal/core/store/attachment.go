package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type AttachmentQuery struct {
	After *string
	Limit int
	// Each zero limit preserves the corresponding complete field. Oversized
	// values are omitted and marked in the result.
	MaxPathBytes  int
	MaxFieldBytes int
}

type AttachmentPage struct {
	Items     []model.Attachment
	HasMore   bool
	Oversized []bool
}
