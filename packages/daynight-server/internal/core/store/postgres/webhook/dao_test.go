package webhook

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type rowFunc func(...any) error

func (f rowFunc) Scan(v ...any) error { return f(v...) }

type captureTx struct {
	pgx.Tx
	args []any
	sql  string
	err  error
}

func TestPostgresSchemaRoundTrip(t *testing.T) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	migration, err := os.ReadFile("../migrations/048_webhook_management.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	d := New(tx)
	now := time.Now().UTC().Truncate(time.Microsecond)
	owner := model.Owner{Kind: "personal", ID: uuid.NewString()}
	ep := model.Endpoint{ID: uuid.NewString(), Owner: owner, Name: "example", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.test", DestinationCiphertext: sampleEnvelope(t), ActiveKeyID: uuid.NewString(), CreatedAt: now, UpdatedAt: now}
	if err = d.PutEndpoint(ctx, ep); err != nil {
		t.Fatal(err)
	}
	got, err := d.Endpoint(ctx, owner, ep.ID)
	if err != nil || got.Name != ep.Name || !bytes.Equal(got.DestinationCiphertext, ep.DestinationCiphertext) {
		t.Fatalf("endpoint=%+v err=%v", got, err)
	}
	key := model.SigningKey{EndpointID: ep.ID, ID: ep.ActiveKeyID, Slot: "current", Ciphertext: sampleEnvelope(t), CreatedAt: now}
	if err = d.PutSigningKey(ctx, key); err != nil {
		t.Fatal(err)
	}
	keys, err := d.SigningKeys(ctx, ep.ID)
	if err != nil || len(keys) != 1 || keys[0].Slot != "current" || !bytes.Equal(keys[0].Ciphertext, key.Ciphertext) {
		t.Fatalf("keys=%+v err=%v", keys, err)
	}
	op := model.Operation{Owner: owner, ID: uuid.NewString(), ActorID: uuid.NewString(), Kind: "signing.rotate", TargetID: ep.ID, IssuedAt: "2026-11-07T10:01:02.000Z", RequestSHA256: strings.Repeat("a1", 32), Fingerprint: strings.Repeat("bc", 32), Effect: "applied", ConfigVersion: 2, DestinationRevisionAfter: 1, ActiveKeyID: key.ID, SigningMode: "immediate", RecordedAt: now, ExpiresAt: now.Add(time.Hour)}
	if err = d.PutOperation(ctx, op); err != nil {
		t.Fatal(err)
	}
	observed, err := d.Operation(ctx, owner, op.ID)
	if err != nil || observed.Kind != op.Kind || observed.RequestSHA256 != op.RequestSHA256 || observed.Fingerprint != op.Fingerprint || observed.SigningMode != op.SigningMode || observed.IssuedAt != op.IssuedAt {
		t.Fatalf("operation=%+v err=%v", observed, err)
	}
	policy, err := d.Policy(ctx, 1)
	if err != nil || policy.MaxAutomaticAttempts != 10 || policy.OperationMaxAgeSeconds != 300 || len(policy.AutomaticOffsetsSeconds) != 10 || policy.KeyOverlapMaxSeconds != 604800 {
		t.Fatalf("policy=%+v err=%v", policy, err)
	}
	ep.Enabled = false
	ep.DeletedAt = &now
	if err = d.PutEndpoint(ctx, ep); err != nil {
		t.Fatal(err)
	}
	tomb, err := d.Endpoint(ctx, owner, ep.ID)
	if err != nil || tomb.DeletedAt == nil || tomb.Name != "" || len(tomb.DestinationCiphertext) != 0 {
		t.Fatalf("tombstone=%+v err=%v", tomb, err)
	}
}

func (t *captureTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	t.sql, t.args = sql, args
	return pgconn.NewCommandTag("INSERT 0 1"), t.err
}
func sampleEnvelope(t *testing.T) []byte {
	t.Helper()
	e := secretbox.Envelope{Version: 1, MasterKeyID: "key", Nonce: bytes.Repeat([]byte{1}, 12), Ciphertext: bytes.Repeat([]byte{2}, 48)}
	b, err := e.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func TestEndpointMapping(t *testing.T) {
	now := time.Now()
	row := rowFunc(func(v ...any) error {
		*v[0].(*string) = "id"
		*v[1].(*string) = "personal"
		*v[2].(*string) = "owner"
		name, kind, origin, master, active := "name", "http", "https://example.test", "key", "active"
		adapter, ver := int64(1), int16(1)
		*v[3].(**string) = &name
		*v[4].(*bool) = true
		*v[6].(*int64) = 1
		*v[7].(*int64) = 2
		*v[8].(**string) = &kind
		*v[9].(**int64) = &adapter
		*v[10].(**string) = &origin
		*v[11].(**int16) = &ver
		*v[12].(**string) = &master
		*v[13].(*[]byte) = bytes.Repeat([]byte{1}, 12)
		*v[14].(*[]byte) = bytes.Repeat([]byte{2}, 48)
		*v[15].(**string) = &active
		*v[16].(*time.Time) = now
		*v[17].(*time.Time) = now
		return nil
	})
	e, err := scanEndpoint(row)
	if err != nil || e.Name != "name" || e.AdapterVersion != "1" || !bytes.Equal(e.DestinationCiphertext, sampleEnvelope(t)) {
		t.Fatalf("endpoint=%+v err=%v", e, err)
	}
	tx := &captureTx{}
	if err = New(tx).PutEndpoint(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	if tx.args[10] != int16(1) || tx.args[12] != int16(1) || tx.args[13] != "key" || !bytes.Equal(tx.args[14].([]byte), bytes.Repeat([]byte{1}, 12)) || !bytes.Equal(tx.args[15].([]byte), bytes.Repeat([]byte{2}, 48)) {
		t.Fatalf("column arguments: %#v", tx.args)
	}
	e.DeletedAt = &now
	e.Enabled = false
	if err = New(tx).PutEndpoint(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	for _, i := range []int{3, 8, 9, 10, 11, 12, 13, 14, 15, 16} {
		if tx.args[i] != nil {
			t.Fatalf("tombstone column %d = %#v", i, tx.args[i])
		}
	}
	tomb, err := scanEndpoint(rowFunc(func(v ...any) error { *v[5].(**time.Time) = &now; return nil }))
	if err != nil || tomb.DeletedAt == nil || tomb.DestinationCiphertext != nil || tomb.Name != "" {
		t.Fatalf("tombstone=%+v err=%v", tomb, err)
	}
	cause := errors.New("scan failure")
	if _, err = scanEndpoint(rowFunc(func(...any) error { return cause })); !errors.Is(err, cause) {
		t.Fatalf("scan cause: %v", err)
	}
}
func TestOperationMappingAndFailures(t *testing.T) {
	tx := &captureTx{}
	d := New(tx)
	r := model.Operation{Owner: model.Owner{Kind: "personal", ID: "owner"}, ID: "op", ActorID: "actor", TargetID: "endpoint", Kind: "signing.rotate", RequestSHA256: strings.Repeat("a1", 32), Fingerprint: strings.Repeat("bc", 32), ActiveKeyID: "key", SigningMode: "immediate"}
	if err := d.PutOperation(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if tx.args[5] != "signing-secret.rotate" || !bytes.Equal(tx.args[7].([]byte), bytes.Repeat([]byte{0xa1}, 32)) || !bytes.Equal(tx.args[8].([]byte), bytes.Repeat([]byte{0xbc}, 32)) || tx.args[13] != "immediate" {
		t.Fatalf("operation args %#v", tx.args)
	}
	for _, pair := range [][2]string{{"endpoint.update", "endpoint.patch"}, {"signing.rotate", "signing-secret.rotate"}, {"endpoint.create", "endpoint.create"}, {"endpoint.delete", "endpoint.delete"}} {
		if wireKind(pair[0]) != pair[1] || modelKind(pair[1]) != pair[0] {
			t.Fatalf("kind mapping %v", pair)
		}
	}
	r.RequestSHA256 = "bad"
	if err := d.PutOperation(context.Background(), r); err == nil {
		t.Fatal("bad hash accepted")
	}
	r.RequestSHA256 = strings.Repeat("aa", 32)
	r.Fingerprint = "invalid"
	if err := d.PutOperation(context.Background(), r); err == nil {
		t.Fatal("bad fingerprint accepted")
	}
	r.Fingerprint = strings.Repeat("bb", 32)
	cause := errors.New("SQL failure")
	tx.err = cause
	if err := d.PutOperation(context.Background(), r); !errors.Is(err, cause) {
		t.Fatalf("SQL cause %v", err)
	}
}
func TestSigningKeyMapping(t *testing.T) {
	tx := &captureTx{}
	d := New(tx)
	now := time.Now()
	end := now.Add(time.Hour)
	k := model.SigningKey{EndpointID: "endpoint", ID: "key", Slot: "overlap", Ciphertext: sampleEnvelope(t), OverlapStartedAt: &now, OverlapUntil: &end}
	if err := d.PutSigningKey(context.Background(), k); err != nil {
		t.Fatal(err)
	}
	if tx.args[2] != "overlap" || tx.args[4] != "key" || !bytes.Equal(tx.args[6].([]byte), bytes.Repeat([]byte{2}, 48)) || tx.args[8] != &now {
		t.Fatalf("signing columns %#v", tx.args)
	}
	k.Ciphertext = []byte{1}
	if err := d.PutSigningKey(context.Background(), k); !errors.Is(err, secretbox.ErrInvalidEnvelope) {
		t.Fatalf("invalid envelope %v", err)
	}
}
