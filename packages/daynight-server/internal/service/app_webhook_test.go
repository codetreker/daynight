package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

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
