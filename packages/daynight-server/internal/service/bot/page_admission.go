package bot

import (
	"context"
	"errors"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

// ListAdmitted uses one snapshot and one bounded candidate at a time; the
// protocol adapter measures its exact output, including the cursor.
func (s *Bots) ListAdmitted(ctx context.Context, principal model.Principal, workerID *string, request model.PageRequest, measure func([]model.Bot, *string) error) (botcore.BotPage, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return botcore.BotPage{}, err
	}
	if workerID != nil {
		id, err := model.CanonicalID(*workerID)
		if err != nil {
			return botcore.BotPage{}, err
		}
		workerID = &id
	}
	if _, err := botcore.ListPage(principal, workerID, request); err != nil {
		return botcore.BotPage{}, err
	}
	result := botcore.BotPage{Items: []model.Bot{}}
	one := request
	one.Limit = 1
	var refusal *model.Fault
	err := s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		return completion.Capture(func() error {
			for len(result.Items) < request.Limit {
				page, err := botcore.ListPage(principal, workerID, one)
				if err != nil {
					return err
				}
				records, err := botcore.ListBounded(ctx, snapshot, principal, workerID, page)
				if err != nil {
					return err
				}
				if records.OversizedBotID != "" {
					if len(result.Items) > 0 {
						result.NextCursor = one.Cursor
						return nil
					}
					return &model.Fault{Code: "resource_limit_exceeded", Message: "Bot exceeds the encoded page limit."}
				}
				candidate, err := botcore.ListResult(principal, workerID, records)
				if err != nil {
					return err
				}
				if len(candidate.Items) == 0 {
					return nil
				}
				result.Items = append(result.Items, candidate.Items[0])
				if err := measure(result.Items, candidate.NextCursor); err != nil {
					var violation *limit.Violation
					if !errors.As(err, &violation) {
						return err
					}
					result.Items = result.Items[:len(result.Items)-1]
					if len(result.Items) == 0 {
						return &model.Fault{Code: "resource_limit_exceeded", Message: "Bot exceeds the encoded page limit.", Cause: err}
					}
					result.NextCursor = one.Cursor
					return nil
				}
				if candidate.NextCursor == nil {
					return nil
				}
				one.Cursor = candidate.NextCursor
			}
			result.NextCursor = one.Cursor
			return nil
		}, &refusal)
	})
	if err != nil {
		return botcore.BotPage{}, botcore.ResultError("list", err)
	}
	if refusal != nil {
		return botcore.BotPage{}, refusal
	}
	return result, nil
}
