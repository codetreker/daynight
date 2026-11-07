package postgres

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWebhookRecoverySnapshotIdentityAndInventory(t *testing.T) {
	db := isolatedStore(t)
	ctx := context.Background()
	snapshot, err := db.OpenWebhookRecoverySnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	id, err := snapshot.RecoveryIdentity(ctx)
	if err != nil || id.ClusterID == "" || id.DatabaseOID == 0 {
		t.Fatalf("database identity %+v %v", id, err)
	}
	var systemID string
	var oid uint32
	if err = db.Pool.QueryRow(ctx, `SELECT (pg_catalog.pg_control_system()).system_identifier::pg_catalog.text,oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()`).Scan(&systemID, &oid); err != nil || id != (store.WebhookRecoveryIdentity{ClusterID: systemID, DatabaseOID: oid}) {
		t.Fatalf("real identity %+v %s %d %v", id, systemID, oid, err)
	}
	endpoint, keyID := uuid.NewString(), uuid.NewString()
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_signing_keys(id,endpoint_id,slot,envelope_version,master_key_id,nonce,ciphertext,created_at) VALUES($1,$2,'current',1,'after-snapshot',decode(repeat('00',12),'hex'),decode(repeat('00',48),'hex'),now())`, keyID, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := snapshot.WebhookMasterKeyIDs(ctx)
	if err != nil || len(ids) != 0 {
		t.Fatalf("snapshot changed: %v %v", ids, err)
	}
	if err = snapshot.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = snapshot.RecoveryIdentity(ctx); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed identity read: %v", err)
	}
	if _, err = snapshot.WebhookMasterKeyIDs(ctx); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed inventory read: %v", err)
	}
	fresh, err := db.OpenWebhookRecoverySnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close(ctx)
	ids, err = fresh.WebhookMasterKeyIDs(ctx)
	if err != nil || !reflect.DeepEqual(ids, []string{"after-snapshot"}) {
		t.Fatalf("fresh inventory %v %v", ids, err)
	}
}

func TestWebhookRecoverySnapshotCorruptInventory(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup []string
		want  string
	}{
		{"missing relation", []string{`ALTER TABLE webhook_signing_keys RENAME TO inaccessible_webhook_signing_keys`}, "webhook recovery references"},
		{"empty key", []string{`ALTER TABLE webhook_signing_keys DROP CONSTRAINT webhook_signing_keys_master_key_id_check`, `INSERT INTO webhook_signing_keys(id,endpoint_id,slot,envelope_version,master_key_id,nonce,ciphertext,created_at) VALUES(gen_random_uuid(),gen_random_uuid(),'current',1,'',decode(repeat('00',12),'hex'),decode(repeat('00',48),'hex'),now())`}, "invalid webhook master key reference"},
		{"null key", []string{`ALTER TABLE webhook_signing_keys DROP CONSTRAINT webhook_signing_keys_master_key_id_check`, `ALTER TABLE webhook_signing_keys ALTER COLUMN master_key_id DROP NOT NULL`, `INSERT INTO webhook_signing_keys(id,endpoint_id,slot,envelope_version,master_key_id,nonce,ciphertext,created_at) VALUES(gen_random_uuid(),gen_random_uuid(),'current',1,NULL,decode(repeat('00',12),'hex'),decode(repeat('00',48),'hex'),now())`}, "scan webhook recovery references"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := isolatedStore(t)
			ctx := context.Background()
			for _, query := range tc.setup {
				if _, err := db.Pool.Exec(ctx, query); err != nil {
					t.Fatal(err)
				}
			}
			snapshot, err := db.OpenWebhookRecoverySnapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer snapshot.Close(ctx)
			if _, err = snapshot.WebhookMasterKeyIDs(ctx); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("corruption not reported: %v", err)
			}
		})
	}
}

func TestWebhookCiphertextReadByID(t *testing.T) {
	db := isolatedStore(t)
	ctx := context.Background()
	endpoint, owner, keyID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	_, err := db.Pool.Exec(ctx, `INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at) VALUES($1,'personal',$2,'receiver',true,1,1,'http',1,1,'https://example.test',1,'master',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),$3,now(),now())`, endpoint, owner, keyID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_signing_keys(id,endpoint_id,slot,envelope_version,master_key_id,nonce,ciphertext,created_at) VALUES($1,$2,'current',1,'master',decode(repeat('00',12),'hex'),decode(repeat('00',48),'hex'),now())`, keyID, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ kind, id string }{{"endpoint-current", endpoint}, {"signing-key", keyID}} {
		item, e := db.WebhookCiphertextByID(ctx, c.kind, c.id)
		if e != nil || item == nil || item.ID != c.id || item.OwnerID != owner || item.MasterKeyID != "master" {
			t.Fatalf("%s read %+v %v", c.kind, item, e)
		}
	}
	missing, e := db.WebhookCiphertextByID(ctx, "delivery-destination", uuid.NewString())
	if e != nil || missing != nil {
		t.Fatalf("missing delivery %+v %v", missing, e)
	}
	if _, e = db.WebhookCiphertextByID(ctx, "unsupported", endpoint); e == nil {
		t.Fatal("unsupported kind accepted")
	}
	if _, e = db.WebhookCiphertextByID(ctx, "endpoint-current", "not-a-uuid"); e == nil {
		t.Fatal("database failure hidden")
	}
	if _, err = db.Pool.Exec(ctx, `DELETE FROM webhook_endpoints WHERE id=$1`, endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = db.WebhookCiphertextByID(ctx, "signing-key", keyID); err == nil || !strings.Contains(err.Error(), "orphaned") {
		t.Fatalf("orphaned key accepted: %v", err)
	}
}

func TestWebhookRecoveryIdentityRejectsSearchPathSpoofing(t *testing.T) {
	db := isolatedStore(t)
	ctx := context.Background()
	var schema string
	if err := db.Pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	ident := pgx.Identifier{schema}.Sanitize()
	for _, query := range []string{
		fmt.Sprintf(`CREATE TYPE %s.fake_control AS (system_identifier text)`, ident),
		fmt.Sprintf(`CREATE FUNCTION %s.pg_control_system() RETURNS %s.fake_control LANGUAGE SQL AS 'SELECT ROW(''fake-cluster'')::%s.fake_control'`, ident, ident, ident),
		fmt.Sprintf(`CREATE FUNCTION %s.current_database() RETURNS name LANGUAGE SQL AS 'SELECT ''fake-db''::name'`, ident),
		fmt.Sprintf(`CREATE FUNCTION %s.fake_name_equal(name,name) RETURNS boolean LANGUAGE SQL AS 'SELECT $1 OPERATOR(pg_catalog.=) ''postgres''::pg_catalog.name'`, ident),
		fmt.Sprintf(`CREATE OPERATOR %s.= (LEFTARG=name,RIGHTARG=name,FUNCTION=%s.fake_name_equal)`, ident, ident),
		fmt.Sprintf(`CREATE TABLE %s.pg_database (oid oid, datname name)`, ident),
		fmt.Sprintf(`INSERT INTO %s.pg_database VALUES (42,'fake-db')`, ident),
	} {
		if _, err := db.Pool.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	parsed, err := url.Parse(db.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	q := parsed.Query()
	q.Set("search_path", schema+",pg_catalog")
	q.Set("application_name", "t06_fake_recovery_identity")
	parsed.RawQuery = q.Encode()
	aliasPool, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer aliasPool.Close()
	alias := &Store{Pool: aliasPool}
	var forged string
	var forgedOID uint32
	if err = aliasPool.QueryRow(ctx, `SELECT (pg_control_system()).system_identifier::text,oid FROM pg_database WHERE datname OPERATOR(pg_catalog.=) current_database()`).Scan(&forged, &forgedOID); err != nil || forged != "fake-cluster" || forgedOID != 42 {
		t.Fatalf("spoof fixture %q %d %v", forged, forgedOID, err)
	}
	var operatorOID uint32
	if err = aliasPool.QueryRow(ctx, `SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()`).Scan(&operatorOID); err != nil {
		t.Fatalf("spoofed operator: %v", err)
	}
	first, err := db.OpenWebhookRecoverySnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	id, err := first.RecoveryIdentity(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = first.Close(ctx); err != nil {
		t.Fatal(err)
	}
	second, err := alias.OpenWebhookRecoverySnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	id2, err := second.RecoveryIdentity(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = second.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if id != id2 || id2.ClusterID == forged || id2.DatabaseOID == forgedOID || id2.DatabaseOID == operatorOID {
		t.Fatalf("database identity spoofed: %+v %+v", id, id2)
	}
	raw := `{"activeKeyId":"new","keys":{"new":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}`
	keys, err := secretbox.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = webhook.VerifyKeyRecovery(ctx, db, alias, keys, keys, "old"); err == nil || !strings.Contains(err.Error(), "not independent") {
		t.Fatalf("same database accepted: %v", err)
	}
}
