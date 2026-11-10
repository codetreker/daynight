package postgres

import (
	"context"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

func TestWebhookStartupReferences(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	policies, err := s.WebhookStartupPolicies(ctx)
	if err != nil || len(policies) != 1 || policies[0].Version != 1 || policies[0].LeaseSeconds != 45 {
		t.Fatalf("policies=%+v err=%v", policies, err)
	}
	if err := s.CheckWebhookCurrentReferences(ctx); err != nil {
		t.Fatal(err)
	}
	endpoint, owner, key := uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err = s.Pool.Exec(ctx, `INSERT INTO webhook_endpoints
		(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_configuration,active_key_id,created_at,updated_at)
		VALUES($1,'personal',$2,'name',true,1,1,'http',1,1,'https://example.test',convert_to('{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.test/hook"}}','UTF8'),$3,now(),now())`, endpoint, owner, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CheckWebhookCurrentReferences(ctx); err == nil {
		t.Fatal("missing current key and wait accepted")
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO webhook_signing_keys(id,endpoint_id,slot,secret,created_at) VALUES($1,$2,'current',decode(repeat('00',32),'hex'),now())`, key, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CheckWebhookCurrentReferences(ctx); err == nil {
		t.Fatal("missing current wait accepted")
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO webhook_endpoint_waits(endpoint_id,destination_revision,owner_kind,owner_id,updated_at) VALUES($1,1,'personal',$2,now())`, endpoint, owner)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CheckWebhookCurrentReferences(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `UPDATE webhook_endpoints SET active_key_id=$2 WHERE id=$1`, endpoint, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckWebhookCurrentReferences(ctx); err == nil {
		t.Fatal("missing current key with a valid wait accepted")
	}
	if _, err := s.Pool.Exec(ctx, `UPDATE webhook_endpoints SET active_key_id=$2 WHERE id=$1`, endpoint, key); err != nil {
		t.Fatal(err)
	}
	_, err = s.Pool.Exec(ctx, `UPDATE webhook_endpoint_waits SET owner_id=$1 WHERE endpoint_id=$2`, uuid.NewString(), endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CheckWebhookCurrentReferences(ctx); err == nil {
		t.Fatal("wrong wait owner accepted")
	}
	initial := policies[0]
	if _, err := s.Pool.Exec(ctx, `CREATE TABLE original_webhook_policies AS SELECT * FROM webhook_policies;
		DELETE FROM webhook_policies WHERE version=1`); err != nil {
		t.Fatal(err)
	}
	policies, err = s.WebhookStartupPolicies(ctx)
	if err != nil || len(policies) != 0 {
		t.Fatalf("empty policy table supplied a default: policies=%+v err=%v", policies, err)
	}
	if _, err := s.Pool.Exec(ctx, `INSERT INTO webhook_policies SELECT * FROM original_webhook_policies;
		ALTER TABLE webhook_policies DISABLE TRIGGER webhook_policy_no_update;
		UPDATE webhook_policies SET http_timeout_seconds=16 WHERE version=1`); err != nil {
		t.Fatal(err)
	}
	policies, err = s.WebhookStartupPolicies(ctx)
	if err != nil || len(policies) != 1 || policies[0].HTTPTimeoutSeconds != 16 {
		t.Fatalf("stored timeout change was hidden: policies=%+v err=%v", policies, err)
	}
	if _, err := s.Pool.Exec(ctx, `UPDATE webhook_policies SET http_timeout_seconds=$1 WHERE version=1`, initial.HTTPTimeoutSeconds); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `ALTER TABLE webhook_policies ENABLE TRIGGER webhook_policy_no_update;
		INSERT INTO webhook_policies SELECT 2,max_automatic_attempts,automatic_window_seconds,automatic_offsets_seconds,max_manual_operations,payload_retention_seconds,metadata_retention_seconds,operation_retention_seconds,operation_max_age_seconds,operation_future_skew_seconds,http_timeout_seconds,lease_seconds,minimum_failure_wait_seconds,jitter_basis_points,jitter_max_seconds,key_overlap_default_seconds,key_overlap_max_seconds FROM webhook_policies WHERE version=1`); err != nil {
		t.Fatal(err)
	}
	second := initial
	second.Version = 2
	policies, err = s.WebhookStartupPolicies(ctx)
	if err != nil || len(policies) != 2 || !reflect.DeepEqual(policies[0], initial) || !reflect.DeepEqual(policies[1], second) {
		t.Fatalf("startup reader filtered or changed stored policy versions: policies=%+v err=%v", policies, err)
	}
	_, err = s.Pool.Exec(ctx, `ALTER TABLE webhook_policies RENAME TO missing_webhook_policies`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.WebhookStartupPolicies(ctx); err == nil {
		t.Fatal("missing policy table accepted")
	}
	if err := s.CheckWebhookCurrentReferences(ctx); err == nil {
		t.Fatal("missing policy table accepted by reference check")
	}
}
