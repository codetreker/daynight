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
	owner, endpoint := uuid.NewString(), uuid.NewString()
	envelope, err := keys.Seal([]byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/hook"}}`), []string{"personal", owner, endpoint, "endpoint-current", "1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_endpoints
		(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at)
		VALUES($1,'personal',$2,'receiver',true,1,1,'http',1,1,'https://receiver.example',$3,$4,$5,$6,$7,now(),now())`, endpoint, owner, envelope.Version, envelope.MasterKeyID, envelope.Nonce, envelope.Ciphertext, uuid.NewString())
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
