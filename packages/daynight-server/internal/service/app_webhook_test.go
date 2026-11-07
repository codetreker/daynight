package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
)

func TestOpenAppWebhookMasterReferences(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := appTestConfig(t)
	db, err := postgres.Open(ctx, c.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	encoded := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	keyring := []byte(`{"activeKeyId":"primary","keys":{"primary":"` + encoded + `"}}`)
	keys, err := secretbox.Parse(keyring)
	if err != nil {
		t.Fatal(err)
	}
	owner, endpoint, signingID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	envelope, err := keys.Seal([]byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/hook"}}`), []string{"personal", owner, endpoint, "endpoint-current", "1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_endpoints
		(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at)
		VALUES($1,'personal',$2,'receiver',true,1,1,'http',1,1,'https://receiver.example',$3,$4,$5,$6,$7,now(),now())`, endpoint, owner, envelope.Version, envelope.MasterKeyID, envelope.Nonce, envelope.Ciphertext, signingID)
	if err != nil {
		t.Fatal(err)
	}
	signing, err := keys.Seal(bytes.Repeat([]byte{9}, 32), []string{"personal", owner, endpoint, "signing-key", signingID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_signing_keys (id,endpoint_id,slot,envelope_version,master_key_id,nonce,ciphertext,created_at) VALUES ($1,$2,'current',$3,$4,$5,$6,now())`, signingID, endpoint, signing.Version, signing.MasterKeyID, signing.Nonce, signing.Ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_endpoint_waits (endpoint_id,destination_revision,owner_kind,owner_id,updated_at) VALUES ($1,1,'personal',$2,now())`, endpoint, owner)
	if err != nil {
		t.Fatal(err)
	}
	app, err := OpenApp(ctx, c)
	if app != nil {
		_ = app.Close(ctx)
		t.Fatal("opened with missing referenced master")
	}
	if !errors.Is(err, secretbox.ErrMissingKey) {
		t.Fatalf("missing key error: %v", err)
	}
	path := filepath.Join(filepath.Dir(c.StorageRoot), "webhook-keys.json")
	if err = os.WriteFile(path, keyring, 0600); err != nil {
		t.Fatal(err)
	}
	c.WebhookKeyringFile = path
	app, err = OpenApp(ctx, c)
	if err != nil {
		t.Fatalf("open with referenced key: %v", err)
	}
	if err = app.Ready(ctx); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if err = app.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}
	wrong := []byte(`{"activeKeyId":"primary","keys":{"primary":"` + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32)) + `"}}`)
	if err = os.WriteFile(path, wrong, 0600); err != nil {
		t.Fatal(err)
	}
	app, err = OpenApp(ctx, c)
	if app != nil || !errors.Is(err, secretbox.ErrAuthentication) {
		t.Fatalf("wrong key authentication: %v", err)
	}
	if err = os.WriteFile(path, keyring, 0600); err != nil {
		t.Fatal(err)
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
	// Inventory pins the RR view before the competing replacement commits.
	// A fresh page would see only the valid new envelope and miss corruption.
	badNonce := bytes.Repeat([]byte{3}, len(envelope.Nonce))
	_, err = db.Pool.Exec(ctx, `UPDATE webhook_endpoints SET destination_nonce=$2 WHERE id=$1`, endpoint, badNonce)
	if err != nil {
		t.Fatal(err)
	}
	wrapped := startupInterleave{Store: db, afterInventory: func() error {
		_, e := db.Pool.Exec(ctx, `UPDATE webhook_endpoints SET destination_nonce=$2 WHERE id=$1`, endpoint, envelope.Nonce)
		return e
	}}
	if err = validateWebhookStartup(ctx, wrapped, keys); !errors.Is(err, secretbox.ErrAuthentication) {
		t.Fatalf("concurrent replacement hid snapshot authentication failure: %v", err)
	}
}

type startupInterleave struct {
	*postgres.Store
	afterInventory func() error
}

func (s startupInterleave) OpenWebhookRecoverySnapshot(ctx context.Context) (store.WebhookRecoverySnapshot, error) {
	snapshot, err := s.Store.OpenWebhookRecoverySnapshot(ctx)
	if err != nil {
		return nil, err
	}
	return startupInterleaveSnapshot{WebhookRecoverySnapshot: snapshot, afterInventory: s.afterInventory}, nil
}

type startupInterleaveSnapshot struct {
	store.WebhookRecoverySnapshot
	afterInventory func() error
}

func (s startupInterleaveSnapshot) WebhookMasterKeyIDs(ctx context.Context) ([]string, error) {
	ids, err := s.WebhookRecoverySnapshot.WebhookMasterKeyIDs(ctx)
	if err == nil {
		err = s.afterInventory()
	}
	return ids, err
}

func TestOpenAppRejectsUnreadableOrMalformedWebhookKeyring(t *testing.T) {
	for _, tc := range []struct {
		name, rule string
		contents   []byte
		missing    bool
	}{
		{name: "missing file", rule: "must be readable", missing: true},
		{name: "invalid contents", rule: "must contain a valid keyring", contents: []byte(`{"activeKeyId":"private-invalid-value"}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := appTestConfig(t)
			c.WebhookKeyringFile = filepath.Join(filepath.Dir(c.StorageRoot), "keys.json")
			if !tc.missing {
				if err := os.WriteFile(c.WebhookKeyringFile, tc.contents, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			app, err := OpenAppWithLogger(context.Background(), c, nil)
			var invalid *config.ConfigurationError
			if app != nil || !errors.As(err, &invalid) || invalid.Field != "DAYNIGHT_WEBHOOK_KEYRING_FILE" || invalid.Rule != tc.rule || errors.Unwrap(invalid) == nil {
				t.Fatalf("keyring failure: app=%v error=%v", app, err)
			}
			if tc.missing && !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("missing file cause lost: %v", err)
			}
			if strings.Contains(err.Error(), "private-invalid-value") {
				t.Fatal("keyring contents leaked in error")
			}
			// Failed initialization releases the same resources needed on retry.
			c.WebhookKeyringFile = ""
			app, err = OpenAppWithLogger(context.Background(), c, nil)
			if err != nil {
				t.Fatalf("retry after correcting keyring: %v", err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err = app.Ready(ctx); err != nil {
				t.Fatalf("retry readiness: %v", err)
			}
			if err = app.Close(ctx); err != nil {
				t.Fatalf("retry close: %v", err)
			}
		})
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
