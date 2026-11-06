package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// TransferTeam is the minimal Team metadata needed to confirm a transfer.
type TransferTeam struct {
	Ref     model.TeamRef
	Version int64
}
