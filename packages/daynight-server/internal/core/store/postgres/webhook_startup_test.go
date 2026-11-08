package postgres

import (
	"context"
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
	_, err = s.Pool.Exec(ctx, `UPDATE webhook_endpoint_waits SET owner_id=$1 WHERE endpoint_id=$2`, uuid.NewString(), endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CheckWebhookCurrentReferences(ctx); err == nil {
		t.Fatal("wrong wait owner accepted")
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
