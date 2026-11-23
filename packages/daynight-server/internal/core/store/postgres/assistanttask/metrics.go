package assistanttask

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

// metricsQuery is one statement so every aggregate reads the same snapshot even
// under the read-committed assistant task transaction. Both window bounds are
// inclusive and come from one database clock reading.
const metricsQuery = `WITH bounds AS (
	SELECT now_at AS observed_at, now_at - $3::bigint * interval '1 microsecond' AS window_start
	FROM (SELECT clock_timestamp() AS now_at) clock
), records AS (
	SELECT
		count(*) FILTER (WHERE r.kind='action') AS actions,
		count(*) FILTER (WHERE r.kind='outcome' AND r.outcome='effective') AS effective,
		count(*) FILTER (WHERE r.kind='outcome' AND r.outcome='ineffective') AS ineffective,
		count(*) FILTER (WHERE r.kind='outcome' AND r.outcome='inconclusive') AS inconclusive
	FROM assistant_task_records r, bounds b
	WHERE r.owner_user_id=$1 AND r.task_id=$2 AND r.created_at BETWEEN b.window_start AND b.observed_at
), events AS (
	SELECT
		count(*) FILTER (WHERE e.type='escalation') AS escalations,
		count(*) FILTER (WHERE e.type='result_unknown') AS unknown_results
	FROM assistant_task_events e, bounds b
	WHERE e.owner_user_id=$1 AND e.task_id=$2 AND e.created_at BETWEEN b.window_start AND b.observed_at
), closures AS (
	SELECT
		count(*) AS closures,
		count(*) FILTER (WHERE c.opened_at IS NULL) AS untimed,
		round(extract(epoch FROM avg(c.closed_at - c.opened_at)) * 1000000)::bigint AS average_us
	FROM assistant_task_item_closures c, bounds b
	WHERE c.owner_user_id=$1 AND c.task_id=$2 AND c.closed_at BETWEEN b.window_start AND b.observed_at
), recurring AS (
	SELECT count(*) AS items FROM (
		SELECT c.item_id FROM assistant_task_item_closures c, bounds b
		WHERE c.owner_user_id=$1 AND c.task_id=$2 AND c.episode>1 AND c.closed_at BETWEEN b.window_start AND b.observed_at
		UNION
		SELECT i.id FROM assistant_task_items i, bounds b
		WHERE i.owner_user_id=$1 AND i.task_id=$2 AND i.episode>1 AND i.opened_at BETWEEN b.window_start AND b.observed_at
	) recurred
)
SELECT b.observed_at, b.window_start, r.actions, r.effective, r.ineffective, r.inconclusive,
	e.escalations, e.unknown_results, c.closures, c.untimed, c.average_us, x.items
FROM bounds b, records r, events e, closures c, recurring x`

func (d *DAO) Metrics(ctx context.Context, owner, task string, window time.Duration) (model.AssistantTaskMetrics, error) {
	var v model.AssistantTaskMetrics
	var average *int64
	err := d.tx.QueryRow(ctx, metricsQuery, owner, task, window.Microseconds()).Scan(&v.ObservedAt, &v.WindowStart, &v.ActionCount, &v.EffectiveCount, &v.IneffectiveCount, &v.InconclusiveCount, &v.EscalationCount, &v.ResultUnknownCount, &v.ClosureCount, &v.UntimedClosureCount, &average, &v.RecurringItemCount)
	if err != nil {
		return model.AssistantTaskMetrics{}, pg.QueryError("read assistant task metrics", err)
	}
	v.ObservedAt, v.WindowStart = v.ObservedAt.UTC(), v.WindowStart.UTC()
	v.WindowEnd = v.ObservedAt
	if average != nil {
		resolution := time.Duration(*average) * time.Microsecond
		v.AverageResolution = &resolution
	}
	return v, nil
}
