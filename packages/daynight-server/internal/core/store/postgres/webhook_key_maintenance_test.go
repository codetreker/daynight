package postgres

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestWebhookRewrapRealRecords(t *testing.T) {
	db := isolatedStore(t)
	ctx := context.Background()
	raw := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	ring := func(active string) *secretbox.Keyring {
		k, e := secretbox.Parse([]byte(fmt.Sprintf(`{"activeKeyId":%q,"keys":{"old":%q,"new":%q}}`, active, raw, raw)))
		if e != nil {
			t.Fatal(e)
		}
		return k
	}
	old, keys := ring("old"), ring("new")
	owner, endpoint, keyID, delivery := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	seal := func(purpose, id, plain string) secretbox.Envelope {
		e, err := old.Seal([]byte(plain), []string{"personal", owner, endpoint, purpose, id}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	ep := seal("endpoint-current", "1", "endpoint-secret")
	sk := seal("signing-key", keyID, string(bytes.Repeat([]byte{3}, 32)))
	dest := seal("delivery-destination", delivery, "delivery-secret")
	_, err := db.Pool.Exec(ctx, `INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at) VALUES($1,'personal',$2,'name',true,1,1,'http',1,1,'https://example.test',$3,$4,$5,$6,$7,now(),now())`, endpoint, owner, ep.Version, ep.MasterKeyID, ep.Nonce, ep.Ciphertext, keyID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_signing_keys(id,endpoint_id,slot,envelope_version,master_key_id,nonce,ciphertext,created_at) VALUES($1,$2,'current',$3,$4,$5,$6,now())`, keyID, endpoint, sk.Version, sk.MasterKeyID, sk.Nonce, sk.Ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO webhook_deliveries(id,event_id,endpoint_id,owner_kind,owner_id,event_type,project_id,occurred_at,original_match_count,original_match_sha256,policy_version,destination_revision,destination_kind,adapter_version,render_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,request_method,request_media_type,deterministic_headers_json,body,original_body_bytes,body_sha256,automatic_schedule_at,automatic_expires_at,payload_expires_at,automatic_plan_cursor,automatic_open,automatic_attempt_count,manual_operation_count,attempt_sequence,generation,state,trigger,expires_at,next_attempt_at,last_activity_at,metadata_expires_at) VALUES ($1,$2,$3,'personal',$4,'task.created',$5,now(),1,decode(repeat('00',32),'hex'),1,1,'http',1,1,1,'https://example.test',$6,$7,$8,$9,'POST','application/cloudevents+json',convert_to('[]','UTF8'),convert_to('{}','UTF8'),2,sha256(convert_to('{}','UTF8')),ARRAY(SELECT now() + i * interval '1 minute' FROM generate_series(0,9) i ORDER BY i),now()+interval '72 hours',now()+interval '7 days',0,true,0,0,0,1,'pending','automatic',now()+interval '72 hours',now(),now(),now()+interval '30 days')`, delivery, uuid.NewString(), endpoint, owner, uuid.NewString(), dest.Version, dest.MasterKeyID, dest.Nonce, dest.Ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	newOnlyEarly, err := secretbox.Parse([]byte(fmt.Sprintf(`{"activeKeyId":"new","keys":{"new":%q}}`, raw)))
	if err != nil {
		t.Fatal(err)
	}
	assertEndpoint := func(want []byte) {
		t.Helper()
		var ciphertext []byte
		var master string
		if e := db.Pool.QueryRow(ctx, `SELECT destination_master_key_id,destination_ciphertext FROM webhook_endpoints WHERE id=$1`, endpoint).Scan(&master, &ciphertext); e != nil || master != "old" || !bytes.Equal(ciphertext, want) {
			t.Fatalf("old recoverable record changed %q %v", master, e)
		}
	}
	if _, err = (webhook.KeyMaintenance{DB: db, Keys: newOnlyEarly}).RewrapPass(ctx, "old", 1); !errors.Is(err, secretbox.ErrMissingKey) {
		t.Fatalf("missing key %v", err)
	}
	if strings.Contains(err.Error(), "endpoint-secret") {
		t.Fatal("missing-key error disclosed plaintext")
	}
	assertEndpoint(ep.Ciphertext)
	if _, err = (webhook.KeyMaintenance{DB: db, Keys: keys, Random: bytes.NewReader(nil)}).RewrapPass(ctx, "old", 1); !errors.Is(err, io.EOF) {
		t.Fatalf("random failure %v", err)
	}
	assertEndpoint(ep.Ciphertext)
	tampered := append([]byte(nil), ep.Ciphertext...)
	tampered[0] ^= 1
	if _, err = db.Pool.Exec(ctx, `UPDATE webhook_endpoints SET destination_ciphertext=$2 WHERE id=$1`, endpoint, tampered); err != nil {
		t.Fatal(err)
	}
	if _, err = (webhook.KeyMaintenance{DB: db, Keys: keys}).RewrapPass(ctx, "old", 1); !errors.Is(err, secretbox.ErrAuthentication) {
		t.Fatalf("bad tag %v", err)
	}
	assertEndpoint(tampered)
	if _, err = db.Pool.Exec(ctx, `UPDATE webhook_endpoints SET destination_ciphertext=$2 WHERE id=$1`, endpoint, ep.Ciphertext); err != nil {
		t.Fatal(err)
	}
	assertEndpoint(ep.Ciphertext)
	candidates, err := db.WebhookCiphertexts(ctx, "old", nil, 3)
	if err != nil || len(candidates) != 3 {
		t.Fatalf("scan %d %v", len(candidates), err)
	}
	var page *store.WebhookCiphertext
	for i := 0; i < 3; i++ {
		rows, e := db.WebhookCiphertexts(ctx, "old", page, 1)
		if e != nil || len(rows) != 1 {
			t.Fatalf("page %d: %v", i, e)
		}
		next := rows[0]
		page = &next
	}
	rows, e := db.WebhookCiphertexts(ctx, "old", page, 1)
	if e != nil || len(rows) != 0 {
		t.Fatalf("terminal page: %v %v", rows, e)
	}
	for _, c := range candidates {
		bad := c
		bad.RecordID += "x"
		if _, err = db.CompareAndSwapWebhookCiphertext(ctx, c, bad); err == nil {
			t.Fatal("identity change accepted")
		}
	}
	restored := isolatedStore(t)
	var sourceSchema, restoredSchema string
	if err = db.Pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&sourceSchema); err != nil {
		t.Fatal(err)
	}
	if err = restored.Pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&restoredSchema); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"webhook_endpoints", "webhook_signing_keys", "webhook_deliveries"} {
		sql := fmt.Sprintf("INSERT INTO %s.%s SELECT * FROM %s.%s", pgx.Identifier{restoredSchema}.Sanitize(), pgx.Identifier{table}.Sanitize(), pgx.Identifier{sourceSchema}.Sanitize(), pgx.Identifier{table}.Sanitize())
		if _, err = db.Pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	aliasURL, e := url.Parse(db.Pool.Config().ConnString())
	if e != nil {
		t.Fatal(e)
	}
	q := aliasURL.Query()
	q.Set("application_name", "other-recovery-pool")
	aliasURL.RawQuery = q.Encode()
	aliasPool, e := pgxpool.New(ctx, aliasURL.String())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(aliasPool.Close)
	alias := &Store{Pool: aliasPool}
	if _, err = webhook.VerifyKeyRecovery(ctx, db, alias, old, keys, "old"); err == nil || !strings.Contains(err.Error(), "not independent") {
		t.Fatalf("same database different pool and DSN accepted: %v", err)
	}
	closedProducer := make(chan struct{})
	close(closedProducer)
	aliasInventory := &retirementTestInventory{producers: []webhook.ProducerObservation{{ID: "drained", ActiveMasterID: "old", Done: closedProducer}}, backups: []webhook.RecoverySnapshot{{ID: "alias", Source: db, Restored: alias, SourceKeys: old, RestoredKeys: keys}}}
	aliasResult, aliasErr := webhook.AssessKeyRetirement(ctx, "old", db, aliasInventory)
	if aliasResult.Safe || aliasErr == nil || !strings.Contains(aliasErr.Error(), "not independent") {
		t.Fatalf("same database retirement accepted: %+v %v", aliasResult, aliasErr)
	}
	if _, err = webhook.VerifyKeyRecovery(ctx, db, restored, old, keys, "old"); err == nil || !strings.Contains(err.Error(), "not independent") {
		t.Fatalf("same database schemas accepted: %v", err)
	}
	// The schema-only fixture uses injected identities for cipher comparison;
	// physical independence is separately tested with real restored databases.
	sourceFixture := recoveryIdentityFixture{Store: db, oid: 1}
	restoredFixture := recoveryIdentityFixture{Store: restored, oid: 2}
	if _, err = webhook.VerifyKeyRecovery(ctx, sourceFixture, restoredFixture, old, keys, "old"); err == nil {
		t.Fatal("old backup reference accepted")
	}
	process := exec.Command(os.Args[0], "-test.run=^TestKeyRewrapProcess$")
	process.Env = append(os.Environ(), "T06_REWRAP_URL="+restored.Pool.Config().ConnString(), "T06_REWRAP_KEY="+raw)
	if output, e := process.CombinedOutput(); e != nil {
		t.Fatalf("first rewrap process: %v %s", e, output)
	}
	remaining, e := restored.WebhookCiphertexts(ctx, "old", nil, 3)
	if e != nil || len(remaining) != 2 {
		t.Fatalf("interrupted batches: %d %v", len(remaining), e)
	}
	for i := 1; i < 3; i++ {
		m := webhook.KeyMaintenance{DB: restored, Keys: keys}
		result, e := m.RewrapPass(ctx, "old", 1)
		if e != nil || result.Rewrapped != 1 {
			t.Fatalf("pass %d %+v %v", i, result, e)
		}
	}
	ids, err := restored.WebhookMasterKeyIDs(ctx)
	if err != nil || len(ids) != 1 || ids[0] != "new" {
		t.Fatalf("inventory %v %v", ids, err)
	}
	got, err := restored.WebhookCiphertexts(ctx, "new", nil, 3)
	if err != nil || len(got) != 3 {
		t.Fatalf("new scan %d %v", len(got), err)
	}
	want := map[string]string{"endpoint-current": "endpoint-secret", "signing-key": string(bytes.Repeat([]byte{3}, 32)), "delivery-destination": "delivery-secret"}
	for _, c := range got {
		plain, e := keys.Open(secretbox.Envelope{Version: c.Version, MasterKeyID: c.MasterKeyID, Nonce: c.Nonce, Ciphertext: c.Ciphertext}, []string{c.OwnerKind, c.OwnerID, c.EndpointID, c.Kind, c.RecordID})
		if e != nil || string(plain) != want[c.Kind] {
			t.Fatalf("plaintext %s: %v", c.Kind, e)
		}
	}
	if ok, e := restored.CompareAndSwapWebhookCiphertext(ctx, candidates[0], got[0]); e != nil || ok {
		t.Fatalf("stale CAS %v %v", ok, e)
	}
	newOnly, err := secretbox.Parse([]byte(fmt.Sprintf(`{"activeKeyId":"new","keys":{"new":%q}}`, raw)))
	if err != nil {
		t.Fatal(err)
	}
	n, err := webhook.VerifyKeyRecovery(ctx, sourceFixture, restoredFixture, old, newOnly, "old")
	if err != nil || n != 3 {
		t.Fatalf("recovery comparison %d %v", n, err)
	}
	retainedCopy := isolatedStore(t)
	var copySchema string
	if err = retainedCopy.Pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&copySchema); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"webhook_endpoints", "webhook_signing_keys", "webhook_deliveries"} {
		sql := fmt.Sprintf("INSERT INTO %s.%s SELECT * FROM %s.%s", pgx.Identifier{copySchema}.Sanitize(), pgx.Identifier{table}.Sanitize(), pgx.Identifier{restoredSchema}.Sanitize(), pgx.Identifier{table}.Sanitize())
		if _, err = db.Pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	copyFixture := recoveryIdentityFixture{Store: retainedCopy, oid: 3}
	online := isolatedStore(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestOldKeyProducerProcess$")
	cmd.Env = append(os.Environ(), "T06_PRODUCER_URL="+online.Pool.Config().ConnString(), "T06_PRODUCER_KEY="+raw)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	t.Cleanup(func() {
		_ = stdin.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})
	childOut := bufio.NewReader(stdout)
	if line, e := childOut.ReadString('\n'); e != nil || strings.TrimSpace(line) != "ready" {
		t.Fatalf("producer start %q %v", line, e)
	}
	inv := &retirementTestInventory{producers: []webhook.ProducerObservation{{ID: "old-instance", ActiveMasterID: "old", Done: done}}, backups: []webhook.RecoverySnapshot{{ID: "backup", Source: restoredFixture, Restored: copyFixture, SourceKeys: newOnly, RestoredKeys: newOnly}}}
	beforeIDs, scanErr := online.WebhookMasterKeyIDs(ctx)
	if scanErr != nil || len(beforeIDs) != 0 {
		t.Fatalf("initial online scan %v %v", beforeIDs, scanErr)
	}
	decision, e := webhook.AssessKeyRetirement(ctx, "old", online, inv)
	if e != nil || decision.Safe {
		t.Fatalf("live old producer: %+v %v", decision, e)
	}
	if _, err = io.WriteString(stdin, "write\n"); err != nil {
		t.Fatal(err)
	}
	if line, e := childOut.ReadString('\n'); e != nil || strings.TrimSpace(line) != "written" {
		t.Fatalf("old producer write %q %v", line, e)
	}
	afterIDs, scanErr := online.WebhookMasterKeyIDs(ctx)
	if scanErr != nil || len(afterIDs) != 1 || afterIDs[0] != "old" {
		t.Fatalf("late producer reference %v %v", afterIDs, scanErr)
	}
	_ = stdin.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("producer did not drain")
	}
	decision, e = webhook.AssessKeyRetirement(ctx, "old", online, inv)
	if e != nil || decision.Safe {
		t.Fatalf("old reference after drain: %+v %v", decision, e)
	}
	result, e := (webhook.KeyMaintenance{DB: online, Keys: keys}).RewrapPass(ctx, "old", 500)
	if e != nil || result.Rewrapped != 1 {
		t.Fatalf("late write rewrap %+v %v", result, e)
	}
	inv.backups = append(inv.backups, webhook.RecoverySnapshot{ID: "still-retained-old", Source: sourceFixture, Restored: restoredFixture, SourceKeys: old, RestoredKeys: newOnly})
	decision, e = webhook.AssessKeyRetirement(ctx, "old", online, inv)
	if e != nil || decision.Safe {
		t.Fatalf("retained old backup: %+v %v", decision, e)
	}
	inv.backups = inv.backups[:1]
	decision, e = webhook.AssessKeyRetirement(ctx, "old", online, inv)
	if e != nil || !decision.Safe || decision.Compared != 3 {
		t.Fatalf("joint retirement %+v %v", decision, e)
	}
	if _, err = restored.Pool.Exec(ctx, `DELETE FROM webhook_signing_keys WHERE id=$1`, keyID); err != nil {
		t.Fatal(err)
	}
	if _, err = webhook.VerifyKeyRecovery(ctx, sourceFixture, restoredFixture, old, keys, "old"); err == nil {
		t.Fatal("missing recovered secret accepted")
	}
	var config, revision int
	var body string
	if err = db.Pool.QueryRow(ctx, `SELECT config_version,destination_revision FROM webhook_endpoints WHERE id=$1`, endpoint).Scan(&config, &revision); err != nil || config != 1 || revision != 1 {
		t.Fatalf("versions %d %d %v", config, revision, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT convert_from(body,'UTF8') FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&body); err != nil || body != "{}" {
		t.Fatalf("body %q %v", body, err)
	}
	if _, err = db.WebhookCiphertexts(ctx, "old", nil, 501); err == nil {
		t.Fatal("unbounded scan accepted")
	}
	unknown := store.WebhookCiphertext{Kind: "unknown"}
	if _, err = db.CompareAndSwapWebhookCiphertext(ctx, unknown, unknown); err == nil {
		t.Fatal("unknown kind accepted")
	}
}

type retirementTestInventory struct {
	producers []webhook.ProducerObservation
	backups   []webhook.RecoverySnapshot
}

func (i *retirementTestInventory) Producers(context.Context) ([]webhook.ProducerObservation, error) {
	return i.producers, nil
}
func (i *retirementTestInventory) Backups(context.Context) ([]webhook.RecoverySnapshot, error) {
	return i.backups, nil
}

func TestOldKeyProducerProcess(t *testing.T) {
	url := os.Getenv("T06_PRODUCER_URL")
	if url == "" {
		return
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	encoded := os.Getenv("T06_PRODUCER_KEY")
	keys, err := secretbox.Parse([]byte(fmt.Sprintf(`{"activeKeyId":"old","keys":{"old":%q}}`, encoded)))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintln(os.Stdout, "ready")
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "write" {
		t.Fatalf("producer input: %v", err)
	}
	owner, endpoint, keyID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	env, err := keys.Seal([]byte("late destination"), []string{"personal", owner, endpoint, "endpoint-current", "1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at) VALUES($1,'personal',$2,'name',true,1,1,'http',1,1,'https://example.test',$3,$4,$5,$6,$7,now(),now())`, endpoint, owner, env.Version, env.MasterKeyID, env.Nonce, env.Ciphertext, keyID)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintln(os.Stdout, "written")
	_, _ = io.Copy(io.Discard, reader)
}

func TestKeyRewrapProcess(t *testing.T) {
	url := os.Getenv("T06_REWRAP_URL")
	if url == "" {
		return
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	raw := os.Getenv("T06_REWRAP_KEY")
	keys, err := secretbox.Parse([]byte(fmt.Sprintf(`{"activeKeyId":"new","keys":{"new":%q,"old":%q}}`, raw, raw)))
	if err != nil {
		t.Fatal(err)
	}
	result, err := (webhook.KeyMaintenance{DB: &Store{Pool: pool}, Keys: keys}).RewrapPass(ctx, "old", 1)
	if err != nil || result.Rewrapped != 1 {
		t.Fatalf("child rewrap %+v %v", result, err)
	}
}

// recoveryIdentityFixture isolates crypto semantics from the schema-only fixture;
// it is not evidence that these schemas are independent PostgreSQL databases.
type recoveryIdentityFixture struct {
	*Store
	oid uint32
}
type recoveryIdentitySnapshot struct {
	store.WebhookRecoverySnapshot
	oid uint32
}

func (r recoveryIdentityFixture) OpenWebhookRecoverySnapshot(ctx context.Context) (store.WebhookRecoverySnapshot, error) {
	s, e := r.Store.OpenWebhookRecoverySnapshot(ctx)
	if e != nil {
		return nil, e
	}
	return recoveryIdentitySnapshot{WebhookRecoverySnapshot: s, oid: r.oid}, nil
}
func (s recoveryIdentitySnapshot) RecoveryIdentity(context.Context) (store.WebhookRecoveryIdentity, error) {
	return store.WebhookRecoveryIdentity{ClusterID: "synthetic-fixture", DatabaseOID: s.oid}, nil
}

func TestWebhookRecoverySharedSingleConnectionPoolIsBounded(t *testing.T) {
	db := isolatedStore(t)
	parsed, err := url.Parse(db.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("pool_max_conns", "1")
	parsed.RawQuery = query.Encode()
	pool, err := pgxpool.New(context.Background(), parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	first, second := &Store{Pool: pool}, &Store{Pool: pool}
	raw := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	keys, err := secretbox.Parse([]byte(fmt.Sprintf(`{"activeKeyId":"new","keys":{"new":%q}}`, raw)))
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = webhook.VerifyKeyRecovery(context.Background(), first, second, keys, keys, "old")
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 6*time.Second {
		t.Fatalf("shared pool must time out, got %v after %v", err, time.Since(start))
	}
	ping, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = pool.Ping(ping); err != nil {
		t.Fatalf("source snapshot not released: %v", err)
	}
	stopped := make(chan struct{})
	close(stopped)
	inv := &retirementTestInventory{producers: []webhook.ProducerObservation{{ID: "stopped", ActiveMasterID: "old", Done: stopped}}, backups: []webhook.RecoverySnapshot{{ID: "backup", Source: first, Restored: second, SourceKeys: keys, RestoredKeys: keys}}}
	decisionCtx, cancelDecision := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancelDecision()
	result, err := webhook.AssessKeyRetirement(decisionCtx, "old", db, inv)
	if result.Safe || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("uncertain identity permitted retirement: %+v %v", result, err)
	}
}
