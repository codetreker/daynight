package store

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// TeamItemStore separates bounded field reads from full-resource readers.
type TeamItemStore interface {
	ReadTeamItem(context.Context, func(TeamItemReader) error) error
	AuthorizeTeamItem(context.Context, model.TeamItemAuthority, model.TeamItemTarget) error
}

type TeamItemReader interface {
	Metadata(context.Context, model.Principal, model.TeamItemTarget) (model.TeamItemMetadata, error)
	FieldBytes(context.Context, model.TeamItemTarget, string, int64, int) ([]byte, error)
}
