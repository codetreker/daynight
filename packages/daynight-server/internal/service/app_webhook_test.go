package service

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

func TestOpenAppWebhookCurrentReferencesWithoutKeyring(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := appTestConfig(t)
	c.WebhookEnabled = true
	db, err := postgres.Open(ctx, c.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	owner, endpoint, signingID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	configuration := []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/hook"}}`)
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_endpoints
		(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_configuration,active_key_id,created_at,updated_at)
		VALUES($1,'personal',$2,'receiver',true,1,1,'http',1,1,'https://receiver.example',$3,$4,now(),now())`, endpoint, owner, configuration, signingID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_signing_keys (id,endpoint_id,slot,secret,created_at) VALUES ($1,$2,'current',$3,now())`, signingID, endpoint, bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_endpoint_waits (endpoint_id,destination_revision,owner_kind,owner_id,updated_at) VALUES ($1,1,'personal',$2,now())`, endpoint, owner)
	if err != nil {
		t.Fatal(err)
	}
	app, err := OpenAppWithLogger(ctx, c, nil)
	if err != nil {
		t.Fatalf("open enabled webhooks without keyring: %v", err)
	}
	if app.Webhooks == nil || !app.Webhooks.DispatchEnabled || !app.Webhooks.ConfigurationExpansionAvailable {
		t.Fatal("enabled webhooks were not assembled")
	}
	if err = app.Ready(ctx); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if err = app.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}
	_, err = db.Pool.Exec(ctx, `DELETE FROM webhook_endpoint_waits WHERE endpoint_id=$1`, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	app, err = OpenApp(ctx, c)
	if app != nil || err == nil {
		t.Fatalf("missing wait accepted: %v", err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_endpoint_waits (endpoint_id,destination_revision,owner_kind,owner_id,updated_at) VALUES ($1,1,'personal',$2,now())`, endpoint, owner)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `UPDATE webhook_endpoints SET active_key_id=$2 WHERE id=$1`, endpoint, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	app, err = OpenApp(ctx, c)
	if app != nil || err == nil {
		t.Fatalf("missing current key accepted: %v", err)
	}
	_, err = db.Pool.Exec(ctx, `UPDATE webhook_endpoints SET active_key_id=$2 WHERE id=$1`, endpoint, signingID)
	if err != nil {
		t.Fatal(err)
	}
	app, err = OpenApp(ctx, c)
	if err != nil {
		t.Fatalf("retry after fixing current references: %v", err)
	}
	if err = app.Close(ctx); err != nil {
		t.Fatalf("retry close: %v", err)
	}
}

func TestWebhookRuntimeSupervisesFailureAndCloses(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c := appTestConfig(t)
	app, err := OpenApp(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		closeCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if err := app.Close(closeCtx); err != nil {
			t.Error(err)
		}
	}()
	if app.Webhooks == nil || app.Webhooks.DispatchEnabled || app.Webhooks.ConfigurationExpansionAvailable {
		t.Fatal("default composition must expose disabled webhook management")
	}
	runtime, stop := context.WithCancel(context.Background())
	defer stop()
	if err := app.Start(runtime); err != nil {
		t.Fatal(err)
	}
	if err := app.Start(runtime); err == nil {
		t.Fatal("runtime started twice")
	}
	db := app.persistence.Transactions.(*postgres.Store)
	if _, err := db.Pool.Exec(ctx, `DROP TABLE webhook_deliveries`); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		if app.Ready(ctx) != nil {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("worker failure did not affect readiness")
		case <-time.After(20 * time.Millisecond):
		}
	}
	if err := db.Ready(ctx); err != nil {
		t.Fatalf("database ping failed, not worker supervision: %v", err)
	}
	stop()
	app.StopClaims()
	app.CancelWork()
	if err := app.Drain(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestOpenAppRejectsUnsupportedWebhookPolicies(t *testing.T) {
	for _, tc := range []struct{ name, sql string }{
		{"missing", `DELETE FROM webhook_policies WHERE version=1`},
		{"modified", `ALTER TABLE webhook_policies DISABLE TRIGGER webhook_policy_no_update; UPDATE webhook_policies SET http_timeout_seconds=16 WHERE version=1`},
		{"unsupported", `INSERT INTO webhook_policies SELECT 2,max_automatic_attempts,automatic_window_seconds,automatic_offsets_seconds,max_manual_operations,payload_retention_seconds,metadata_retention_seconds,operation_retention_seconds,operation_max_age_seconds,operation_future_skew_seconds,http_timeout_seconds,lease_seconds,minimum_failure_wait_seconds,jitter_basis_points,jitter_max_seconds,key_overlap_default_seconds,key_overlap_max_seconds FROM webhook_policies WHERE version=1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := appTestConfig(t)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			db, err := postgres.Open(ctx, c.DatabaseURL)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err := db.Pool.Exec(ctx, tc.sql); err != nil {
				t.Fatal(err)
			}
			app, err := OpenApp(ctx, c)
			if app != nil {
				_ = app.Close(ctx)
				t.Fatal("invalid policy accepted")
			}
			if err == nil || !strings.Contains(err.Error(), "unsupported or invalid webhook policy") {
				t.Fatalf("policy error: %v", err)
			}
		})
	}
}
