package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
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
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
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
	return &fixture{ctx: ctx, db: db, svc: &Service{DB: db, ConfigurationExpansionAvailable: true}}
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
func (f *fixture) configuration(t *testing.T, id string) ([]byte, []byte, time.Time) {
	t.Helper()
	var destination, secret []byte
	var updated time.Time
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT e.destination_configuration,k.secret,e.updated_at FROM webhook_endpoints e JOIN webhook_signing_keys k ON k.endpoint_id=e.id AND k.id=e.active_key_id WHERE e.id=$1`, id).Scan(&destination, &secret, &updated); err != nil {
		t.Fatal(err)
	}
	return destination, secret, updated
}

// A02/A05/A08/A09: actual PostgreSQL operation receipts, full int64 versions,
// current and old key rotation, and a one-connection replay after commit.
func TestPostgresPersonalLifecycleAndReplay(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	other := f.principal(t)
	owner := Owner{Kind: "personal", ID: p.UserID}
	const target = "https://receiver.example/Secret?token=private"
	m := createMutation(p, "First", target)
	result, err := f.svc.Mutate(f.ctx, p, owner, m)
	if err != nil {
		t.Fatalf("creation: %v; cause: %v; root: %v; underlying: %v", err, errors.Unwrap(err), errors.Unwrap(errors.Unwrap(err)), errors.Unwrap(errors.Unwrap(errors.Unwrap(err))))
	}
	op, ep := body(t, result)
	id := ep["id"].(string)
	if op["overlapUntil"] != (*time.Time)(nil) {
		t.Fatalf("create receipt has rotation deadline: %#v", op)
	}
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
	oldDest, oldKey, oldUpdated := f.configuration(t, id)
	if secret != "whsec_"+base64.StdEncoding.EncodeToString(oldKey) {
		t.Fatal("secret response differs from stored signing key")
	}
	if destination, err := decodeDestination(oldDest); err != nil || destination.URL != target || len(oldKey) != 32 {
		t.Fatalf("stored configuration mismatch: %v", err)
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
	newDest, newKey, _ := f.configuration(t, id)
	if !bytes.Equal(oldDest, newDest) || !bytes.Equal(oldKey, newKey) {
		t.Fatal("name update changed destination or signing secret")
	}
	newSecret, err := f.svc.Secret(f.ctx, p, owner, id)
	if err != nil || newSecret.(map[string]any)["secret"] != secret {
		t.Fatalf("name update changed secret: %v", err)
	}
	noop := mutation(p, "endpoint.update", id, 2)
	noop.Name = &name
	_, _, beforeNoop := f.configuration(t, id)
	res, err = f.svc.Mutate(f.ctx, p, owner, noop)
	if err != nil {
		t.Fatal(err)
	}
	op, ep = body(t, res)
	if op["effect"] != "unchanged" || ep["configVersion"] != "2" {
		t.Fatalf("no-op: %#v", res)
	}
	noDest, noKey, noUpdated := f.configuration(t, id)
	if !bytes.Equal(newDest, noDest) || !bytes.Equal(newKey, noKey) || !noUpdated.Equal(beforeNoop) || oldUpdated.After(beforeNoop) {
		t.Fatal("no-op changed stored bytes or timestamp")
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
	rotationDest, rotationKey, _ := f.configuration(t, id)
	var overlapSecret []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT secret FROM webhook_signing_keys WHERE endpoint_id=$1 AND slot='overlap'`, id).Scan(&overlapSecret); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(rotationDest, oldDest) || bytes.Equal(rotationKey, oldKey) || !bytes.Equal(overlapSecret, oldKey) {
		t.Fatal("rotation changed target or failed to preserve overlap secret")
	}
	rb := rotation.Body.(map[string]any)
	originalSigning := rb["signing"].(map[string]any)
	originalOperation := rb["operation"].(map[string]any)
	if originalSigning["activeKeyId"] == nil || originalSigning["overlapUntil"] == nil || !originalOperation["overlapUntil"].(*time.Time).Equal(*originalSigning["overlapUntil"].(*time.Time)) {
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
	immediateResult, err := f.svc.Mutate(f.ctx, p, owner, immediate)
	if err != nil {
		t.Fatal(err)
	}
	if immediateResult.Body.(map[string]any)["operation"].(map[string]any)["overlapUntil"] != (*time.Time)(nil) {
		t.Fatal("immediate rotation receipt has overlap deadline")
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
	originalReceipt, err := f.svc.Operation(f.ctx, p, owner, rot.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	restored := originalReceipt.(map[string]any)
	if restored["keyId"] != originalSigning["activeKeyId"] || !restored["overlapUntil"].(*time.Time).Equal(*originalSigning["overlapUntil"].(*time.Time)) {
		t.Fatalf("GET lost original rotation result after key deletion: %#v", restored)
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

// Failed ID or signing entropy leaves no configuration effect or receipt.
// Malformed destination data is visible and can still be deleted.
func TestPostgresEntropyAndDestinationFailuresRollback(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "personal", ID: p.UserID}
	created, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "initial", "https://receiver.example/path"))
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	id := ep["id"].(string)
	dest, key, updated := f.configuration(t, id)
	for _, kind := range []string{"create", "rotate"} {
		for _, boundary := range []string{"ID", "secret"} {
			m := createMutation(p, "failed", "https://example.test/")
			idBytes := 32
			if kind == "rotate" {
				m = mutation(p, "signing.rotate", id, 1)
				m.Mode = "immediate"
				idBytes = 16
			}
			if boundary == "ID" {
				idBytes = 0
			}
			f.svc.Random = bytes.NewReader(bytes.Repeat([]byte{1}, idBytes))
			if _, err = f.svc.Mutate(f.ctx, p, owner, m); !errors.Is(err, io.EOF) {
				t.Fatalf("%s %s entropy cause: %v", kind, boundary, err)
			}
		}
	}
	afterDest, afterKey, afterUpdated := f.configuration(t, id)
	var receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_operations WHERE owner_id=$1`, p.UserID).Scan(&receipts); err != nil || receipts != 1 || !bytes.Equal(dest, afterDest) || !bytes.Equal(key, afterKey) || !updated.Equal(afterUpdated) {
		t.Fatalf("failure left effects: receipts=%d err=%v", receipts, err)
	}
	name := "changed"
	change := mutation(p, "endpoint.update", id, 1)
	change.Name = &name
	if _, err := f.svc.Mutate(f.ctx, p, owner, change); err != nil {
		t.Fatalf("name update depended on entropy: %v", err)
	}
	unchangedDestination, unchangedSecret, _ := f.configuration(t, id)
	if !bytes.Equal(dest, unchangedDestination) || !bytes.Equal(key, unchangedSecret) {
		t.Fatal("name update changed target or signing secret")
	}
	f.svc.Random = nil
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_endpoints SET destination_configuration=$2 WHERE id=$1`, id, []byte("malformed configuration")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Get(f.ctx, p, owner, id); err == nil {
		t.Fatal("malformed destination was accepted")
	}
	change = mutation(p, "endpoint.update", id, 2)
	change.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/new"}
	if _, err := f.svc.Mutate(f.ctx, p, owner, change); err == nil {
		t.Fatal("malformed stored destination accepted by destination update")
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_operations WHERE owner_id=$1`, p.UserID).Scan(&receipts); err != nil || receipts != 2 {
		t.Fatalf("malformed target left receipt: %d %v", receipts, err)
	}
	if _, err := f.svc.Mutate(f.ctx, p, owner, mutation(p, "endpoint.delete", id, 2)); err != nil {
		t.Fatalf("delete damaged state: %v", err)
	}
}

// A07: credential revocation applies to new writes and to receipt projections.
func TestPostgresCredentialRevocationPreventsWritesAndReplay(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "personal", ID: p.UserID}
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

func (f *fixture) receiptFacts(t *testing.T, owner Owner) string {
	t.Helper()
	var facts string
	err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*)::text FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2`, owner.Kind, owner.ID).Scan(&facts)
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
	second := &Service{DB: &postgres.Store{Pool: aux}, ConfigurationExpansionAvailable: true}
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
			owner := Owner{Kind: "personal", ID: p.UserID}
			created, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "original", "https://receiver.example/path"))
			if err != nil {
				t.Fatal(err)
			}
			_, ep := body(t, created)
			id := ep["id"].(string)
			before := f.receiptFacts(t, owner)
			dest, key, updated := f.configuration(t, id)
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
			afterDest, afterKey, afterUpdated := f.configuration(t, id)
			var receipts int
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2`, owner.Kind, owner.ID).Scan(&receipts); err != nil {
				t.Fatal(err)
			}
			if receipts != 1 || before != f.receiptFacts(t, owner) || !bytes.Equal(dest, afterDest) || !bytes.Equal(key, afterKey) || !updated.Equal(afterUpdated) {
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
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1),0`, team).Scan(&endpoints, &receipts, &accounts); err != nil || endpoints != 0 || receipts != 0 || accounts != 0 {
		t.Fatalf("demoted intent left effect: endpoints=%d receipts=%d accounts=%d err=%v", endpoints, receipts, accounts, err)
	}
}

// Invalid intents, bad owner scopes and unusable randomness must fail before
// any receipt can be persisted.
func TestPostgresRejectsInvalidIntentsAndOwners(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "personal", ID: p.UserID}
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
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations),0`).Scan(&endpoints, &receipts, &accounts); err != nil || endpoints != 0 || receipts != 0 || accounts != 0 {
		t.Fatalf("refusal left effects: endpoints=%d receipts=%d accounts=%d err=%v", endpoints, receipts, accounts, err)
	}
}

// Counters never wrap, and a failed advancement preserves the prior state.
func TestPostgresVersionExhaustionRollsBack(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "personal", ID: p.UserID}
	created, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "original", "https://receiver.example/path"))
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	id := ep["id"].(string)
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_endpoints SET config_version=9223372036854775807 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	before := f.receiptFacts(t, owner)
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

	_, err = f.svc.Mutate(f.ctx, p, owner, change)
	expectFault(t, err, "version_exhausted")
	var receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_operations WHERE owner_id=$1`, p.UserID).Scan(&receipts); err != nil || receipts != 1 || before != f.receiptFacts(t, owner) {
		t.Fatalf("version exhaustion left effects: receipts=%d err=%v", receipts, err)
	}
}

func TestFailureClassificationPreservesCauses(t *testing.T) {
	cause := errors.New("database failure")
	if !errors.Is(notFound(cause), cause) {
		t.Fatal("unexpected failure was masked")
	}
	if err := checkTime("invalid", time.Now(), wm.Policy{OperationMaxAgeSeconds: 300, OperationFutureSkewSeconds: 60}); err == nil {
		t.Fatal("invalid timestamp accepted")
	}
}

func TestConfigurationExpansionSwitch(t *testing.T) {
	f := newFixture(t, true)
	p := f.principal(t)
	owner := Owner{Kind: "personal", ID: p.UserID}
	original := createMutation(p, "endpoint", "https://example.test/a")
	created, err := f.svc.Mutate(f.ctx, p, owner, original)
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	id := ep["id"].(string)
	f.svc.ConfigurationExpansionAvailable = false
	_, err = f.svc.Mutate(f.ctx, p, owner, createMutation(p, "new", "https://example.test/"))
	expectFault(t, err, "webhooks_unavailable")
	replay, err := f.svc.Mutate(f.ctx, p, owner, original)
	if err != nil || !replay.Replay {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	change := mutation(p, "endpoint.update", id, 1)
	change.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://example.test/b"}
	_, err = f.svc.Mutate(f.ctx, p, owner, change)
	expectFault(t, err, "webhooks_unavailable")
	disabled := false
	change = mutation(p, "endpoint.update", id, 1)
	change.Enabled = &disabled
	if _, err = f.svc.Mutate(f.ctx, p, owner, change); err != nil {
		t.Fatal(err)
	}
	enabled := true
	change = mutation(p, "endpoint.update", id, 2)
	change.Enabled = &enabled
	_, err = f.svc.Mutate(f.ctx, p, owner, change)
	expectFault(t, err, "webhooks_unavailable")
	deleted := mutation(p, "endpoint.delete", id, 2)
	if _, err = f.svc.Mutate(f.ctx, p, owner, deleted); err != nil {
		t.Fatal(err)
	}
}
