package team

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

// InvitationsAdmitted retains only the prefix accepted by the wire encoder.
func (s *Teams) InvitationsAdmitted(ctx context.Context, p model.Principal, id string, request model.PageRequest, measure func([]model.TeamInvitation, *string) error) (core.InvitationPage, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return core.InvitationPage{}, err
	}
	result := core.InvitationPage{Items: []model.TeamInvitation{}}
	one := request
	one.Limit = 1
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error {
			// Validate the original limit even for an empty result.
			if request.Limit < 1 || request.Limit > 100 {
				return &model.Fault{Code: "invalid_input", Message: "Limit must be between 1 and 100."}
			}
			observed := s.now()
			clock := func() time.Time { return observed }
			for len(result.Items) < request.Limit {
				page, err := core.ListInvitationPage(ctx, sc.TeamDAO(), p, id, one, clock)
				if err != nil {
					return err
				}
				if len(page.Items) == 0 {
					return nil
				}
				result.Items = append(result.Items, page.Items[0])
				if err := measure(result.Items, page.NextCursor); err != nil {
					var violation *limit.Violation
					if !errors.As(err, &violation) {
						return err
					}
					result.Items = result.Items[:len(result.Items)-1]
					if len(result.Items) == 0 {
						return &model.Fault{Code: "resource_limit_exceeded", Message: "Invitation exceeds the encoded page limit.", Cause: err}
					}
					result.NextCursor = one.Cursor
					return nil
				}
				if page.NextCursor == nil {
					return nil
				}
				one.Cursor = page.NextCursor
			}
			result.NextCursor = one.Cursor
			return nil
		}, &refusal)
	})
	if err != nil {
		return core.InvitationPage{}, err
	}
	if refusal != nil {
		return core.InvitationPage{}, refusal
	}
	return result, nil
}
