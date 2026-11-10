package webhook

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RefreshEligibility invalidates a continuous authorization only when all
// current sources have actually disappeared. A later source never reactivates it.
func RefreshEligibility(ctx context.Context, dao store.WebhookEligibilityDAO, filter store.WebhookEligibilityFilter) error {
	rows, err := dao.LockAffected(ctx, filter)
	if err != nil {
		return err
	}
	for _, row := range rows {
		eligibility, err := dao.ReadEligibility(ctx, row.Owner, row.ProjectID, "")
		if err != nil {
			return err
		}
		if row.State == "active" && eligibility.Status != "eligible" {
			if err := dao.Revoke(ctx, row.ID, row.Epoch); err != nil {
				return fmt.Errorf("refresh webhook eligibility: %w", err)
			}
		}
	}
	return nil
}
