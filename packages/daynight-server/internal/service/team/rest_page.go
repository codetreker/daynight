package team

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

// ListAdmitted reads one bounded candidate at a time in one snapshot. measure uses
// the actual protocol projection and includes the continuation cursor and newline.
func (s *Teams) ListAdmitted(ctx context.Context, p model.Principal, request model.PageRequest, measure func([]model.Team, *string) error) (core.TeamPage, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return core.TeamPage{}, err
	}
	if _, err := query.ListPage(request, query.ListScope{Kind: "teams", UserID: p.UserID}); err != nil {
		return core.TeamPage{}, err
	}
	result := core.TeamPage{Items: []model.Team{}}
	one := request
	one.Limit = 1
	var refusal *model.Fault
	err := s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error {
			for len(result.Items) < request.Limit {
				page, err := core.ListBounded(ctx, sc.TeamDAO(), p, one, core.MaxPageResponseJSONBytes)
				if err != nil {
					var fault *model.Fault
					if errors.As(err, &fault) && fault.Code == "payload_too_large" {
						if len(result.Items) > 0 {
							result.NextCursor = one.Cursor
							return nil
						}
						return &model.Fault{Code: "resource_limit_exceeded", Message: "Team exceeds the encoded page limit.", Cause: err}
					}
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
						return &model.Fault{Code: "resource_limit_exceeded", Message: "Team exceeds the encoded page limit.", Cause: err}
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
		return core.TeamPage{}, err
	}
	if refusal != nil {
		return core.TeamPage{}, refusal
	}
	return result, nil
}

// MembersAdmitted reads one profile at a time under a single snapshot and lets
// the protocol adapter admit the exact page envelope before retaining it.
func (s *Teams) MembersAdmitted(ctx context.Context, p model.Principal, id string, request model.PageRequest, measure func([]model.TeamMemberProfile, *string) error) (core.MemberPage, error) {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return core.MemberPage{}, err
	}
	if _, err := query.ListPage(request, query.ListScope{Kind: "team_members", UserID: p.UserID, TeamID: id}); err != nil {
		return core.MemberPage{}, err
	}
	result := core.MemberPage{Items: []model.TeamMemberProfile{}}
	one := request
	one.Limit = 1
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		return completion.Capture(func() error {
			for len(result.Items) < request.Limit {
				page, err := core.MembersPage(ctx, sc.TeamDAO(), p, id, one)
				if err != nil {
					var fault *model.Fault
					if errors.As(err, &fault) && fault.Code == "payload_too_large" {
						if len(result.Items) > 0 {
							result.NextCursor = one.Cursor
							return nil
						}
						return &model.Fault{Code: "resource_limit_exceeded", Message: "Team member exceeds the encoded page limit.", Cause: err}
					}
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
						return &model.Fault{Code: "resource_limit_exceeded", Message: "Team member exceeds the encoded page limit.", Cause: err}
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
		return core.MemberPage{}, err
	}
	if refusal != nil {
		return core.MemberPage{}, refusal
	}
	return result, nil
}
