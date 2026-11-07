//go:build stress

package postgres

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This separate stress case creates disposable databases and uses PostgreSQL's
// own archive tools; it is not part of the ordinary CI test suite.
func TestWebhookKeyPhysicalRecoveryStress(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	adminURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	base, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	makeDB := func() string {
		name := "t06_key_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		if _, e := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); e != nil {
			t.Fatal(e)
		}
		names = append(names, name)
		u := *base
		u.Path = "/" + name
		u.RawQuery = "sslmode=disable"
		return u.String()
	}
	t.Cleanup(func() {
		for _, name := range names {
			cleanup, c := context.WithTimeout(context.Background(), 10*time.Second)
			_, e := admin.Exec(cleanup, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
			c()
			if e != nil {
				t.Error(e)
			}
		}
	})
	sourceURL, oldURL, newURL, copyURL, onlineURL := makeDB(), makeDB(), makeDB(), makeDB(), makeDB()
	source, err := Open(ctx, sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	raw := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	ring := func(active string, includeOld bool) *secretbox.Keyring {
		old := ""
		if includeOld {
			old = fmt.Sprintf(`,"old":%q`, raw)
		}
		k, e := secretbox.Parse([]byte(fmt.Sprintf(`{"activeKeyId":%q,"keys":{"new":%q%s}}`, active, raw, old)))
		if e != nil {
			t.Fatal(e)
		}
		return k
	}
	old, keys, newOnly := ring("old", true), ring("new", true), ring("new", false)
	owner, endpoint, keyID, delivery := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	seal := func(purpose, id, plain string) secretbox.Envelope {
		e, er := old.Seal([]byte(plain), []string{"personal", owner, endpoint, purpose, id}, nil)
		if er != nil {
			t.Fatal(er)
		}
		return e
	}
	ep, sk, dest := seal("endpoint-current", "1", "endpoint-secret"), seal("signing-key", keyID, string(bytes.Repeat([]byte{3}, 32))), seal("delivery-destination", delivery, "delivery-secret")
	_, err = source.Pool.Exec(ctx, `INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at) VALUES($1,'personal',$2,'name',true,1,1,'http',1,1,'https://example.test',$3,$4,$5,$6,$7,now(),now())`, endpoint, owner, ep.Version, ep.MasterKeyID, ep.Nonce, ep.Ciphertext, keyID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = source.Pool.Exec(ctx, `INSERT INTO webhook_signing_keys(id,endpoint_id,slot,envelope_version,master_key_id,nonce,ciphertext,created_at) VALUES($1,$2,'current',$3,$4,$5,$6,now())`, keyID, endpoint, sk.Version, sk.MasterKeyID, sk.Nonce, sk.Ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	_, err = source.Pool.Exec(ctx, `INSERT INTO webhook_deliveries(id,event_id,endpoint_id,owner_kind,owner_id,event_type,project_id,occurred_at,original_match_count,original_match_sha256,policy_version,destination_revision,destination_kind,adapter_version,render_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,request_method,request_media_type,deterministic_headers_json,body,original_body_bytes,body_sha256,automatic_schedule_at,automatic_expires_at,payload_expires_at,automatic_plan_cursor,automatic_open,automatic_attempt_count,manual_operation_count,attempt_sequence,generation,state,trigger,expires_at,next_attempt_at,last_activity_at,metadata_expires_at) VALUES ($1,$2,$3,'personal',$4,'task.created',$5,now(),1,decode(repeat('00',32),'hex'),1,1,'http',1,1,1,'https://example.test',$6,$7,$8,$9,'POST','application/cloudevents+json',convert_to('[]','UTF8'),convert_to('{"fixed":true}','UTF8'),14,sha256(convert_to('{"fixed":true}','UTF8')),ARRAY(SELECT now() + i * interval '1 minute' FROM generate_series(0,9) i ORDER BY i),now()+interval '72 hours',now()+interval '7 days',0,true,0,0,0,1,'pending','automatic',now()+interval '72 hours',now(),now(),now()+interval '30 days')`, delivery, uuid.NewString(), endpoint, owner, uuid.NewString(), dest.Version, dest.MasterKeyID, dest.Nonce, dest.Ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	dump := func(dbURL string) []byte {
		cmd := exec.CommandContext(ctx, "docker", "run", "--rm", "--network", "host", "postgres:18.6", "pg_dump", "--format=custom", "--no-owner", "--no-acl", dbURL)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		b, e := cmd.Output()
		if e != nil {
			t.Fatalf("pg_dump: %v: %s", e, stderr.String())
		}
		return b
	}
	restore := func(dbURL string, data []byte) *Store {
		cmd := exec.CommandContext(ctx, "docker", "run", "--rm", "-i", "--network", "host", "postgres:18.6", "pg_restore", "--exit-on-error", "--no-owner", "--no-acl", "--dbname", dbURL)
		cmd.Stdin = bytes.NewReader(data)
		if b, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("pg_restore: %v: %s", e, b)
		}
		db, e := Open(ctx, dbURL)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(db.Close)
		return db
	}
	archiveOld := dump(sourceURL)
	oldRestore := restore(oldURL, archiveOld)
	if _, err = webhook.VerifyKeyRecovery(ctx, source, oldRestore, old, newOnly, "old"); err == nil {
		t.Fatal("retained old archive accepted")
	}
	result, err := (webhook.KeyMaintenance{DB: oldRestore, Keys: keys}).RewrapPass(ctx, "old", 500)
	if err != nil || result.Rewrapped != 3 {
		t.Fatalf("rewrap %+v %v", result, err)
	}
	archiveNew := dump(oldURL)
	fresh := restore(newURL, archiveNew)
	copy := restore(copyURL, archiveNew)
	count, err := webhook.VerifyKeyRecovery(ctx, source, fresh, old, newOnly, "old")
	if err != nil || count != 3 {
		t.Fatalf("actual restore %d %v", count, err)
	}
	sourceKeysFile := filepath.Join(t.TempDir(), "source.json")
	restoredKeysFile := filepath.Join(t.TempDir(), "restored.json")
	if err = os.WriteFile(sourceKeysFile, []byte(fmt.Sprintf(`{"activeKeyId":"old","keys":{"old":%q,"new":%q}}`, raw, raw)), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(restoredKeysFile, []byte(fmt.Sprintf(`{"activeKeyId":"new","keys":{"new":%q}}`, raw)), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, "go", "run", "./cmd/webhook-key-maintenance", "--mode=verify-restore", "--old-master=old")
	command.Dir = "../../../.."
	command.Env = append(os.Environ(), "DAYNIGHT_DATABASE_URL="+sourceURL, "DAYNIGHT_RESTORED_DATABASE_URL="+newURL, "DAYNIGHT_WEBHOOK_KEYRING_FILE="+sourceKeysFile, "DAYNIGHT_RESTORED_WEBHOOK_KEYRING_FILE="+restoredKeysFile)
	if output, e := command.CombinedOutput(); e != nil || !bytes.Contains(output, []byte(`"compared":3`)) {
		t.Fatalf("actual restored CLI verification: %v %s", e, output)
	}
	type facts struct {
		Body, Hash        []byte
		Config, Revision  int64
		Payload, Metadata time.Time
	}
	readFacts := func(db *Store) facts {
		var f facts
		e := db.Pool.QueryRow(ctx, `SELECT d.body,d.body_sha256,e.config_version,e.destination_revision,d.payload_expires_at,d.metadata_expires_at FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, delivery).Scan(&f.Body, &f.Hash, &f.Config, &f.Revision, &f.Payload, &f.Metadata)
		if e != nil {
			t.Fatal(e)
		}
		return f
	}
	if a, b := readFacts(source), readFacts(fresh); !reflect.DeepEqual(a, b) {
		t.Fatalf("restored business facts differ: %+v %+v", a, b)
	}
	online, err := Open(ctx, onlineURL)
	if err != nil {
		t.Fatal(err)
	}
	defer online.Close()
	process := exec.Command(os.Args[0], "-test.run=^TestOldKeyProducerProcess$")
	process.Env = append(os.Environ(), "T06_PRODUCER_URL="+onlineURL, "T06_PRODUCER_KEY="+raw)
	stdin, err := process.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := process.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	process.Stderr = os.Stderr
	if err = process.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = process.Wait(); close(done) }()
	t.Cleanup(func() {
		_ = stdin.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = process.Process.Kill()
			<-done
		}
	})
	reader := bufio.NewReader(stdout)
	if line, e := reader.ReadString('\n'); e != nil || strings.TrimSpace(line) != "ready" {
		t.Fatalf("producer start %q %v", line, e)
	}
	if _, err = io.WriteString(stdin, "write\n"); err != nil {
		t.Fatal(err)
	}
	if line, e := reader.ReadString('\n'); e != nil || strings.TrimSpace(line) != "written" {
		t.Fatalf("producer write %q %v", line, e)
	}
	_ = stdin.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("producer did not drain")
	}
	result, err = (webhook.KeyMaintenance{DB: online, Keys: keys}).RewrapPass(ctx, "old", 500)
	if err != nil || result.Rewrapped != 1 {
		t.Fatalf("online rewrap %+v %v", result, err)
	}
	inventory := &retirementTestInventory{producers: []webhook.ProducerObservation{{ID: "controlled-drained", ActiveMasterID: "old", Done: done}}, backups: []webhook.RecoverySnapshot{{ID: "old-retained", Source: source, Restored: oldRestore, SourceKeys: old, RestoredKeys: newOnly}, {ID: "new-retained", Source: fresh, Restored: copy, SourceKeys: newOnly, RestoredKeys: newOnly}}}
	decision, err := webhook.AssessKeyRetirement(ctx, "old", online, inventory)
	if err != nil || decision.Safe {
		t.Fatalf("old archive retained: %+v %v", decision, err)
	}
	clear(archiveOld)
	archiveOld = nil
	source.Close()
	sourceDB, parseErr := url.Parse(sourceURL)
	if parseErr != nil {
		t.Fatal(parseErr)
	}
	if _, err = admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{strings.TrimPrefix(sourceDB.Path, "/")}.Sanitize()+" WITH (FORCE)"); err != nil {
		t.Fatal(err)
	}
	inventory.backups = inventory.backups[1:]
	decision, err = webhook.AssessKeyRetirement(ctx, "old", online, inventory)
	if err != nil || !decision.Safe || decision.Compared != 3 {
		t.Fatalf("new archive retained: %+v %v", decision, err)
	}
}
