package webhook

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// A missing joined event is different from an existing event with reclaimed bytes.
type historyEventRow struct {
	id, eventType, source, subject, projectID, taskID *string
	wireVersion, schemaVersion, factCodecVersion      *int16
	taskVersion, stepID                               *int64
	taskDeletedAt                                     *time.Time
	messageID, originRequestID                        *string
	occurredAt, recordedAt                            *time.Time
	factBytes, factSHA256                             []byte
	originalFactBytes                                 *int
	factRemovedAt                                     *time.Time
}

func (r *historyEventRow) destinations() []any {
	return []any{&r.id, &r.eventType, &r.wireVersion, &r.schemaVersion, &r.source, &r.subject,
		&r.projectID, &r.taskID, &r.taskVersion, &r.taskDeletedAt, &r.stepID, &r.messageID,
		&r.occurredAt, &r.recordedAt, &r.originRequestID, &r.factCodecVersion,
		&r.factBytes, &r.factSHA256, &r.originalFactBytes, &r.factRemovedAt}
}

func (r historyEventRow) sources() (store.WebhookHistorySources, bool, error) {
	if r.id == nil {
		return store.WebhookHistorySources{}, false, nil
	}
	if r.eventType == nil || r.wireVersion == nil || r.schemaVersion == nil || r.source == nil || r.subject == nil ||
		r.projectID == nil || r.taskID == nil || r.occurredAt == nil || r.recordedAt == nil || r.factCodecVersion == nil || r.originalFactBytes == nil {
		return store.WebhookHistorySources{}, false, fmt.Errorf("stored webhook history event has missing required fields")
	}
	return store.WebhookHistorySources{
		Event: store.WebhookCapturedEvent{ID: *r.id, EventType: *r.eventType, WireVersion: *r.wireVersion,
			SchemaVersion: *r.schemaVersion, Source: *r.source, Subject: *r.subject, ProjectID: *r.projectID,
			TaskID: *r.taskID, TaskVersion: r.taskVersion, TaskDeletedAt: r.taskDeletedAt, StepID: r.stepID,
			MessageID: r.messageID, OccurredAt: *r.occurredAt, RecordedAt: *r.recordedAt,
			OriginRequestID: r.originRequestID, FactCodecVersion: *r.factCodecVersion,
			FactBytes: r.factBytes, FactSHA256: r.factSHA256},
		OriginalFactBytes: *r.originalFactBytes, FactRemovedAt: r.factRemovedAt,
	}, true, nil
}

func qualifiedHistoryColumns(alias, columns string) string {
	return alias + "." + strings.ReplaceAll(columns, ",", ","+alias+".")
}

func (d *DAO) HistoryBatch(ctx context.Context, owner wm.Owner, endpoint, actor string, after time.Time, id string, limit int) (store.WebhookHistoryBatch, error) {
	rows, err := d.tx.Query(ctx, `WITH candidates AS MATERIALIZED (
		SELECT d.* FROM webhook_deliveries d
		WHERE owner_kind=$1 AND owner_id=$2 AND endpoint_id=$3 AND `+retainedHistory+`
		AND ($4::timestamptz IS NULL OR (occurred_at,id)>($4,$5::uuid))
		ORDER BY occurred_at,id LIMIT $6
	)
	SELECT `+qualifiedHistoryColumns("d", deliveryColumns)+`,
		e.id::text,e.event_type,e.wire_version,e.schema_version,e.source,e.subject,e.project_id::text,e.task_id::text,
		e.task_version,e.task_deleted_at,e.step_id,e.message_id::text,e.occurred_at,e.recorded_at,e.origin_request_id,
		e.fact_codec_version,e.fact_bytes,e.fact_sha256,e.original_fact_bytes,e.fact_removed_at,
		t.id IS NOT NULL,t.title,
		p.id IS NOT NULL AND p.deleted_at IS NULL,p.name,po.team_id::text,team.id IS NOT NULL,
		access.owner_access,access.actor_access,
		p.id IS NOT NULL AND p.deleted_at IS NULL AND po.project_id IS NOT NULL AND team.id IS NOT NULL AND access.actor_access,
		ep.id IS NOT NULL,ep.deleted_at,ep.destination_revision,statement_timestamp()
	FROM candidates d
	LEFT JOIN webhook_events e ON e.id=d.event_id
	LEFT JOIN task_resource_rows t ON t.id=e.task_id AND t.project_id=e.project_id AND t.effective_deleted_at IS NULL
	LEFT JOIN projects p ON p.id=d.project_id
	LEFT JOIN project_ownership po ON po.project_id=p.id
	LEFT JOIN teams team ON team.id=po.team_id
	LEFT JOIN webhook_endpoints ep ON ep.id=d.endpoint_id AND ep.owner_kind=d.owner_kind AND ep.owner_id=d.owner_id
	CROSS JOIN LATERAL (SELECT
		EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=po.team_id AND m.user_id=d.owner_id)
		OR EXISTS(SELECT 1 FROM project_grants g WHERE g.project_id=d.project_id AND g.user_id=d.owner_id) AS owner_access,
		EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=po.team_id AND m.user_id=$7::uuid)
		OR EXISTS(SELECT 1 FROM project_grants g WHERE g.project_id=d.project_id AND g.user_id=$7::uuid) AS actor_access
	) access
	ORDER BY d.occurred_at,d.id`, owner.Kind, owner.ID, endpoint, nullableTime(after), nullableString(id), limit, actor)
	if err != nil {
		return store.WebhookHistoryBatch{}, pg.QueryError("read webhook history batch", err)
	}
	defer rows.Close()
	batch := store.WebhookHistoryBatch{Items: []store.WebhookHistoryItem{}}
	for rows.Next() {
		var item store.WebhookHistoryItem
		var event historyEventRow
		var observed time.Time
		var taskPresent, projectReadable bool
		var taskTitle *string
		tail := append(event.destinations(), &taskPresent, &taskTitle,
			&item.Eligibility.ProjectLive, &item.Eligibility.ProjectName, &item.Eligibility.TeamID, &item.Eligibility.TeamPresent,
			&item.Eligibility.OwnerAccess, &item.Eligibility.ActorAccess, &projectReadable,
			&item.EndpointPresent, &item.EndpointDeletedAt, &item.EndpointRevision, &observed)
		item.Delivery, err = scanDelivery(rows, tail...)
		if err != nil {
			return store.WebhookHistoryBatch{}, err
		}
		item.Sources, item.EventPresent, err = event.sources()
		if err != nil {
			return store.WebhookHistoryBatch{}, pg.QueryError("read webhook history batch event", err)
		}
		item.Sources.TaskPresent, item.Sources.TaskTitle, item.Sources.ProjectReadable = taskPresent, taskTitle, projectReadable
		batch.ObservedAt = observed.UTC()
		batch.Items = append(batch.Items, item)
	}
	if err = rows.Err(); err != nil {
		return store.WebhookHistoryBatch{}, pg.QueryError("read webhook history batch", err)
	}
	return batch, nil
}

func (d *DAO) HistoryMatches(ctx context.Context, ids []string) ([]store.WebhookHistoryMatch, error) {
	rows, err := d.tx.Query(ctx, `SELECT m.delivery_id::text,m.subscription_id::text,m.binding_id::text,m.project_id::text,m.event_type,m.authorization_epoch,
		COALESCE(s.endpoint_id=d.endpoint_id AND s.project_id=m.project_id AND s.owner_kind=d.owner_kind AND s.owner_id=d.owner_id
		AND s.authorization_state='active' AND s.authorization_epoch=m.authorization_epoch AND s.deleted_at IS NULL
		AND b.subscription_id=m.subscription_id AND b.event_type=m.event_type AND b.deleted_at IS NULL,false)
		FROM webhook_delivery_matches m JOIN webhook_deliveries d ON d.id=m.delivery_id
		LEFT JOIN webhook_subscriptions s ON s.id=m.subscription_id LEFT JOIN webhook_bindings b ON b.id=m.binding_id
		WHERE m.delivery_id=ANY($1::uuid[]) ORDER BY m.delivery_id,m.subscription_id,m.binding_id`, ids)
	if err != nil {
		return nil, pg.QueryError("read webhook history batch matches", err)
	}
	defer rows.Close()
	matches := []store.WebhookHistoryMatch{}
	for rows.Next() {
		var m store.WebhookHistoryMatch
		if err = rows.Scan(&m.DeliveryID, &m.SubscriptionID, &m.BindingID, &m.ProjectID, &m.EventType, &m.AuthorizationEpoch, &m.Continuous); err != nil {
			return nil, pg.QueryError("read webhook history batch matches", err)
		}
		matches = append(matches, m)
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook history batch matches", err)
	}
	return matches, nil
}

func (d *DAO) HistoryBatchAttempts(ctx context.Context, ids []string) ([]store.WebhookAttempt, error) {
	rows, err := d.tx.Query(ctx, `SELECT `+attemptColumns+` FROM webhook_attempts WHERE delivery_id=ANY($1::uuid[]) ORDER BY delivery_id,generation,sequence,id`, ids)
	if err != nil {
		return nil, pg.QueryError("read webhook history batch attempts", err)
	}
	defer rows.Close()
	attempts := []store.WebhookAttempt{}
	for rows.Next() {
		a, err := scanAttempt(rows)
		if err != nil {
			return nil, err
		}
		attempts = append(attempts, a)
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook history batch attempts", err)
	}
	return attempts, nil
}
