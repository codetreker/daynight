package postgres

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestWebhookCaptureMigrationAndConstraints(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if len(schemaMigrations) < 50 || schemaMigrations[48].version != 49 || schemaMigrations[49].version != 50 {
		t.Fatal("unexpected capture migration boundary")
	}
	before := schemaMigrations[:49]
	if err := migrate(ctx, pool, before); err != nil {
		t.Fatal(err)
	}
	var ledger string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&ledger); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:50]); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version < 50`).Scan(&after); err != nil || after != ledger {
		t.Fatalf("old migration ledger changed: %v", err)
	}

	event, project, task, endpoint, owner, delivery := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO webhook_events
		(id,event_type,wire_version,schema_version,source,subject,project_id,task_id,task_version,
		 occurred_at,recorded_at,fact_codec_version,fact_bytes,fact_sha256,original_fact_bytes)
		VALUES ($1,'task.created',1,1,'urn:daynight:project:' || $2::uuid::text,'tasks/' || $3::uuid::text,$2,$3,1,
		 now(),now(),1,convert_to('{}','UTF8'),sha256(convert_to('{}','UTF8')),2)`, event, project, task)
	if err != nil {
		t.Fatal(err)
	}
	insertDelivery := `INSERT INTO webhook_deliveries
		(id,event_id,endpoint_id,owner_kind,owner_id,event_type,project_id,occurred_at,original_match_count,original_match_sha256,
		 policy_version,destination_revision,destination_kind,adapter_version,render_version,configuration_schema_version,destination_origin,
		 destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,request_method,request_media_type,
		 deterministic_headers_json,body,original_body_bytes,body_sha256,automatic_schedule_at,automatic_expires_at,payload_expires_at,
		 automatic_plan_cursor,automatic_open,automatic_attempt_count,manual_operation_count,attempt_sequence,generation,state,trigger,
		 expires_at,next_attempt_at,last_activity_at,metadata_expires_at)
		VALUES ($1,$2,$3,'personal',$4,'task.created',$5,now(),1,decode(repeat('00',32),'hex'),
		 1,1,'http',1,1,1,'https://example.test',1,'primary',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),
		 'POST','application/cloudevents+json',convert_to('[]','UTF8'),convert_to('{}','UTF8'),2,sha256(convert_to('{}','UTF8')),
		 ARRAY(SELECT now() + i * interval '1 minute' FROM generate_series(0,9) i ORDER BY i),now()+interval '72 hours',now()+interval '168 hours',
		 0,true,0,0,0,1,'pending','automatic',now()+interval '72 hours',now(),now(),now()+interval '30 days') RETURNING queue_order`
	var first, second int64
	if err := pool.QueryRow(ctx, insertDelivery, delivery, event, endpoint, owner, project).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, insertDelivery, uuid.NewString(), event, uuid.NewString(), owner, project).Scan(&second); err != nil || first <= 0 || second <= first {
		t.Fatalf("queue tickets %d, %d: %v", first, second, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO webhook_delivery_matches(delivery_id,subscription_id,binding_id,project_id,event_type,authorization_epoch)
		VALUES($1,$2,$3,$4,'task.created',1)`, delivery, uuid.NewString(), uuid.NewString(), project)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, query string }{
		{"missing fact", `UPDATE webhook_events SET fact_bytes=NULL`},
		{"fact hash", `UPDATE webhook_events SET fact_bytes=convert_to('xx','UTF8')`},
		{"wrong event anchor", `UPDATE webhook_events SET step_id=1`},
		{"missing payload marker", `UPDATE webhook_deliveries SET body=NULL`},
		{"wrong payload hash", `UPDATE webhook_deliveries SET body=convert_to('xx','UTF8')`},
		{"partial target", `UPDATE webhook_deliveries SET destination_nonce=NULL`},
		{"partial lease", `UPDATE webhook_deliveries SET state='leased'`},
		{"invalid schedule", `UPDATE webhook_deliveries SET automatic_schedule_at[2]=automatic_schedule_at[1]`},
		{"empty proof", `UPDATE webhook_deliveries SET original_match_count=0`},
		{"invalid epoch", `UPDATE webhook_delivery_matches SET authorization_epoch=0`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := pool.Exec(ctx, tc.query); err == nil {
				t.Fatal("invalid state was accepted")
			}
		})
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_events SET fact_bytes=NULL,fact_removed_at=now()`); err != nil {
		t.Fatalf("valid fact removal: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE webhook_deliveries SET body=NULL,payload_removed_at=now(),payload_removed_reason='expired'`); err != nil {
		t.Fatalf("valid payload removal: %v", err)
	}
}
