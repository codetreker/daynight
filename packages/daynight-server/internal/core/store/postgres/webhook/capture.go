package webhook

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/jackc/pgx/v5"
)

var _ store.WebhookCaptureDAO = (*DAO)(nil)

type projectCapture struct {
	*DAO
	projectID string
}

// NewProjectCapture restricts capture to the Project locked by the source scope.
func NewProjectCapture(tx pgx.Tx, projectID string) store.WebhookCaptureDAO {
	return &projectCapture{DAO: New(tx), projectID: projectID}
}

func (d *projectCapture) FreezeAudience(ctx context.Context, projectID string, eventTypes []string) ([]store.WebhookAudience, error) {
	if projectID != d.projectID {
		return nil, fmt.Errorf("webhook capture project differs from source scope")
	}
	return d.DAO.FreezeAudience(ctx, projectID, eventTypes)
}

func (d *projectCapture) SaveCapture(ctx context.Context, event store.WebhookCapturedEvent, deliveries []store.WebhookCapturedDelivery) error {
	if event.ProjectID != d.projectID {
		return fmt.Errorf("webhook capture project differs from source scope")
	}
	return d.DAO.SaveCapture(ctx, event, deliveries)
}

func (d *DAO) RecordedAt(ctx context.Context) (time.Time, error) {
	var now time.Time
	if err := d.tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&now); err != nil {
		return time.Time{}, pg.QueryError("read webhook capture time", err)
	}
	return now, nil
}

// FreezeAudience reads the scope, endpoint configuration and every original
// match under one statement snapshot. It deliberately takes no source locks.
func (d *DAO) FreezeAudience(ctx context.Context, projectID string, eventTypes []string) ([]store.WebhookAudience, error) {
	if len(eventTypes) < 1 || len(eventTypes) > 2 {
		return nil, fmt.Errorf("invalid webhook capture batch size")
	}
	if len(eventTypes) == 2 && eventTypes[0] == eventTypes[1] {
		return nil, fmt.Errorf("duplicate webhook capture event type")
	}
	// Retired configuration collection waits for source transactions that
	// could have observed the old audience. An assigned top-level XID and a
	// fresh statement snapshot make those transactions visible to its barrier.
	var safeSource bool
	if err := d.tx.QueryRow(ctx, `SELECT pg_current_xact_id_if_assigned() IS NOT NULL AND current_setting('transaction_isolation')='read committed'`).Scan(&safeSource); err != nil {
		return nil, pg.QueryError("check webhook capture transaction", err)
	}
	if !safeSource {
		return nil, fmt.Errorf("webhook capture requires a written read-committed source transaction")
	}
	rows, err := d.tx.Query(ctx, `WITH facts AS MATERIALIZED (SELECT unnest($2::text[]) AS event_type),
  scope AS MATERIALIZED (
    SELECT p.id IS NOT NULL AND p.deleted_at IS NULL AS live,
           o.team_id IS NOT NULL AND t.id IS NOT NULL AS ownership_valid, o.team_id
    FROM (SELECT $1::uuid AS id) input
    LEFT JOIN projects p ON p.id=input.id
    LEFT JOIN project_ownership o ON o.project_id=p.id
    LEFT JOIN teams t ON t.id=o.team_id
  ), matches AS MATERIALIZED (
    SELECT f.event_type, e.id AS endpoint_id, e.owner_kind, e.owner_id,
           e.name,e.enabled,e.config_version,e.destination_revision,e.destination_kind,
           e.adapter_version,e.configuration_schema_version,e.destination_origin,
           e.destination_envelope_version,e.destination_master_key_id,e.destination_nonce,
           e.destination_ciphertext,e.active_key_id,e.created_at,e.updated_at,
           s.id AS subscription_id,b.id AS binding_id,s.authorization_epoch
    FROM facts f CROSS JOIN scope p
    JOIN webhook_bindings b ON b.event_type=f.event_type AND b.deleted_at IS NULL
    JOIN webhook_subscriptions s ON s.id=b.subscription_id AND s.project_id=$1::uuid
      AND s.deleted_at IS NULL AND s.authorization_state='active'
    JOIN webhook_endpoints e ON e.id=s.endpoint_id AND e.owner_kind=s.owner_kind AND e.owner_id=s.owner_id
      AND e.deleted_at IS NULL AND e.enabled
    WHERE p.live AND p.ownership_valid AND (
      (e.owner_kind='team' AND e.owner_id=p.team_id
       AND EXISTS (SELECT 1 FROM teams owner_team WHERE owner_team.id=e.owner_id))
      OR (e.owner_kind='personal' AND EXISTS (SELECT 1 FROM users owner_user WHERE owner_user.id=e.owner_id)
       AND (EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id=p.team_id AND tm.user_id=e.owner_id)
         OR EXISTS (SELECT 1 FROM project_grants g WHERE g.project_id=$1::uuid AND g.user_id=e.owner_id)))
    )
  )
  SELECT p.live,p.ownership_valid,COALESCE(m.event_type,''),COALESCE(m.endpoint_id::text,''),
    COALESCE(m.owner_kind,''),COALESCE(m.owner_id::text,''),COALESCE(m.name,''),COALESCE(m.enabled,false),
    COALESCE(m.config_version,0),COALESCE(m.destination_revision,0),COALESCE(m.destination_kind,''),
    COALESCE(m.adapter_version,0),COALESCE(m.configuration_schema_version,0),COALESCE(m.destination_origin,''),
    COALESCE(m.destination_envelope_version,0),COALESCE(m.destination_master_key_id,''),
    COALESCE(m.destination_nonce,''::bytea),COALESCE(m.destination_ciphertext,''::bytea),
    COALESCE(m.active_key_id::text,''),COALESCE(m.created_at,'epoch'::timestamptz),COALESCE(m.updated_at,'epoch'::timestamptz),
    COALESCE(m.subscription_id::text,''),COALESCE(m.binding_id::text,''),COALESCE(m.authorization_epoch,0)
  FROM scope p LEFT JOIN matches m ON true
  ORDER BY m.event_type,m.endpoint_id,m.subscription_id,m.binding_id`, projectID, eventTypes)
	if err != nil {
		return nil, pg.QueryError("freeze webhook audience", err)
	}
	defer rows.Close()
	var result []store.WebhookAudience
	for rows.Next() {
		var a store.WebhookAudience
		var live, ownership bool
		var adapter int64
		var env secretbox.Envelope
		if err := rows.Scan(&live, &ownership, &a.EventType, &a.Endpoint.ID, &a.Endpoint.Owner.Kind, &a.Endpoint.Owner.ID,
			&a.Endpoint.Name, &a.Endpoint.Enabled, &a.Endpoint.ConfigVersion, &a.Endpoint.DestinationRevision,
			&a.Endpoint.DestinationKind, &adapter, &a.ConfigurationSchemaVersion, &a.Endpoint.Origin,
			&env.Version, &env.MasterKeyID, &env.Nonce, &env.Ciphertext, &a.Endpoint.ActiveKeyID,
			&a.Endpoint.CreatedAt, &a.Endpoint.UpdatedAt, &a.SubscriptionID, &a.BindingID, &a.AuthorizationEpoch); err != nil {
			return nil, pg.QueryError("scan webhook audience", err)
		}
		if !live || !ownership {
			return nil, fmt.Errorf("webhook capture project or ownership unavailable")
		}
		if a.EventType == "" {
			continue
		}
		if a.AuthorizationEpoch <= 0 {
			return nil, fmt.Errorf("invalid webhook audience authorization epoch")
		}
		a.ProjectID = projectID
		a.Endpoint.AdapterVersion = strconv.FormatInt(adapter, 10)
		a.Endpoint.DestinationCiphertext, err = env.MarshalBinary()
		if err != nil {
			return nil, fmt.Errorf("encode frozen webhook destination: %w", err)
		}
		result = append(result, a)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook audience", err)
	}
	return result, nil
}

// SaveCapture inserts from the already frozen and rendered material only.
func (d *DAO) SaveCapture(ctx context.Context, event store.WebhookCapturedEvent, deliveries []store.WebhookCapturedDelivery) error {
	if len(deliveries) == 0 {
		return fmt.Errorf("webhook capture event requires a delivery")
	}
	for _, delivery := range deliveries {
		if len(delivery.Matches) == 0 || len(delivery.AutomaticScheduleAt) != 10 {
			return fmt.Errorf("webhook capture delivery requires matches and complete schedule")
		}
		for _, match := range delivery.Matches {
			if match.ProjectID != event.ProjectID || match.EventType != event.EventType || match.AuthorizationEpoch <= 0 {
				return fmt.Errorf("webhook capture match does not match event")
			}
		}
	}
	_, err := d.tx.Exec(ctx, `INSERT INTO webhook_events
 (id,event_type,wire_version,schema_version,source,subject,project_id,task_id,task_version,task_deleted_at,step_id,message_id,occurred_at,recorded_at,origin_request_id,fact_codec_version,fact_bytes,fact_sha256,original_fact_bytes)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
		event.ID, event.EventType, event.WireVersion, event.SchemaVersion, event.Source, event.Subject, event.ProjectID, event.TaskID, event.TaskVersion, event.TaskDeletedAt, event.StepID, event.MessageID, event.OccurredAt, event.RecordedAt, event.OriginRequestID, event.FactCodecVersion, event.FactBytes, event.FactSHA256, len(event.FactBytes))
	if err != nil {
		return pg.QueryError("save webhook event", err)
	}
	for _, delivery := range deliveries {
		env, err := secretbox.ParseEnvelope(delivery.DestinationCiphertext)
		if err != nil {
			return fmt.Errorf("parse captured webhook destination: %w", err)
		}
		_, err = d.tx.Exec(ctx, `INSERT INTO webhook_deliveries
 (id,event_id,endpoint_id,owner_kind,owner_id,event_type,project_id,occurred_at,original_match_count,original_match_sha256,policy_version,destination_revision,destination_kind,adapter_version,render_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,request_method,request_media_type,deterministic_headers_json,body,original_body_bytes,body_sha256,automatic_schedule_at,automatic_expires_at,payload_expires_at,automatic_plan_cursor,automatic_open,automatic_attempt_count,manual_operation_count,attempt_sequence,generation,state,trigger,expires_at,next_attempt_at,last_activity_at,metadata_expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,0,true,0,0,0,1,'pending','automatic',$29,$31,$32,$33)`,
			delivery.ID, event.ID, delivery.EndpointID, delivery.Owner.Kind, delivery.Owner.ID, event.EventType, event.ProjectID, event.OccurredAt, int64(len(delivery.Matches)), delivery.OriginalMatchSHA256, delivery.PolicyVersion, delivery.DestinationRevision, delivery.DestinationKind, delivery.AdapterVersion, delivery.RenderVersion, delivery.ConfigurationSchemaVersion, delivery.DestinationOrigin, int16(env.Version), env.MasterKeyID, env.Nonce, env.Ciphertext, delivery.RequestMethod, delivery.RequestMediaType, delivery.DeterministicHeadersJSON, delivery.Body, len(delivery.Body), delivery.BodySHA256, delivery.AutomaticScheduleAt, delivery.AutomaticExpiresAt, delivery.PayloadExpiresAt, delivery.AutomaticScheduleAt[0], delivery.LastActivityAt, delivery.MetadataExpiresAt)
		if err != nil {
			return pg.QueryError("save webhook delivery", err)
		}
		for _, match := range delivery.Matches {
			_, err = d.tx.Exec(ctx, `INSERT INTO webhook_delivery_matches(delivery_id,subscription_id,binding_id,project_id,event_type,authorization_epoch) VALUES($1,$2,$3,$4,$5,$6)`, delivery.ID, match.SubscriptionID, match.BindingID, match.ProjectID, match.EventType, match.AuthorizationEpoch)
			if err != nil {
				return pg.QueryError("save webhook delivery match", err)
			}
		}
	}
	return nil
}
