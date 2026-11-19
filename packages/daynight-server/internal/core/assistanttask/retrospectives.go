package assistanttask

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const retrospectivePeriod = 7 * 24 * time.Hour

// retrospectiveDue decides a periodic retrospective from facts read under the
// task lock. The window starts at the previous periodic retrospective, or at
// task creation before the first one, and needs a newer outcome record.
func retrospectiveDue(task model.AssistantTask, latestOutcome *time.Time, now time.Time) (time.Time, bool) {
	since := task.CreatedAt
	if task.LastRetrospectiveAt != nil {
		since = *task.LastRetrospectiveAt
	}
	due := task.State == "active" && task.HolderBotID != nil && !task.HolderDeleted && !now.Before(since.Add(retrospectivePeriod)) && latestOutcome != nil && latestOutcome.After(since)
	return since, due
}

// periodicRetrospective runs during an event pull instead of a scheduler. The
// caller holds the task lock, so concurrent pulls observe the moved window and
// produce one event.
func (m *Module) periodicRetrospective(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask) error {
	latest, err := dao.LatestOutcomeAt(ctx, task.OwnerUserID, task.ID)
	if err != nil {
		return err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return err
	}
	since, due := retrospectiveDue(task, latest, now)
	if !due {
		return nil
	}
	if _, err = m.systemEvent(ctx, dao, task, *task.HolderBotID, "retrospective", map[string]any{"reason": "periodic", "since": since}, now); err != nil {
		return err
	}
	ok, err := dao.MarkRetrospective(ctx, task.OwnerUserID, task.ID, now)
	if err != nil {
		return err
	}
	if !ok {
		return conflict()
	}
	return nil
}
