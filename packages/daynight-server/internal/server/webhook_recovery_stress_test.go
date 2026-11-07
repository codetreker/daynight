//go:build stress && webhooktest

package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type recoveryLoopbackResolver struct{}

func (recoveryLoopbackResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
}

func startRecoveryApplication(t *testing.T, f *webhookApplicationFixture, ca *x509.Certificate) {
	t.Helper()
	app, err := service.OpenAppWithLogger(context.Background(), f.cfg, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	var handler Handler
	var runtime *Runtime
	owned := true
	defer func() {
		if !owned {
			return
		}
		cleanup, cancel := context.WithTimeout(context.Background(), f.cfg.ShutdownTimeout)
		defer cancel()
		if runtime != nil {
			if err := runtime.Close(cleanup); err != nil {
				t.Errorf("close failed recovery runtime: %v", err)
			}
			return
		}
		if handler != nil {
			handler.BeginShutdown()
			if err := handler.Shutdown(cleanup); err != nil {
				t.Errorf("drain failed recovery handler: %v", err)
				return
			}
		}
		if err := app.Close(cleanup); err != nil {
			t.Errorf("close failed recovery application: %v", err)
		}
	}()
	if ca != nil {
		roots := x509.NewCertPool()
		roots.AddCert(ca)
		if err = app.SetControlledWebhookTestTransport(httpoutbound.NewForTesting(recoveryLoopbackResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)); err != nil {
			t.Fatal(err)
		}
	}
	handler, err = New(app, f.cfg, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	runtime, err = Start(context.Background(), "127.0.0.1:0", time.Second, f.cfg.ShutdownTimeout, testLogger(), handler, handler.Shutdown, app.CancelWork, app.Drain, app.Close)
	if err != nil {
		t.Fatal(err)
	}
	root, cancel := context.WithCancel(context.Background())
	if err = app.Start(root); err != nil {
		cancel()
		t.Fatal(err)
	}
	f.runtime, f.cancel, f.done = runtime, cancel, make(chan error, 1)
	go func() { f.done <- runtime.Run(root) }()
	owned = false
}

type recoveryDeliveryFacts struct {
	ID, EventID, State                    string
	Body, Hash                            []byte
	Policy, Revision, Generation          int64
	Schedule                              []time.Time
	AutomaticExpiry, PayloadExpiry        time.Time
	AutomaticCount, ManualCount, Attempts int
	Acknowledged                          *time.Time
	Target                                string
}

func readRecoveryFacts(t *testing.T, ctx context.Context, db *postgres.Store, id, user, endpoint string, keys *secretbox.Keyring) recoveryDeliveryFacts {
	t.Helper()
	var f recoveryDeliveryFacts
	var envelope secretbox.Envelope
	err := db.Pool.QueryRow(ctx, `SELECT d.id::text,d.event_id::text,d.state,d.body,d.body_sha256,d.policy_version,d.destination_revision,d.generation,d.automatic_schedule_at,d.automatic_expires_at,d.payload_expires_at,d.automatic_attempt_count,d.manual_operation_count,d.attempt_sequence,(SELECT max(finished_at) FROM webhook_attempts WHERE delivery_id=d.id AND outcome='acknowledged'),d.destination_envelope_version,d.destination_master_key_id,d.destination_nonce,d.destination_ciphertext FROM webhook_deliveries d WHERE d.id=$1`, id).Scan(&f.ID, &f.EventID, &f.State, &f.Body, &f.Hash, &f.Policy, &f.Revision, &f.Generation, &f.Schedule, &f.AutomaticExpiry, &f.PayloadExpiry, &f.AutomaticCount, &f.ManualCount, &f.Attempts, &f.Acknowledged, &envelope.Version, &envelope.MasterKeyID, &envelope.Nonce, &envelope.Ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := keys.Open(envelope, []string{"personal", user, endpoint, "delivery-destination", id})
	if err != nil {
		t.Fatal(err)
	}
	f.Target = string(plain)
	clear(plain)
	digest := sha256.Sum256(f.Body)
	if !bytes.Equal(digest[:], f.Hash) {
		t.Fatal("body hash mismatch")
	}
	return f
}

// Real application, real PostgreSQL archive/restore and key rewrap. Only the
// receiver's loopback address policy and CA are injected by webhooktest.
func TestWebhookFullApplicationPhysicalRecoveryStress(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	baseURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	admin, err := pgxpool.New(ctx, baseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	base, err := url.Parse(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	createDB := func() string {
		name := "t07_recovery_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
			cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
			_, e := admin.Exec(cleanup, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
			done()
			if e != nil {
				t.Error(e)
			}
		}
	})
	sourceURL, restoreURL := createDB(), createDB()
	source, err := postgres.Open(ctx, sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	user, session, team, project, token := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), secret.Random("dnst_")
	for _, v := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, secret.Hash(token)}},
		{`INSERT INTO teams(id,name) VALUES($1,'recovery')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'recovery','https://example.test/recovery')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = source.Pool.Exec(ctx, v.sql, v.args...); err != nil {
			t.Fatal(err)
		}
	}
	oldRaw, newRaw := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)), base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))
	oldJSON := fmt.Sprintf(`{"activeKeyId":"old","keys":{"old":%q}}`, oldRaw)
	bothJSON := fmt.Sprintf(`{"activeKeyId":"new","keys":{"old":%q,"new":%q}}`, oldRaw, newRaw)
	newJSON := fmt.Sprintf(`{"activeKeyId":"new","keys":{"new":%q}}`, newRaw)
	oldKeys, err := secretbox.Parse([]byte(oldJSON))
	if err != nil {
		t.Fatal(err)
	}
	bothKeys, err := secretbox.Parse([]byte(bothJSON))
	if err != nil {
		t.Fatal(err)
	}
	newKeys, err := secretbox.Parse([]byte(newJSON))
	if err != nil {
		t.Fatal(err)
	}
	keyDir := testStorageRoot(t)
	oldPath, newPath := filepath.Join(keyDir, "old.json"), filepath.Join(keyDir, "new.json")
	if err = os.WriteFile(oldPath, []byte(oldJSON), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(newPath, []byte(newJSON), 0600); err != nil {
		t.Fatal(err)
	}
	arrivals := make(chan []byte, 4)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, e := io.ReadAll(r.Body)
		if e != nil {
			t.Error(e)
		}
		arrivals <- data
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	c := configuredTestConfig()
	c.DatabaseURL = sourceURL
	c.StorageRoot = filepath.Join(keyDir, "source-storage")
	c.ShutdownTimeout = 5 * time.Second
	c.WebhookEnabled = true
	c.WebhookKeyringFile = oldPath
	f := &webhookApplicationFixture{t: t, cfg: c, user: user, token: token}
	t.Cleanup(f.stop)
	startRecoveryApplication(t, f, receiver.Certificate())
	create := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"name":"receiver","enabled":true,"destination":{"kind":"http","adapterVersion":"1","configuration":{"url":%q}},"subscriptions":[{"id":null,"projectId":%q,"eventTypes":["task.created"]}]}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), user, receiver.URL+"/hook", project)
	result := f.expect("POST", "/api/v1/me/webhooks", create, 201)
	var ep struct {
		Endpoint struct {
			ID string `json:"id"`
		} `json:"endpoint"`
	}
	if err = json.Unmarshal(result, &ep); err != nil || ep.Endpoint.ID == "" {
		t.Fatalf("endpoint: %s %v", result, err)
	}
	path := "/api/v1/projects/" + project + "/tasks"
	f.expect("POST", path, `{"title":"confirmed before backup"}`, 201)
	select {
	case <-arrivals:
	case <-time.After(5 * time.Second):
		t.Fatal("source TLS not received")
	}
	var confirmed string
	deadline := time.Now().Add(5 * time.Second)
	for {
		err = source.Pool.QueryRow(ctx, `SELECT id::text FROM webhook_deliveries WHERE state='delivered'`).Scan(&confirmed)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("source delivery did not confirm: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	confirmedBefore := readRecoveryFacts(t, ctx, source, confirmed, user, ep.Endpoint.ID, oldKeys)
	if confirmedBefore.Acknowledged == nil || confirmedBefore.Attempts != 1 || !strings.Contains(confirmedBefore.Target, receiver.URL+"/hook") {
		t.Fatal("source confirmation or target absent")
	}
	historyBefore := f.expect("GET", "/api/v1/me/webhooks/"+ep.Endpoint.ID+"/deliveries/"+confirmed, "", 200)
	f.stop()
	f.cfg.WebhookEnabled = false
	startRecoveryApplication(t, f, nil)
	f.expect("POST", path, `{"title":"pending before backup"}`, 201)
	var pending string
	if err = source.Pool.QueryRow(ctx, `SELECT id::text FROM webhook_deliveries WHERE state='pending'`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	pendingBefore := readRecoveryFacts(t, ctx, source, pending, user, ep.Endpoint.ID, oldKeys)
	f.stop()
	dump := exec.CommandContext(ctx, "docker", "run", "--rm", "--network", "host", "postgres:18.6", "pg_dump", "--format=custom", "--no-owner", "--no-acl", sourceURL)
	var dumpErr bytes.Buffer
	dump.Stderr = &dumpErr
	archive, err := dump.Output()
	if err != nil {
		t.Fatalf("pg_dump: %v %s", err, dumpErr.String())
	}
	restore := exec.CommandContext(ctx, "docker", "run", "--rm", "-i", "--network", "host", "postgres:18.6", "pg_restore", "--exit-on-error", "--no-owner", "--no-acl", "--dbname", restoreURL)
	restore.Stdin = bytes.NewReader(archive)
	if out, e := restore.CombinedOutput(); e != nil {
		t.Fatalf("pg_restore: %v %s", e, out)
	}
	restored, err := postgres.Open(ctx, restoreURL)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	f.cfg.DatabaseURL = restoreURL
	f.cfg.StorageRoot = filepath.Join(keyDir, "restored-storage")
	f.cfg.WebhookKeyringFile = newPath
	if app, e := service.OpenApp(ctx, f.cfg); !errors.Is(e, secretbox.ErrMissingKey) || app != nil {
		if app != nil {
			_ = app.Close(ctx)
		}
		t.Fatalf("restored database missing-key error: %v", e)
	}
	resultRewrap, err := (webhook.KeyMaintenance{DB: restored, Keys: bothKeys}).RewrapPass(ctx, "old", 500)
	if err != nil || resultRewrap.Rewrapped != 4 || resultRewrap.Conflicts != 0 {
		t.Fatalf("rewrap=%+v err=%v", resultRewrap, err)
	}
	if compared, e := webhook.VerifyKeyRecovery(ctx, source, restored, oldKeys, newKeys, "old"); e != nil || compared != 4 {
		t.Fatalf("verify restored ciphertexts=%d err=%v", compared, e)
	}
	confirmedAfter := readRecoveryFacts(t, ctx, restored, confirmed, user, ep.Endpoint.ID, newKeys)
	pendingAfter := readRecoveryFacts(t, ctx, restored, pending, user, ep.Endpoint.ID, newKeys)
	if !reflect.DeepEqual(confirmedBefore, confirmedAfter) || !reflect.DeepEqual(pendingBefore, pendingAfter) {
		t.Fatal("restored immutable facts or acknowledged history changed")
	}
	startRecoveryApplication(t, f, nil)
	historyAfter := f.expect("GET", "/api/v1/me/webhooks/"+ep.Endpoint.ID+"/deliveries/"+confirmed, "", 200)
	if !bytes.Equal(historyBefore, historyAfter) {
		t.Fatalf("confirmed history changed before=%s after=%s", historyBefore, historyAfter)
	}
	f.stop()
	f.cfg.WebhookEnabled = true
	startRecoveryApplication(t, f, receiver.Certificate())
	select {
	case body := <-arrivals:
		if !bytes.Equal(body, pendingBefore.Body) {
			t.Fatal("recovered delivery body changed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restored pending delivery not received")
	}
	deadline = time.Now().Add(5 * time.Second)
	for {
		var state string
		err = restored.Pool.QueryRow(ctx, `SELECT state FROM webhook_deliveries WHERE id=$1`, pending).Scan(&state)
		if err == nil && state == "delivered" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("restored finalize state=%s err=%v", state, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	f.stop()
	t.Logf("physical archive bytes=%d distinct_masters=true rewrapped=%d confirmed=%s pending=%s recovered_http=1 old_key_missing_failed=true", len(archive), resultRewrap.Rewrapped, confirmed, pending)
}
