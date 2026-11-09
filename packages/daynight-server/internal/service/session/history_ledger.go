package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
)

// BeginHistoryLedgerReserved uses the already connected grant delegation. It
// revalidates the current owner, parent authority and fence without consuming a
// grant again or exposing the owner's credential material to the Controller.
func (s *Service) BeginHistoryLedgerReserved(ctx context.Context, project, taskID, id string, writer sessioncore.ActiveHistoryWriter, reservation *sessioncore.ArchivePreflightReservation) (*sessioncore.ArchiveOperation, error) {
	var principal model.Principal
	e := s.controller(ctx, writer.Fence, func(access *sessioncore.Access) error {
		var err error
		principal, err = access.ActiveHistoryPrincipal(project, taskID, id, writer)
		return err
	})
	if e != nil {
		if reservation != nil {
			_ = reservation.Close()
		}
		return nil, e
	}
	return s.Execution.BeginArchiveReserved(ctx, principal, project, taskID, id, sessioncore.ArchiveV1Upload, reservation)
}
