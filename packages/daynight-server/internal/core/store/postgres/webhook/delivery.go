package webhook

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/jackc/pgx/v5"
)

const deliveryColumns = `id::text,event_id::text,endpoint_id::text,event_type,project_id::text,owner_kind,owner_id::text,occurred_at,original_match_count,original_match_sha256,policy_version,destination_revision,adapter_version,destination_kind,destination_origin,render_version,configuration_schema_version,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,request_method,request_media_type,deterministic_headers_json,body,body_sha256,original_body_bytes,payload_removed_at,payload_removed_reason,automatic_schedule_at,automatic_expires_at,payload_expires_at,automatic_plan_cursor,automatic_attempt_count,manual_operation_count,attempt_sequence,automatic_open,generation,state,trigger,expires_at,next_attempt_at,manual_operation_id::text,lease_token::text,lease_claimed_at,lease_until,lease_generation,lease_plan_slot,current_attempt_id::text,terminal_at,last_activity_at,metadata_expires_at,preparation_error_code,queue_order,purging_at`

func (d *DAO) ObservedAt(ctx context.Context) (time.Time, error) {
	var now time.Time
	if err := d.tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return time.Time{}, pg.QueryError("read webhook delivery clock", err)
	}
	return now, nil
}

func scanDelivery(row pgx.Row) (store.WebhookDelivery, error) {
	var d store.WebhookDelivery
	var env secretbox.Envelope
	err := row.Scan(&d.ID, &d.EventID, &d.EndpointID, &d.EventType, &d.ProjectID, &d.Owner.Kind, &d.Owner.ID, &d.OccurredAt, &d.OriginalMatchCount, &d.OriginalMatchSHA256, &d.PolicyVersion, &d.DestinationRevision, &d.AdapterVersion, &d.DestinationKind, &d.DestinationOrigin, &d.RenderVersion, &d.ConfigurationSchemaVersion, &env.Version, &env.MasterKeyID, &env.Nonce, &env.Ciphertext, &d.RequestMethod, &d.RequestMediaType, &d.DeterministicHeadersJSON, &d.Body, &d.BodySHA256, &d.OriginalBodyBytes, &d.PayloadRemovedAt, &d.PayloadRemovedReason, &d.AutomaticScheduleAt, &d.AutomaticExpiresAt, &d.PayloadExpiresAt, &d.AutomaticPlanCursor, &d.AutomaticAttemptCount, &d.ManualOperationCount, &d.AttemptSequence, &d.AutomaticOpen, &d.Generation, &d.State, &d.Trigger, &d.ExpiresAt, &d.NextAttemptAt, &d.ManualOperationID, &d.LeaseToken, &d.LeaseClaimedAt, &d.LeaseUntil, &d.LeaseGeneration, &d.LeasePlanSlot, &d.CurrentAttemptID, &d.TerminalAt, &d.LastActivityAt, &d.MetadataExpiresAt, &d.PreparationErrorCode, &d.QueueOrder, &d.PurgingAt)
	if err != nil {
		return d, pg.QueryError("read webhook delivery", err)
	}
	d.DestinationCiphertext, err = env.MarshalBinary()
	return d, err
}

func (d *DAO) LockDelivery(ctx context.Context, id string) (store.WebhookDelivery, error) {
	return scanDelivery(d.tx.QueryRow(ctx, `SELECT `+deliveryColumns+` FROM webhook_deliveries WHERE id=$1 FOR UPDATE`, id))
}

func (d *DAO) TryLockDelivery(ctx context.Context, id string) (store.WebhookDelivery, bool, error) {
	row := d.tx.QueryRow(ctx, `SELECT `+deliveryColumns+` FROM webhook_deliveries WHERE id=$1 FOR UPDATE SKIP LOCKED`, id)
	v, err := scanDelivery(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.WebhookDelivery{}, false, nil
	}
	return v, err == nil, err
}

func (d *DAO) lockDeliveryIDs(ctx context.Context, query string, limit int, now time.Time) ([]store.WebhookDelivery, error) {
	if limit < 1 || limit > 8 {
		return nil, fmt.Errorf("invalid webhook batch size")
	}
	rows, err := d.tx.Query(ctx, query, now, limit)
	if err != nil {
		return nil, pg.QueryError("select webhook deliveries", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, pg.QueryError("scan webhook deliveries", err)
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, pg.QueryError("read webhook deliveries", err)
	}
	out := make([]store.WebhookDelivery, 0, len(ids))
	for _, id := range ids {
		v, e := d.LockDelivery(ctx, id)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, nil
}
func (d *DAO) LockExpired(ctx context.Context, limit int, now time.Time) ([]store.WebhookDelivery, error) {
	return d.lockDeliveryIDs(ctx, `SELECT id::text FROM webhook_deliveries WHERE state='leased' AND lease_until <= $1 AND purging_at IS NULL ORDER BY lease_until,id LIMIT $2 FOR UPDATE SKIP LOCKED`, limit, now)
}
func (d *DAO) LockDueExpiry(ctx context.Context, limit int, now time.Time) ([]store.WebhookDelivery, error) {
	return d.lockDeliveryIDs(ctx, `SELECT id::text FROM webhook_deliveries WHERE state='pending' AND expires_at <= $1 AND purging_at IS NULL ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`, limit, now)
}
func (d *DAO) NextQueueOrder(ctx context.Context) (int64, error) {
	var n int64
	err := d.tx.QueryRow(ctx, `SELECT nextval('webhook_delivery_queue_order_seq')`).Scan(&n)
	if err != nil {
		return 0, pg.QueryError("allocate webhook queue order", err)
	}
	return n, nil
}

func (d *DAO) CurrentDestination(ctx context.Context, id string, revision int64) (bool, error) {
	var current bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=$1 AND deleted_at IS NULL AND destination_revision=$2)`, id, revision).Scan(&current)
	if err != nil {
		return false, pg.QueryError("read current webhook destination", err)
	}
	return current, nil
}

func (d *DAO) LockWait(ctx context.Context, id string, revision int64) (store.WebhookEndpointWait, error) {
	var w store.WebhookEndpointWait
	err := d.tx.QueryRow(ctx, `SELECT endpoint_id::text,destination_revision,owner_kind,owner_id::text,not_before,updated_at FROM webhook_endpoint_waits WHERE endpoint_id=$1 AND destination_revision=$2 FOR UPDATE`, id, revision).Scan(&w.EndpointID, &w.DestinationRevision, &w.Owner.Kind, &w.Owner.ID, &w.NotBefore, &w.UpdatedAt)
	if err != nil {
		return w, pg.QueryError("lock webhook endpoint wait", err)
	}
	return w, nil
}
func (d *DAO) RaiseWait(ctx context.Context, id string, revision int64, until, now time.Time) error {
	tag, err := d.tx.Exec(ctx, `UPDATE webhook_endpoint_waits SET not_before=GREATEST(not_before,$3),updated_at=$4 WHERE endpoint_id=$1 AND destination_revision=$2 AND (not_before IS NULL OR not_before < $3)`, id, revision, until, now)
	if err != nil {
		return pg.QueryError("raise webhook endpoint wait", err)
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err = d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_endpoint_waits WHERE endpoint_id=$1 AND destination_revision=$2)`, id, revision).Scan(&exists); err != nil {
			return pg.QueryError("read webhook endpoint wait", err)
		}
		if !exists {
			return fmt.Errorf("webhook endpoint wait missing")
		}
	}
	return nil
}

func (d *DAO) UpdateDelivery(ctx context.Context, v store.WebhookDelivery) error {
	tag, err := d.tx.Exec(ctx, `UPDATE webhook_deliveries SET automatic_plan_cursor=$2,automatic_attempt_count=$3,manual_operation_count=$4,attempt_sequence=$5,automatic_open=$6,generation=$7,state=$8,trigger=$9,expires_at=$10,next_attempt_at=$11,manual_operation_id=$12,lease_token=$13,lease_claimed_at=$14,lease_until=$15,lease_generation=$16,lease_plan_slot=$17,current_attempt_id=$18,terminal_at=$19,last_activity_at=$20,metadata_expires_at=$21,preparation_error_code=$22,queue_order=$23 WHERE id=$1 AND purging_at IS NULL`, v.ID, v.AutomaticPlanCursor, v.AutomaticAttemptCount, v.ManualOperationCount, v.AttemptSequence, v.AutomaticOpen, v.Generation, v.State, v.Trigger, v.ExpiresAt, v.NextAttemptAt, v.ManualOperationID, v.LeaseToken, v.LeaseClaimedAt, v.LeaseUntil, v.LeaseGeneration, v.LeasePlanSlot, v.CurrentAttemptID, v.TerminalAt, v.LastActivityAt, v.MetadataExpiresAt, v.PreparationErrorCode, v.QueueOrder)
	if err != nil {
		return pg.QueryError("update webhook delivery", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("webhook delivery unavailable")
	}
	return nil
}

const attemptColumns = `id::text,delivery_id::text,endpoint_id::text,trigger,lease_token::text,generation,destination_revision,sequence,signing_key_ids::text[],automatic_plan_slot,manual_operation_id::text,claimed_at,admitted_at,retention_closed_at,dispatched_at,finished_at,outcome,http_status,duration_ms,error_code,retry_after_not_before,retry_after_diagnostic_code,recovered_unknown_at,late_observed_at,late_outcome,late_http_status,late_duration_ms,late_error_code,late_retry_after_not_before,late_retry_after_diagnostic_code`

func scanAttempt(row pgx.Row) (store.WebhookAttempt, error) {
	var a store.WebhookAttempt
	err := row.Scan(&a.ID, &a.DeliveryID, &a.EndpointID, &a.Trigger, &a.LeaseToken, &a.Generation, &a.DestinationRevision, &a.Sequence, &a.SigningKeyIDs, &a.AutomaticPlanSlot, &a.ManualOperationID, &a.ClaimedAt, &a.AdmittedAt, &a.RetentionClosedAt, &a.DispatchedAt, &a.FinishedAt, &a.Outcome, &a.HTTPStatus, &a.DurationMS, &a.ErrorCode, &a.RetryAfterNotBefore, &a.RetryAfterDiagnosticCode, &a.RecoveredUnknownAt, &a.LateObservedAt, &a.LateOutcome, &a.LateHTTPStatus, &a.LateDurationMS, &a.LateErrorCode, &a.LateRetryAfterNotBefore, &a.LateRetryAfterDiagnosticCode)
	if err != nil {
		return a, pg.QueryError("read webhook attempt", err)
	}
	return a, nil
}
func (d *DAO) LockAttempts(ctx context.Context, id string) ([]store.WebhookAttempt, error) {
	rows, err := d.tx.Query(ctx, `SELECT `+attemptColumns+` FROM webhook_attempts WHERE delivery_id=$1 ORDER BY sequence,id FOR UPDATE`, id)
	if err != nil {
		return nil, pg.QueryError("lock webhook attempts", err)
	}
	defer rows.Close()
	var out []store.WebhookAttempt
	for rows.Next() {
		a, e := scanAttempt(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, a)
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook attempts", err)
	}
	return out, nil
}
func (d *DAO) LockOwnAttempt(ctx context.Context, id string) (store.WebhookAttempt, error) {
	return scanAttempt(d.tx.QueryRow(ctx, `SELECT `+attemptColumns+` FROM webhook_attempts WHERE id=$1 FOR UPDATE`, id))
}
func (d *DAO) InsertAttempt(ctx context.Context, a store.WebhookAttempt) error {
	_, err := d.tx.Exec(ctx, `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,trigger,lease_token,generation,destination_revision,sequence,signing_key_ids,automatic_plan_slot,manual_operation_id,claimed_at,admitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid[],$10,$11,$12,$13)`, a.ID, a.DeliveryID, a.EndpointID, a.Trigger, a.LeaseToken, a.Generation, a.DestinationRevision, a.Sequence, a.SigningKeyIDs, a.AutomaticPlanSlot, a.ManualOperationID, a.ClaimedAt, a.AdmittedAt)
	if err != nil {
		return pg.QueryError("insert webhook attempt", err)
	}
	return nil
}
func (d *DAO) UpdateAttempt(ctx context.Context, a store.WebhookAttempt) error {
	tag, err := d.tx.Exec(ctx, `UPDATE webhook_attempts SET dispatched_at=$2,finished_at=$3,outcome=$4,http_status=$5,duration_ms=$6,error_code=$7,retry_after_not_before=$8,retry_after_diagnostic_code=$9,recovered_unknown_at=$10,late_observed_at=$11,late_outcome=$12,late_http_status=$13,late_duration_ms=$14,late_error_code=$15,late_retry_after_not_before=$16,late_retry_after_diagnostic_code=$17 WHERE id=$1 AND retention_closed_at IS NULL`, a.ID, a.DispatchedAt, a.FinishedAt, a.Outcome, a.HTTPStatus, a.DurationMS, a.ErrorCode, a.RetryAfterNotBefore, a.RetryAfterDiagnosticCode, a.RecoveredUnknownAt, a.LateObservedAt, a.LateOutcome, a.LateHTTPStatus, a.LateDurationMS, a.LateErrorCode, a.LateRetryAfterNotBefore, a.LateRetryAfterDiagnosticCode)
	if err != nil {
		return pg.QueryError("update webhook attempt", err)
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("webhook attempt unavailable or retention closed")
	}
	return nil
}

func (d *DAO) Claim(ctx context.Context, limit int, now time.Time, tokens []string) ([]store.WebhookDelivery, error) {
	if limit < 1 || limit > 8 || len(tokens) < limit {
		return nil, fmt.Errorf("invalid webhook claim capacity")
	}
	out := make([]store.WebhookDelivery, 0, limit)
	for len(out) < limit {
		var id string
		err := d.tx.QueryRow(ctx, `SELECT d.id::text FROM webhook_deliveries d WHERE d.state='pending' AND d.purging_at IS NULL AND d.next_attempt_at <= $1 AND d.expires_at > $1 AND NOT EXISTS (SELECT 1 FROM webhook_endpoint_waits w WHERE w.endpoint_id=d.endpoint_id AND w.destination_revision=d.destination_revision AND w.not_before > $1) ORDER BY d.queue_order,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, now).Scan(&id)
		if err == pgx.ErrNoRows {
			break
		}
		if err != nil {
			return nil, pg.QueryError("select webhook claim", err)
		}
		v, err := d.LockDelivery(ctx, id)
		if err != nil {
			return nil, err
		}
		now, err = d.ObservedAt(ctx)
		if err != nil {
			return nil, err
		}
		if v.State != "pending" || v.PurgingAt != nil || v.NextAttemptAt == nil || v.NextAttemptAt.After(now) || !now.Before(v.ExpiresAt) {
			continue
		}
		var wait *time.Time
		err = d.tx.QueryRow(ctx, `SELECT not_before FROM webhook_endpoint_waits WHERE endpoint_id=$1 AND destination_revision=$2`, v.EndpointID, v.DestinationRevision).Scan(&wait)
		if err == pgx.ErrNoRows {
			var current bool
			if e := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=$1 AND deleted_at IS NULL AND destination_revision=$2)`, v.EndpointID, v.DestinationRevision).Scan(&current); e != nil {
				return nil, pg.QueryError("read current webhook destination", e)
			}
			if current {
				return nil, fmt.Errorf("current webhook endpoint wait missing")
			}
		} else if err != nil {
			return nil, pg.QueryError("lock webhook claim wait", err)
		}
		if wait != nil && wait.After(now) {
			v.NextAttemptAt = wait
			if err = d.UpdateDelivery(ctx, v); err != nil {
				return nil, err
			}
			continue
		}
		token := tokens[len(out)]
		claimedAt := now
		until := claimedAt.Add(45 * time.Second)
		gen := v.Generation
		v.State = "leased"
		v.LeaseToken = &token
		v.LeaseClaimedAt = &claimedAt
		v.LeaseUntil = &until
		v.LeaseGeneration = &gen
		v.LeasePlanSlot = nil
		v.CurrentAttemptID = nil
		if claimedAt.After(v.LastActivityAt) {
			v.LastActivityAt = claimedAt
		}
		if deadline := claimedAt.Add(30 * 24 * time.Hour); deadline.After(v.MetadataExpiresAt) {
			v.MetadataExpiresAt = deadline
		}
		if err = d.UpdateDelivery(ctx, v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (d *DAO) AdmissionSources(ctx context.Context, id string, now time.Time) (store.WebhookAdmissionSources, error) {
	return d.admissionSources(ctx, id, "", storeOwner{}, "", now)
}

// The management path binds the immutable anchors before acquiring any source
// locks. The actor membership shares the same Team lock as send authorization.
func (d *DAO) AdmissionSourcesForActor(ctx context.Context, id, endpoint string, owner webhookmodel.Owner, actor string, now time.Time) (store.WebhookAdmissionSources, error) {
	return d.admissionSources(ctx, id, endpoint, storeOwner{owner.Kind, owner.ID}, actor, now)
}

type storeOwner struct{ kind, id string }

func (d *DAO) admissionSources(ctx context.Context, id, expectedEndpoint string, expectedOwner storeOwner, actor string, now time.Time) (store.WebhookAdmissionSources, error) {
	var out store.WebhookAdmissionSources
	var eventID, projectID, endpointID, ownerKind, ownerID string
	var taskID *string
	err := d.tx.QueryRow(ctx, `SELECT d.event_id::text,d.project_id::text,e.task_id::text,d.endpoint_id::text,d.owner_kind,d.owner_id::text FROM webhook_deliveries d LEFT JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, id).Scan(&eventID, &projectID, &taskID, &endpointID, &ownerKind, &ownerID)
	if err != nil {
		return out, pg.QueryError("read webhook admission anchors", err)
	}
	if expectedEndpoint != "" && (endpointID != expectedEndpoint || ownerKind != expectedOwner.kind || ownerID != expectedOwner.id) {
		return out, pg.QueryError("read webhook admission anchors", pgx.ErrNoRows)
	}
	if taskID == nil {
		return out, d.missingAdmissionEvent(ctx, id, actor != "")
	}
	var deleted *time.Time
	err = d.tx.QueryRow(ctx, `SELECT deleted_at FROM tasks WHERE id=$1 AND project_id=$2 FOR SHARE`, *taskID, projectID).Scan(&deleted)
	if err != nil && err != pgx.ErrNoRows {
		return out, pg.QueryError("lock webhook source task", err)
	}
	out.TaskPresent = err == nil && deleted == nil
	var team string
	err = d.tx.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR SHARE`, projectID).Scan(&team)
	if err != nil && err != pgx.ErrNoRows {
		return out, pg.QueryError("lock webhook source ownership", err)
	}
	var teamID string
	if team != "" {
		err = d.tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR SHARE`, team).Scan(&teamID)
		if err != nil && err != pgx.ErrNoRows {
			return out, pg.QueryError("lock webhook source team", err)
		}
	}
	if actor != "" && ownerKind == "team" && ownerID == team && teamID != "" {
		var actorID string
		err = d.tx.QueryRow(ctx, `SELECT user_id::text FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, team, actor).Scan(&actorID)
		if err != nil && err != pgx.ErrNoRows {
			return out, pg.QueryError("lock webhook actor membership", err)
		}
	}
	var member, grant, ownerUser string
	if ownerKind == "personal" && teamID != "" {
		err = d.tx.QueryRow(ctx, `SELECT user_id::text FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, team, ownerID).Scan(&member)
		if err != nil && err != pgx.ErrNoRows {
			return out, pg.QueryError("lock webhook source membership", err)
		}
		err = d.tx.QueryRow(ctx, `SELECT user_id::text FROM project_grants WHERE project_id=$1 AND user_id=$2 FOR SHARE`, projectID, ownerID).Scan(&grant)
		if err != nil && err != pgx.ErrNoRows {
			return out, pg.QueryError("lock webhook source grant", err)
		}
		err = d.tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 FOR SHARE`, ownerID).Scan(&ownerUser)
		if err != nil && err != pgx.ErrNoRows {
			return out, pg.QueryError("lock webhook personal owner", err)
		}
	}
	var live bool
	if err = d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND deleted_at IS NULL)`, projectID).Scan(&live); err != nil {
		return out, pg.QueryError("read webhook source project", err)
	}
	if live && (team == "" || teamID == "") {
		return out, fmt.Errorf("live webhook source project ownership unavailable")
	}
	out.ProjectEligible = live && ((ownerKind == "team" && ownerID == team) || (ownerKind == "personal" && ownerUser != "" && (member != "" || grant != "")))
	out.Endpoint, err = scanEndpoint(d.tx.QueryRow(ctx, `SELECT `+endpointColumns+` FROM webhook_endpoints WHERE id=$1 FOR SHARE`, endpointID))
	if err == pgx.ErrNoRows {
		err = nil
	} else if err != nil {
		return out, pg.QueryError("lock webhook endpoint", err)
	} else {
		out.EndpointPresent = true
		out.SigningKeys, err = d.SigningKeys(ctx, endpointID)
		if err != nil {
			return out, err
		}
		keys := out.SigningKeys[:0]
		for _, k := range out.SigningKeys {
			if k.Slot == "current" || (k.Slot == "overlap" && k.OverlapUntil != nil && k.OverlapUntil.After(now)) {
				keys = append(keys, k)
			}
		}
		out.SigningKeys = keys
	}
	err = d.tx.QueryRow(ctx, `SELECT id::text,event_type,wire_version,schema_version,source,subject,project_id::text,task_id::text,task_version,task_deleted_at,step_id,message_id::text,occurred_at,recorded_at,origin_request_id,fact_codec_version,fact_bytes,fact_sha256 FROM webhook_events WHERE id=$1`, eventID).Scan(&out.Event.ID, &out.Event.EventType, &out.Event.WireVersion, &out.Event.SchemaVersion, &out.Event.Source, &out.Event.Subject, &out.Event.ProjectID, &out.Event.TaskID, &out.Event.TaskVersion, &out.Event.TaskDeletedAt, &out.Event.StepID, &out.Event.MessageID, &out.Event.OccurredAt, &out.Event.RecordedAt, &out.Event.OriginRequestID, &out.Event.FactCodecVersion, &out.Event.FactBytes, &out.Event.FactSHA256)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, d.missingAdmissionEvent(ctx, id, actor != "")
	}
	if err != nil {
		return out, pg.QueryError("read webhook original event", err)
	}
	rows, err := d.tx.Query(ctx, `SELECT subscription_id::text,binding_id::text,project_id::text,event_type,authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1 ORDER BY subscription_id,binding_id`, id)
	if err != nil {
		return out, pg.QueryError("read webhook original matches", err)
	}
	for rows.Next() {
		var m store.WebhookAdmissionMatch
		if err = rows.Scan(&m.SubscriptionID, &m.BindingID, &m.ProjectID, &m.EventType, &m.AuthorizationEpoch); err != nil {
			rows.Close()
			return out, pg.QueryError("scan webhook original matches", err)
		}
		out.Matches = append(out.Matches, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, pg.QueryError("read webhook original matches", err)
	}
	subscriptions := make(map[string]bool)
	for i := range out.Matches {
		m := &out.Matches[i]
		if _, ok := subscriptions[m.SubscriptionID]; ok {
			continue
		}
		var endpoint, project, kind, owner, state string
		var epoch int64
		var removed *time.Time
		err = d.tx.QueryRow(ctx, `SELECT endpoint_id::text,project_id::text,owner_kind,owner_id::text,authorization_state,authorization_epoch,deleted_at FROM webhook_subscriptions WHERE id=$1 FOR SHARE`, m.SubscriptionID).Scan(&endpoint, &project, &kind, &owner, &state, &epoch, &removed)
		if err == pgx.ErrNoRows {
			subscriptions[m.SubscriptionID] = false
			continue
		}
		if err != nil {
			return out, pg.QueryError("lock webhook original subscription", err)
		}
		subscriptions[m.SubscriptionID] = endpoint == endpointID && project == m.ProjectID && kind == ownerKind && owner == ownerID && state == "active" && epoch == m.AuthorizationEpoch && removed == nil
	}
	indices := make([]int, len(out.Matches))
	for i := range indices {
		indices[i] = i
	}
	sort.Slice(indices, func(i, j int) bool { return out.Matches[indices[i]].BindingID < out.Matches[indices[j]].BindingID })
	for _, i := range indices {
		m := &out.Matches[i]
		var sub, typ string
		var bindingRemoved *time.Time
		err = d.tx.QueryRow(ctx, `SELECT subscription_id::text,event_type,deleted_at FROM webhook_bindings WHERE id=$1 FOR SHARE`, m.BindingID).Scan(&sub, &typ, &bindingRemoved)
		if err == pgx.ErrNoRows {
			continue
		}
		if err != nil {
			return out, pg.QueryError("lock webhook original binding", err)
		}
		m.Continuous = subscriptions[m.SubscriptionID] && sub == m.SubscriptionID && typ == m.EventType && bindingRemoved == nil
	}
	return out, nil
}

// Reconcile a disappearing Event against the retention state under the
// Delivery lock. A still-open history missing its immutable Event is corrupt.
func (d *DAO) missingAdmissionEvent(ctx context.Context, id string, management bool) error {
	if !management {
		// The runner owns claim/lease reconciliation and must make that
		// decision under its usual Delivery lock before treating this as loss.
		return pg.QueryError("read webhook original event", pgx.ErrNoRows)
	}
	delivery, err := d.LockDelivery(ctx, id)
	if err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return &store.WebhookAdmissionEventError{Cause: err}
		}
		return err
	}
	if delivery.PurgingAt != nil {
		return &store.WebhookAdmissionEventError{Cause: pg.QueryError("read reclaimed webhook delivery", pgx.ErrNoRows)}
	}
	// Late writers take only their Attempt lock, so inspect their activity
	// after locking all attempts in the documented Delivery-first order.
	attempts, err := d.LockAttempts(ctx, id)
	if err != nil {
		return err
	}
	now, err := d.ObservedAt(ctx)
	if err != nil {
		return err
	}
	if !store.WebhookHistoryRetained(delivery, attempts, now) {
		return &store.WebhookAdmissionEventError{Cause: pg.QueryError("read expired webhook delivery", pgx.ErrNoRows)}
	}
	if !now.Before(delivery.PayloadExpiresAt) {
		return &store.WebhookAdmissionEventError{Cause: &model.Fault{Code: "payload_expired", Message: "Webhook payload has expired."}}
	}
	return &store.WebhookAdmissionEventError{Cause: &store.Error{Phase: "webhook original event integrity", Cause: fmt.Errorf("webhook original event missing")}}
}
