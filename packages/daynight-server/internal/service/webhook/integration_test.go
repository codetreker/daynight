package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fixture struct {
	ctx context.Context
	db  *postgres.Store
	svc *Service
}

func newFixture(t *testing.T, singleConnection bool) *fixture {
	t.Helper()
	urlText := testutil.ScopedDatabaseURL(t)
	if singleConnection {
		u, err := url.Parse(urlText)
		if err != nil {
			t.Fatal(err)
		}
		q := u.Query()
		q.Set("pool_max_conns", "1")
		u.RawQuery = q.Encode()
		urlText = u.String()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	db, err := postgres.Open(ctx, urlText)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	keys := keyring(t, "old")
	return &fixture{ctx: ctx, db: db, svc: &Service{DB: db, Keys: keys}}
}

func keyring(t *testing.T, active string) *secretbox.Keyring {
	t.Helper()
	old := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	newKey := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))
	data := `{"activeKeyId":"` + active + `","keys":{"old":"` + old + `","new":"` + newKey + `"}}`
	keys, err := secretbox.Parse([]byte(data))
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

func (f *fixture) principal(t *testing.T) model.Principal {
	t.Helper()
	id, session := uuid.NewString(), uuid.NewString()
	hash := sha256.Sum256([]byte(session))
	_, err := f.db.Pool.Exec(f.ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,now(),now())`, id, id)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.Pool.Exec(f.ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,now(),now()+interval '1 day')`, session, id, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	return model.Principal{Kind: model.SessionCredential, UserID: id, CredentialID: session}
}

func mutation(p model.Principal, kind, endpoint string, version int64) Mutation {
	return Mutation{Kind: kind, EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: p.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64)}
}
func createMutation(p model.Principal, name, destination string) Mutation {
	m := mutation(p, "endpoint.create", "", 0)
	enabled := true
	m.Name = &name
	m.Enabled = &enabled
	m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: destination}
	m.HasSubscriptions = true
	return m
}
func body(t *testing.T, result Result) (map[string]any, map[string]any) {
	t.Helper()
	b, ok := result.Body.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result %T", result.Body)
	}
	op, ok := b["operation"].(map[string]any)
	if !ok {
		t.Fatalf("unexpected operation %T", b["operation"])
	}
	ep, ok := b["endpoint"].(map[string]any)
	if !ok {
		t.Fatalf("unexpected endpoint %T", b["endpoint"])
	}
	return op, ep
}
func expectFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}
func (f *fixture) ciphertext(t *testing.T, id string) ([]byte, []byte, time.Time) {
	t.Helper()
	var dest, key []byte
	var updated time.Time
	err := f.db.Pool.QueryRow(f.ctx, `SELECT e.destination_ciphertext,k.ciphertext,e.updated_at FROM webhook_endpoints e JOIN webhook_signing_keys k ON k.endpoint_id=e.id AND k.id=e.active_key_id WHERE e.id=$1`, id).Scan(&dest, &key, &updated)
	if err != nil {
		t.Fatal(err)
	}
	return dest, key, updated
}
func masterID(t *testing.T, b []byte) string {
	t.Helper()
	var envelope secretbox.Envelope
	if err := json.Unmarshal(b, &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.MasterKeyID
}

// A02/A05/A08/A09: actual PostgreSQL operation receipts, full int64 versions,
// current and old key rotation, and a one-connection replay after commit.
func TestPostgresPersonalLifecycleAndReplay(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	other := f.principal(t)
	owner := Owner{Kind: "user", ID: p.UserID}
	const target = "https://receiver.example/Secret?token=private"
	m := createMutation(p, "First", target)
	result, err := f.svc.Mutate(f.ctx, p, owner, m)
	if err != nil {
		t.Fatalf("creation: %v; cause: %v; root: %v; underlying: %v", err, errors.Unwrap(err), errors.Unwrap(errors.Unwrap(err)), errors.Unwrap(errors.Unwrap(errors.Unwrap(err))))
	}
	op, ep := body(t, result)
	id := ep["id"].(string)
	if result.Replay || ep["configVersion"] != "1" || ep["destinationRevision"] != "1" || op["requestSha256"] != m.RequestSHA256 {
		t.Fatalf("creation: %#v", result)
	}
	if _, err := f.svc.Get(f.ctx, other, owner, id); err == nil {
		t.Fatal("other user accessed personal owner")
	}
	secretAny, err := f.svc.Secret(f.ctx, p, owner, id)
	if err != nil {
		t.Fatal(err)
	}
	secret := secretAny.(map[string]any)["secret"].(string)
	if !strings.HasPrefix(secret, "whsec_") {
		t.Fatal("wrong secret format")
	}
	oldDest, oldKey, oldUpdated := f.ciphertext(t, id)
	if masterID(t, oldDest) != "old" || masterID(t, oldKey) != "old" {
		t.Fatal("initial master mismatch")
	}
	m.RequestSHA256 = strings.Repeat("b", 64)
	replay, err := f.svc.Mutate(f.ctx, p, owner, m)
	if err != nil {
		t.Fatal(err)
	}
	op, ep = body(t, replay)
	if !replay.Replay || ep["id"] != id || op["requestSha256"] != strings.Repeat("a", 64) {
		t.Fatalf("replay lost original receipt: %#v", replay)
	}
	f.svc.Keys = keyring(t, "new")
	changed := mutation(p, "endpoint.update", id, 1)
	name := "Renamed"
	changed.Name = &name
	res, err := f.svc.Mutate(f.ctx, p, owner, changed)
	if err != nil {
		t.Fatal(err)
	}
	_, ep = body(t, res)
	if ep["configVersion"] != "2" || ep["destinationRevision"] != "1" {
		t.Fatalf("name update: %#v", ep)
	}
	newDest, newKey, _ := f.ciphertext(t, id)
	if masterID(t, newDest) != "new" || masterID(t, newKey) != "new" || bytes.Equal(oldDest, newDest) || bytes.Equal(oldKey, newKey) {
		t.Fatal("changed configuration did not rewrap both ciphertexts")
	}
	newSecret, err := f.svc.Secret(f.ctx, p, owner, id)
	if err != nil || newSecret.(map[string]any)["secret"] != secret {
		t.Fatalf("rewrap changed secret: %v", err)
	}
	noop := mutation(p, "endpoint.update", id, 2)
	noop.Name = &name
	_, _, beforeNoop := f.ciphertext(t, id)
	res, err = f.svc.Mutate(f.ctx, p, owner, noop)
	if err != nil {
		t.Fatal(err)
	}
	op, ep = body(t, res)
	if op["effect"] != "unchanged" || ep["configVersion"] != "2" {
		t.Fatalf("no-op: %#v", res)
	}
	noDest, noKey, noUpdated := f.ciphertext(t, id)
	if !bytes.Equal(newDest, noDest) || !bytes.Equal(newKey, noKey) || !noUpdated.Equal(beforeNoop) || oldUpdated.After(beforeNoop) {
		t.Fatal("no-op changed ciphertext or timestamp")
	}
	stale := mutation(p, "endpoint.update", id, 1)
	stale.Name = &name
	_, err = f.svc.Mutate(f.ctx, p, owner, stale)
	expectFault(t, err, "version_conflict")
	rot := mutation(p, "signing.rotate", id, 2)
	rot.Mode = "overlap"
	rotation, err := f.svc.Mutate(f.ctx, p, owner, rot)
	if err != nil {
		t.Fatal(err)
	}
	rb := rotation.Body.(map[string]any)
	originalSigning := rb["signing"].(map[string]any)
	if originalSigning["activeKeyId"] == nil || originalSigning["overlapUntil"] == nil {
		t.Fatalf("rotation: %#v", rotation)
	}
	second := mutation(p, "signing.rotate", id, 3)
	second.Mode = "overlap"
	_, err = f.svc.Mutate(f.ctx, p, owner, second)
	if err == nil {
		t.Fatal("second overlap accepted")
	}
	immediate := mutation(p, "signing.rotate", id, 3)
	immediate.Mode = "immediate"
	if _, err = f.svc.Mutate(f.ctx, p, owner, immediate); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_signing_keys WHERE endpoint_id=$1`, id).Scan(&count); err != nil || count != 1 {
		t.Fatalf("live key count %d, %v", count, err)
	}
	again, err := f.svc.Mutate(f.ctx, p, owner, rot)
	if err != nil {
		t.Fatal(err)
	}
	againSigning := again.Body.(map[string]any)["signing"].(map[string]any)
	if !again.Replay || againSigning["activeKeyId"] != originalSigning["activeKeyId"] || !againSigning["overlapUntil"].(*time.Time).Equal(*originalSigning["overlapUntil"].(*time.Time)) {
		t.Fatal("rotation replay did not preserve original result")
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_endpoints SET config_version=9007199254740993 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	del := mutation(p, "endpoint.delete", id, 9007199254740993)
	res, err = f.svc.Mutate(f.ctx, p, owner, del)
	if err != nil {
		t.Fatal(err)
	}
	_, ep = body(t, res)
	if ep["lifecycle"] != "deleted" || ep["configVersion"] != "9007199254740994" || len(ep) != 5 {
		t.Fatalf("tombstone: %#v", ep)
	}
	if _, err := f.svc.Secret(f.ctx, p, owner, id); err == nil {
		t.Fatal("deleted secret remained accessible")
	}
}

// A01/A06: live membership and authority determine the projection on replay.
func TestPostgresTeamDemotionAndMemberVisibility(t *testing.T) {
	f := newFixture(t, true)
	admin := f.principal(t)
	replacement := f.principal(t)
	member := f.principal(t)
	outsider := f.principal(t)
	team := uuid.NewString()
	owner := Owner{Kind: "team", ID: team}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams (id,name) VALUES ($1,'Team')`, team); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		p    model.Principal
		role string
	}{{admin, "admin"}, {replacement, "admin"}, {member, "member"}} {
		if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,$3)`, team, row.p.UserID, row.role); err != nil {
			t.Fatal(err)
		}
	}
	m := createMutation(admin, "Team endpoint", "https://receiver.example/old-private")
	created, err := f.svc.Mutate(f.ctx, admin, owner, m)
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	id := ep["id"].(string)
	if _, err := f.svc.Secret(f.ctx, member, owner, id); err == nil {
		t.Fatal("member read signing secret")
	}
	if _, err := f.svc.Get(f.ctx, outsider, owner, id); err == nil {
		t.Fatal("outsider read endpoint")
	}
	bad := createMutation(member, "Denied", "https://receiver.example/path")
	if _, err := f.svc.Mutate(f.ctx, member, owner, bad); err == nil {
		t.Fatal("member created endpoint")
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, team, admin.UserID); err != nil {
		t.Fatal(err)
	}
	update := mutation(replacement, "endpoint.update", id, 1)
	update.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/new-private?secret=x"}
	if _, err := f.svc.Mutate(f.ctx, replacement, owner, update); err != nil {
		t.Fatal(err)
	}
	replay, err := f.svc.Mutate(f.ctx, admin, owner, m)
	if err != nil {
		t.Fatal(err)
	}
	_, ep = body(t, replay)
	dest := ep["destination"].(map[string]any)
	if !replay.Replay || dest["url"] != nil || strings.Contains(dest["displayUrl"].(string), "private") {
		t.Fatalf("demoted replay exposed current URL: %#v", dest)
	}
	if _, err := f.svc.Secret(f.ctx, admin, owner, id); err == nil {
		t.Fatal("demoted admin read secret")
	}
	list, err := f.svc.List(f.ctx, member, owner, ListQuery{Query: "new-private", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if items := list.(map[string]any)["items"].([]any); len(items) != 0 {
		t.Fatal("member search leaked hidden path")
	}
	var endpoints, receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1)`, team).Scan(&endpoints, &receipts); err != nil || endpoints != 1 || receipts != 2 {
		t.Fatalf("unauthorized write persisted: endpoints=%d receipts=%d err=%v", endpoints, receipts, err)
	}
}

// A09: missing keys, failed entropy and tampered ciphertext leave no new
// effect or receipt; deletion does not require decrypting damaged content.
func TestPostgresCryptoFailuresRollback(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "user", ID: p.UserID}
	created, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "initial", "https://receiver.example/path"))
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	id := ep["id"].(string)
	dest, key, updated := f.ciphertext(t, id)
	f.svc.Keys = nil
	if _, err := f.svc.Get(f.ctx, p, owner, id); !errors.Is(err, secretbox.ErrMissingKey) {
		t.Fatalf("nil keyring read: %v", err)
	}
	if _, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "unavailable", "https://example.test/")); !errors.Is(err, secretbox.ErrMissingKey) {
		t.Fatalf("nil keyring write: %v", err)
	}
	name := "changed"
	change := mutation(p, "endpoint.update", id, 1)
	change.Name = &name
	newKey := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))
	missing, err := secretbox.Parse([]byte(`{"activeKeyId":"new","keys":{"new":"` + newKey + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	f.svc.Keys = missing
	_, err = f.svc.Mutate(f.ctx, p, owner, change)
	if !errors.Is(err, secretbox.ErrMissingKey) {
		t.Fatalf("missing master cause: %v", err)
	}
	f.svc.Keys = keyring(t, "new")
	f.svc.Random = bytes.NewReader(nil)
	change.OperationID = uuid.NewString()
	_, err = f.svc.Mutate(f.ctx, p, owner, change)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("failed entropy cause: %v", err)
	}
	f.svc.Random = nil
	afterDest, afterKey, afterUpdated := f.ciphertext(t, id)
	var receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_operations WHERE owner_id=$1`, p.UserID).Scan(&receipts); err != nil || receipts != 1 || !bytes.Equal(dest, afterDest) || !bytes.Equal(key, afterKey) || !updated.Equal(afterUpdated) {
		t.Fatalf("failure left effects: receipts=%d err=%v", receipts, err)
	}
	var envelope secretbox.Envelope
	if err := json.Unmarshal(dest, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Ciphertext[0] ^= 1
	corrupt, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_endpoints SET destination_ciphertext=$2 WHERE id=$1`, id, corrupt); err != nil {
		t.Fatal(err)
	}
	change.OperationID = uuid.NewString()
	_, err = f.svc.Mutate(f.ctx, p, owner, change)
	if !errors.Is(err, secretbox.ErrAuthentication) {
		t.Fatalf("tampered ciphertext cause: %v", err)
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_operations WHERE owner_id=$1`, p.UserID).Scan(&receipts); err != nil || receipts != 1 {
		t.Fatalf("tamper left receipt: %d %v", receipts, err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_endpoints SET destination_ciphertext=$2 WHERE id=$1`, id, []byte("{")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Get(f.ctx, p, owner, id); err == nil {
		t.Fatal("malformed envelope was accepted")
	}
	deleteRequest := mutation(p, "endpoint.delete", id, 1)
	if _, err := f.svc.Mutate(f.ctx, p, owner, deleteRequest); err != nil {
		t.Fatalf("delete damaged state: %v", err)
	}
}

// A07: credential revocation applies to new writes and to receipt projections.
func TestPostgresCredentialRevocationPreventsWritesAndReplay(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "user", ID: p.UserID}
	original := createMutation(p, "initial", "https://receiver.example/path")
	if _, err := f.svc.Mutate(f.ctx, p, owner, original); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `DELETE FROM sessions WHERE id=$1`, p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Mutate(f.ctx, p, owner, original); err == nil {
		t.Fatal("revoked credential replayed an operation")
	}
	if _, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "second", "https://example.test/")); err == nil {
		t.Fatal("revoked credential created an endpoint")
	}
	var endpoints, receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1)`, p.UserID).Scan(&endpoints, &receipts); err != nil || endpoints != 1 || receipts != 1 {
		t.Fatalf("revocation changed persisted facts: endpoints=%d receipts=%d err=%v", endpoints, receipts, err)
	}
}

type mutationOutcome struct {
	result Result
	err    error
}

func (f *fixture) auxiliaryPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(f.db.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 5
	pool, err := pgxpool.NewWithConfig(f.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func waitBlocked(t *testing.T, ctx context.Context, pool *pgxpool.Pool, blocker int32) {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			t.Logf("observed PostgreSQL waiter blocked by backend %d", blocker)
			return
		}
		select {
		case <-deadline.C:
			t.Fatal("PostgreSQL waiter was not observed")
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-tick.C:
		}
	}
}

func waitOutcome(t *testing.T, ctx context.Context, result <-chan mutationOutcome) mutationOutcome {
	t.Helper()
	select {
	case v := <-result:
		return v
	case <-time.After(5 * time.Second):
		t.Fatal("mutation did not finish after lock release")
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	return mutationOutcome{}
}

func (f *fixture) quotaFacts(t *testing.T, owner Owner) string {
	t.Helper()
	var facts string
	err := f.db.Pool.QueryRow(f.ctx, `SELECT row_to_json(o)::text || row_to_json(b)::text FROM webhook_quota_owners o JOIN webhook_quota_buckets b USING(bucket) WHERE owner_kind=$1 AND owner_id=$2`, owner.Kind, owner.ID).Scan(&facts)
	if err != nil {
		t.Fatal(err)
	}
	return facts
}

// A06: force the replay to wait at its actual PostgreSQL operation fence after
// its initial admin observation. Another connection demotes the actor and
// updates the URL before the fence is released. The tested service pool has one
// connection, so a nested read snapshot would deadlock.
func TestPostgresReplayAfterDemotionAndURLChangeWhileFenced(t *testing.T) {
	f := newFixture(t, true)
	admin, replacement := f.principal(t), f.principal(t)
	team := uuid.NewString()
	owner := Owner{Kind: "team", ID: team}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams(id,name) VALUES($1,'shared')`, team); err != nil {
		t.Fatal(err)
	}
	for _, user := range []string{admin.UserID, replacement.UserID} {
		if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team, user); err != nil {
			t.Fatal(err)
		}
	}
	original := createMutation(admin, "endpoint", "https://receiver.example/original-secret")
	created, err := f.svc.Mutate(f.ctx, admin, owner, original)
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	id := ep["id"].(string)
	aux := f.auxiliaryPool(t)
	lock, err := aux.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(f.ctx)
	var blocker int32
	if err := lock.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("daynight-webhook-operation\x00" + owner.Kind + "\x00" + owner.ID + "\x00" + original.OperationID))
	if _, err := lock.Exec(f.ctx, `SELECT pg_advisory_xact_lock($1)`, int64(binary.BigEndian.Uint64(sum[:8]))); err != nil {
		t.Fatal(err)
	}
	out := make(chan mutationOutcome, 1)
	go func() {
		result, err := f.svc.Mutate(f.ctx, admin, owner, original)
		out <- mutationOutcome{result, err}
	}()
	waitBlocked(t, f.ctx, aux, blocker)
	if _, err := aux.Exec(f.ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, team, admin.UserID); err != nil {
		t.Fatal(err)
	}
	second := &Service{DB: &postgres.Store{Pool: aux}, Keys: f.svc.Keys}
	update := mutation(replacement, "endpoint.update", id, 1)
	update.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/new-secret?key=private"}
	if _, err := second.Mutate(f.ctx, replacement, owner, update); err != nil {
		t.Fatal(err)
	}
	if err := lock.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	finished := waitOutcome(t, f.ctx, out)
	if finished.err != nil {
		t.Fatal(finished.err)
	}
	_, ep = body(t, finished.result)
	destination := ep["destination"].(map[string]any)
	if !finished.result.Replay || destination["url"] != nil || strings.Contains(fmt.Sprint(destination["displayUrl"]), "secret") {
		t.Fatalf("replay disclosed URL: %#v", destination)
	}
}

// A07: an endpoint row lock makes the write wait after its first authorization
// and time check. Revoke its session or let its original issuedAt expire before
// releasing the lock; no reservation, receipt or endpoint effect may survive.
func TestPostgresWaitingWriteRevocationAndExpiry(t *testing.T) {
	for _, scenario := range []string{"revoked", "expired"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, true)
			p := f.principal(t)
			owner := Owner{Kind: "user", ID: p.UserID}
			created, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "original", "https://receiver.example/path"))
			if err != nil {
				t.Fatal(err)
			}
			_, ep := body(t, created)
			id := ep["id"].(string)
			before := f.quotaFacts(t, owner)
			dest, key, updated := f.ciphertext(t, id)
			aux := f.auxiliaryPool(t)
			lock, err := aux.Begin(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Rollback(f.ctx)
			var blocker int32
			if err := lock.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
				t.Fatal(err)
			}
			var locked string
			if err := lock.QueryRow(f.ctx, `SELECT id::text FROM webhook_endpoints WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
				t.Fatal(err)
			}
			change := mutation(p, "endpoint.update", id, 1)
			name := "should not apply"
			change.Name = &name
			if scenario == "expired" {
				change.IssuedAt = time.Now().UTC().Add(-299 * time.Second).Format(time.RFC3339Nano)
			}
			out := make(chan mutationOutcome, 1)
			go func() { result, err := f.svc.Mutate(f.ctx, p, owner, change); out <- mutationOutcome{result, err} }()
			waitBlocked(t, f.ctx, aux, blocker)
			if scenario == "revoked" {
				if _, err := aux.Exec(f.ctx, `DELETE FROM sessions WHERE id=$1`, p.CredentialID); err != nil {
					t.Fatal(err)
				}
			} else {
				deadline, err := time.Parse(time.RFC3339Nano, change.IssuedAt)
				if err != nil {
					t.Fatal(err)
				}
				if remaining := time.Until(deadline.Add(301 * time.Second)); remaining > 0 {
					time.Sleep(remaining)
				}
			}
			if err := lock.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
			finished := waitOutcome(t, f.ctx, out)
			if scenario == "expired" {
				expectFault(t, finished.err, "operation_expired")
			} else {
				expectFault(t, finished.err, "unauthenticated")
			}
			afterDest, afterKey, afterUpdated := f.ciphertext(t, id)
			var receipts int
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2`, owner.Kind, owner.ID).Scan(&receipts); err != nil {
				t.Fatal(err)
			}
			if receipts != 1 || before != f.quotaFacts(t, owner) || !bytes.Equal(dest, afterDest) || !bytes.Equal(key, afterKey) || !updated.Equal(afterUpdated) {
				t.Fatalf("waiting %s operation left effect or charge", scenario)
			}
		})
	}
}

// Read paths must bind pagination and operation receipts to the current actor,
// owner and filters, including after a Team role changes.
func TestPostgresReadsAndCursorAuthorization(t *testing.T) {
	f := newFixture(t, true)
	admin, member, outsider := f.principal(t), f.principal(t), f.principal(t)
	team := uuid.NewString()
	owner := Owner{Kind: "team", ID: team}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams(id,name) VALUES($1,'shared')`, team); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		p    model.Principal
		role string
	}{{admin, "admin"}, {member, "member"}} {
		if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,$3)`, team, row.p.UserID, row.role); err != nil {
			t.Fatal(err)
		}
	}
	first := createMutation(admin, "alpha", "https://receiver.example/secret-alpha")
	created, err := f.svc.Mutate(f.ctx, admin, owner, first)
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	endpoint := ep["id"].(string)
	for _, name := range []string{"beta", "gamma"} {
		if _, err := f.svc.Mutate(f.ctx, admin, owner, createMutation(admin, name, "https://receiver.example/hidden-"+name)); err != nil {
			t.Fatal(err)
		}
	}
	firstPageAny, err := f.svc.List(f.ctx, admin, owner, ListQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	firstPage := firstPageAny.(map[string]any)
	if len(firstPage["items"].([]any)) != 1 || firstPage["nextCursor"] == nil {
		t.Fatalf("first page: %#v", firstPage)
	}
	cursor := firstPage["nextCursor"].(string)
	secondPageAny, err := f.svc.List(f.ctx, admin, owner, ListQuery{Limit: 1, Cursor: &cursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(secondPageAny.(map[string]any)["items"].([]any)) != 1 {
		t.Fatal("continuation did not return next item")
	}
	if _, err := f.svc.List(f.ctx, member, owner, ListQuery{Limit: 1, Cursor: &cursor}); err == nil {
		t.Fatal("cursor shared between actors")
	}
	if _, err := f.svc.List(f.ctx, admin, owner, ListQuery{Limit: 1, Cursor: &cursor, Query: "changed"}); err == nil {
		t.Fatal("cursor shared across filters")
	}
	invalidCursor := "%%%"
	if _, err := f.svc.List(f.ctx, admin, owner, ListQuery{Cursor: &invalidCursor}); err == nil {
		t.Fatal("invalid cursor accepted")
	}
	if _, err := f.svc.List(f.ctx, outsider, owner, ListQuery{}); err == nil {
		t.Fatal("outsider listed Team")
	}
	op, err := f.svc.Operation(f.ctx, admin, owner, first.OperationID)
	if err != nil || op.(map[string]any)["operationId"] != first.OperationID {
		t.Fatalf("admin receipt: %v", err)
	}
	if _, err := f.svc.Operation(f.ctx, member, owner, first.OperationID); err == nil {
		t.Fatal("member read another actor's receipt")
	}
	if _, err := f.svc.Operation(f.ctx, admin, owner, uuid.NewString()); err == nil {
		t.Fatal("missing receipt succeeded")
	}
	if _, err := f.svc.Get(f.ctx, admin, owner, uuid.NewString()); err == nil {
		t.Fatal("missing endpoint succeeded")
	}
	if _, err := f.svc.Secret(f.ctx, admin, owner, uuid.NewString()); err == nil {
		t.Fatal("missing secret succeeded")
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, team, admin.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Operation(f.ctx, admin, owner, first.OperationID); err != nil {
		t.Fatalf("own receipt after demotion: %v", err)
	}
	view, err := f.svc.Get(f.ctx, admin, owner, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if view.(map[string]any)["destination"].(map[string]any)["url"] != nil {
		t.Fatal("demoted actor saw URL")
	}
}

// Capacity refusals and oversized metadata happen within a real transaction,
// leaving existing endpoint, account and receipt facts unchanged.
func TestPostgresCapacityAndOversizedMetadataRollback(t *testing.T) {
	for _, scenario := range []string{"operation", "configuration", "metadata"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, true)
			p := f.principal(t)
			owner := Owner{Kind: "user", ID: p.UserID}
			if _, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "first", "https://receiver.example/path")); err != nil {
				t.Fatal(err)
			}
			var err error
			switch scenario {
			case "operation":
				_, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_quota_owners SET operations=1024 WHERE owner_kind='user' AND owner_id=$1`, p.UserID)
			case "configuration":
				_, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_quota_owners SET records=32768 WHERE owner_kind='user' AND owner_id=$1`, p.UserID)
			}
			if err != nil {
				t.Fatal(err)
			}
			before := f.quotaFacts(t, owner)
			url := "https://receiver.example/path"
			if scenario == "metadata" {
				url = "https://" + strings.Repeat("a", 2100) + ".example/path"
			}
			_, err = f.svc.Mutate(f.ctx, p, owner, createMutation(p, "second", url))
			want := map[string]string{"operation": "operation_capacity", "configuration": "webhook_capacity_unavailable", "metadata": "invalid_input"}[scenario]
			expectFault(t, err, want)
			var endpoints, receipts int
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1)`, p.UserID).Scan(&endpoints, &receipts); err != nil || endpoints != 1 || receipts != 1 || before != f.quotaFacts(t, owner) {
				t.Fatalf("%s left effect: endpoints=%d receipts=%d err=%v", scenario, endpoints, receipts, err)
			}
		})
	}
}

// A new intent must recheck management authority after the operation fence and
// reject a demoted actor before exposing the operation's expiry outcome.
func TestPostgresNewIntentDemotionPrecedesExpiryAfterFence(t *testing.T) {
	f := newFixture(t, true)
	admin := f.principal(t)
	team := uuid.NewString()
	owner := Owner{Kind: "team", ID: team}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams(id,name) VALUES($1,'shared')`, team); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team, admin.UserID); err != nil {
		t.Fatal(err)
	}
	m := createMutation(admin, "expired", "https://receiver.example/path")
	m.IssuedAt = time.Now().UTC().Add(-299 * time.Second).Format(time.RFC3339Nano)
	aux := f.auxiliaryPool(t)
	lock, err := aux.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(f.ctx)
	var blocker int32
	if err := lock.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("daynight-webhook-operation\x00" + owner.Kind + "\x00" + owner.ID + "\x00" + m.OperationID))
	if _, err := lock.Exec(f.ctx, `SELECT pg_advisory_xact_lock($1)`, int64(binary.BigEndian.Uint64(sum[:8]))); err != nil {
		t.Fatal(err)
	}
	out := make(chan mutationOutcome, 1)
	go func() { result, err := f.svc.Mutate(f.ctx, admin, owner, m); out <- mutationOutcome{result, err} }()
	waitBlocked(t, f.ctx, aux, blocker)
	if _, err := aux.Exec(f.ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, team, admin.UserID); err != nil {
		t.Fatal(err)
	}
	issued, err := time.Parse(time.RFC3339Nano, m.IssuedAt)
	if err != nil {
		t.Fatal(err)
	}
	if remaining := time.Until(issued.Add(301 * time.Second)); remaining > 0 {
		time.Sleep(remaining)
	}
	if err := lock.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	finished := waitOutcome(t, f.ctx, out)
	expectFault(t, finished.err, "forbidden")
	var endpoints, receipts, accounts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1),(SELECT count(*) FROM webhook_quota_owners WHERE owner_id=$1)`, team).Scan(&endpoints, &receipts, &accounts); err != nil || endpoints != 0 || receipts != 0 || accounts != 0 {
		t.Fatalf("demoted intent left effect: endpoints=%d receipts=%d accounts=%d err=%v", endpoints, receipts, accounts, err)
	}
}

// Invalid intents, bad owner scopes and unusable randomness must fail before
// any receipt or quota account can be persisted.
func TestPostgresRejectsInvalidIntentsAndOwners(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "user", ID: p.UserID}
	base := createMutation(p, "valid", "https://receiver.example/path")
	cases := []struct {
		name, code string
		change     func(*Mutation)
	}{
		{"invalid operation ID", "invalid_input", func(m *Mutation) { m.OperationID = "not-a-uuid" }},
		{"invalid actor", "invalid_input", func(m *Mutation) { m.ExpectedUserID = "not-a-uuid" }},
		{"invalid timestamp", "invalid_input", func(m *Mutation) { m.IssuedAt = "invalid" }},
		{"identity mismatch", "identity_mismatch", func(m *Mutation) { m.ExpectedUserID = uuid.NewString() }},
		{"bad endpoint", "invalid_input", func(m *Mutation) { m.Kind = "endpoint.update"; m.EndpointID = "bad"; m.IfVersion = 1 }},
		{"bad version", "invalid_input", func(m *Mutation) { m.Kind = "endpoint.update"; m.EndpointID = uuid.NewString(); m.IfVersion = 0 }},
		{"invalid name", "invalid_input", func(m *Mutation) { n := " "; m.Name = &n }},
		{"unsupported destination", "destination_unsupported", func(m *Mutation) {
			m.Destination = &Destination{Kind: "other", AdapterVersion: "1", URL: "https://example.test/"}
		}},
		{"invalid destination URL", "invalid_input", func(m *Mutation) {
			m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "http://example.test/"}
		}},
		{"future operation", "invalid_operation_time", func(m *Mutation) { m.IssuedAt = time.Now().Add(2 * time.Minute).UTC().Format(time.RFC3339Nano) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := base
			tc.change(&m)
			_, err := f.svc.Mutate(f.ctx, p, owner, m)
			expectFault(t, err, tc.code)
		})
	}
	if _, err := f.svc.Get(f.ctx, model.Principal{}, owner, uuid.NewString()); err == nil {
		t.Fatal("invalid principal read")
	}
	if _, err := f.svc.Get(f.ctx, p, Owner{Kind: "unknown", ID: p.UserID}, uuid.NewString()); err == nil {
		t.Fatal("unknown owner accepted")
	}
	personal := uuid.NewString()
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, personal, p.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, personal, p.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Get(f.ctx, p, Owner{Kind: "team", ID: personal}, uuid.NewString()); err == nil {
		t.Fatal("personal Team accepted as shared owner")
	}
	f.svc.Random = bytes.NewReader(nil)
	if _, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "valid", "https://receiver.example/")); !errors.Is(err, io.EOF) {
		t.Fatalf("random ID failure: %v", err)
	}
	var endpoints, receipts, accounts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations),(SELECT count(*) FROM webhook_quota_owners)`).Scan(&endpoints, &receipts, &accounts); err != nil || endpoints != 0 || receipts != 0 || accounts != 0 {
		t.Fatalf("refusal left effects: endpoints=%d receipts=%d accounts=%d err=%v", endpoints, receipts, accounts, err)
	}
}

// Counters never wrap, and a failed advancement preserves the prior state.
func TestPostgresVersionExhaustionRollsBack(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "user", ID: p.UserID}
	created, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "original", "https://receiver.example/path"))
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	id := ep["id"].(string)
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_endpoints SET config_version=9223372036854775807 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	before := f.quotaFacts(t, owner)
	change := mutation(p, "endpoint.update", id, math.MaxInt64)
	name := "changed"
	change.Name = &name
	_, err = f.svc.Mutate(f.ctx, p, owner, change)
	expectFault(t, err, "version_exhausted")
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_endpoints SET config_version=1,destination_revision=9223372036854775807 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	change = mutation(p, "endpoint.update", id, 1)
	change.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/changed"}
	// The old destination's AAD must match the database revision for the test
	// to reach version overflow, so re-encrypt it against that revision.
	var ciphertext []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT destination_ciphertext FROM webhook_endpoints WHERE id=$1`, id).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	plain, err := f.svc.decrypt(ciphertext, []string{owner.Kind, owner.ID, id, "endpoint-current", "1"})
	if err != nil {
		t.Fatal(err)
	}
	rebound, err := f.svc.encrypt(plain, []string{owner.Kind, owner.ID, id, "endpoint-current", "9223372036854775807"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_endpoints SET destination_ciphertext=$2 WHERE id=$1`, id, rebound); err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.Mutate(f.ctx, p, owner, change)
	expectFault(t, err, "version_exhausted")
	var receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_operations WHERE owner_id=$1`, p.UserID).Scan(&receipts); err != nil || receipts != 1 || before != f.quotaFacts(t, owner) {
		t.Fatalf("version exhaustion left effects: receipts=%d err=%v", receipts, err)
	}
}

func TestFailureClassificationPreservesCauses(t *testing.T) {
	cause := errors.New("database failure")
	if !errors.Is(notFound(cause), cause) || !errors.Is(capacityError(cause), cause) {
		t.Fatal("unexpected failure was masked")
	}
	if err := checkTime("invalid", time.Now()); err == nil {
		t.Fatal("invalid timestamp accepted")
	}
}

// A rotation waiting for quota must start its 24-hour overlap at the fresh DB
// observation after that wait, not at an earlier pre-lock observation.
func TestPostgresRotationOverlapStartsAfterCapacityWait(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "user", ID: p.UserID}
	created, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "original", "https://receiver.example/path"))
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	id := ep["id"].(string)
	aux := f.auxiliaryPool(t)
	lock, err := aux.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(f.ctx)
	var blocker int32
	if err := lock.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	var bucket int16
	if err := lock.QueryRow(f.ctx, `SELECT bucket FROM webhook_quota_owners WHERE owner_kind='user' AND owner_id=$1`, p.UserID).Scan(&bucket); err != nil {
		t.Fatal(err)
	}
	if _, err := lock.Exec(f.ctx, `SELECT bucket FROM webhook_quota_buckets WHERE bucket=$1 FOR UPDATE`, bucket); err != nil {
		t.Fatal(err)
	}
	rotation := mutation(p, "signing.rotate", id, 1)
	rotation.Mode = "overlap"
	out := make(chan mutationOutcome, 1)
	go func() { result, err := f.svc.Mutate(f.ctx, p, owner, rotation); out <- mutationOutcome{result, err} }()
	waitBlocked(t, f.ctx, aux, blocker)
	var before time.Time
	if err := lock.QueryRow(f.ctx, `SELECT clock_timestamp()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := lock.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	finished := waitOutcome(t, f.ctx, out)
	if finished.err != nil {
		t.Fatal(finished.err)
	}
	var after time.Time
	if err := aux.QueryRow(f.ctx, `SELECT clock_timestamp()`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	signing := finished.result.Body.(map[string]any)["signing"].(map[string]any)
	until, ok := signing["overlapUntil"].(*time.Time)
	if !ok || until == nil {
		t.Fatalf("missing overlap: %#v", signing)
	}
	if until.Before(before.Add(24*time.Hour)) || until.After(after.Add(24*time.Hour)) {
		t.Fatalf("overlap %s did not start after lock release observation %s to %s", until, before, after)
	}
}
