package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestWebhookMasterKeyIDs(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	keys, err := s.WebhookMasterKeyIDs(ctx)
	if err != nil || len(keys) != 0 {
		t.Fatalf("empty keys=%v err=%v", keys, err)
	}
	endpoint, owner := uuid.NewString(), uuid.NewString()
	_, err = s.Pool.Exec(ctx, `INSERT INTO webhook_endpoints
		(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at)
		VALUES($1,'personal',$2,'name',true,1,1,'http',1,1,'https://example.test',1,'endpoint-key',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),$3,now(),now())`, endpoint, owner, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO webhook_signing_keys(id,endpoint_id,slot,envelope_version,master_key_id,nonce,ciphertext,created_at)
		VALUES($1,$2,'current',1,'signing-key',decode(repeat('00',12),'hex'),decode(repeat('00',48),'hex'),now())`, uuid.NewString(), endpoint)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO webhook_deliveries
		(id,event_id,endpoint_id,owner_kind,owner_id,event_type,project_id,occurred_at,original_match_count,original_match_sha256,
		policy_version,destination_revision,destination_kind,adapter_version,render_version,configuration_schema_version,destination_origin,
		destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,request_method,request_media_type,
		deterministic_headers_json,body,original_body_bytes,body_sha256,automatic_schedule_at,automatic_expires_at,payload_expires_at,
		automatic_plan_cursor,automatic_open,automatic_attempt_count,manual_operation_count,attempt_sequence,generation,state,trigger,
		expires_at,next_attempt_at,last_activity_at,metadata_expires_at)
		VALUES ($1,$2,$3,'personal',$4,'task.created',$5,now(),1,decode(repeat('00',32),'hex'),
		1,1,'http',1,1,1,'https://example.test',1,'delivery-key',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),
		'POST','application/cloudevents+json',convert_to('[]','UTF8'),convert_to('{}','UTF8'),2,sha256(convert_to('{}','UTF8')),
		ARRAY(SELECT now() + i * interval '1 minute' FROM generate_series(0,9) i ORDER BY i),now()+interval '72 hours',now()+interval '7 days',
		0,true,0,0,0,1,'pending','automatic',now()+interval '72 hours',now(),now(),now()+interval '30 days')`, uuid.NewString(), uuid.NewString(), endpoint, owner, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	keys, err = s.WebhookMasterKeyIDs(ctx)
	if err != nil || !reflect.DeepEqual(keys, []string{"delivery-key", "endpoint-key", "signing-key"}) {
		t.Fatalf("keys=%v err=%v", keys, err)
	}
	if _, err = s.Pool.Exec(ctx, `ALTER TABLE webhook_signing_keys RENAME TO unavailable_webhook_signing_keys`); err != nil {
		t.Fatal(err)
	}
	_, err = s.WebhookMasterKeyIDs(ctx)
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "42P01" {
		t.Fatalf("missing reference source must fail startup scan: %v", err)
	}
}
