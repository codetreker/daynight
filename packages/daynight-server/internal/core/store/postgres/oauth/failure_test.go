package oauth

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type databaseStep struct {
	values []any
	err    error
}
type failingTx struct {
	pgx.Tx
	steps []databaseStep
}

func (tx *failingTx) next() databaseStep {
	if len(tx.steps) == 0 {
		panic("unexpected database operation")
	}
	step := tx.steps[0]
	tx.steps = tx.steps[1:]
	return step
}
func (tx *failingTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, tx.next().err
}
func (tx *failingTx) QueryRow(context.Context, string, ...any) pgx.Row { return stepRow(tx.next()) }
func (tx *failingTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, tx.next().err
}

type stepRow databaseStep

func (row stepRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(row.values) != len(dest) {
		panic("unexpected scan width")
	}
	for i, value := range row.values {
		target := reflect.ValueOf(dest[i]).Elem()
		if value == nil {
			target.SetZero()
		} else {
			target.Set(reflect.ValueOf(value).Convert(target.Type()))
		}
	}
	return nil
}

func TestDAOFailuresPreserveDriverCauseAndSQLState(t *testing.T) {
	ctx, now := context.Background(), time.Now().UTC()
	cause := &pgconn.PgError{Code: "08006", Message: "connection failure"}
	fail := databaseStep{err: cause}
	ok := databaseStep{}
	grant := databaseStep{values: []any{"grant", "user", "client", []byte(`{}`), "resource", "scope", now.Add(-time.Hour), now.Add(time.Hour), nil}}
	expiredClient := databaseStep{values: []any{"client", []byte(`{}`), now.Add(-9 * 24 * time.Hour), now.Add(-8 * 24 * time.Hour), now.Add(-24 * time.Hour)}}
	activeClient := databaseStep{values: []any{"client", []byte(`{}`), now, now, now.Add(7 * 24 * time.Hour)}}
	fresh := databaseStep{values: []any{now}}
	issue := store.OAuthFamilyIssue{Grant: store.OAuthGrant{CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, AccessHash: make([]byte, 32), RefreshHash: make([]byte, 32), AccessExpiresAt: now.Add(time.Minute)}
	for _, test := range []struct {
		name      string
		steps     []databaseStep
		operation func(*DAO) error
	}{
		{"capacity lock", []databaseStep{fail}, func(d *DAO) error { return d.LockClientCapacity(ctx) }},
		{"fresh time", []databaseStep{fail}, func(d *DAO) error { _, err := d.FreshTime(ctx, now); return err }},
		{"registration lock", []databaseStep{fail}, func(d *DAO) error { _, err := d.InsertClient(ctx, store.OAuthClient{}, 1, now); return err }},
		{"registration count", []databaseStep{ok, fail}, func(d *DAO) error { _, err := d.InsertClient(ctx, store.OAuthClient{}, 1, now); return err }},
		{"registration insert", []databaseStep{ok, {values: []any{0}}, fail}, func(d *DAO) error { _, err := d.InsertClient(ctx, store.OAuthClient{}, 1, now); return err }},
		{"client read", []databaseStep{fail}, func(d *DAO) error { _, err := d.Client(ctx, "client", false); return err }},
		{"pin client read", []databaseStep{fail}, func(d *DAO) error { _, err := d.PinClient(ctx, "client", now); return err }},
		{"pin client time", []databaseStep{activeClient, fail}, func(d *DAO) error { _, err := d.PinClient(ctx, "client", now); return err }},
		{"pin client references", []databaseStep{expiredClient, fresh, fail}, func(d *DAO) error { _, err := d.PinClient(ctx, "client", now); return err }},
		{"pin client update", []databaseStep{activeClient, fresh, fail}, func(d *DAO) error { _, err := d.PinClient(ctx, "client", now); return err }},
		{"expired client query", []databaseStep{fail}, func(d *DAO) error { _, err := d.ExpiredClients(ctx, now, 10); return err }},
		{"client delete", []databaseStep{fail}, func(d *DAO) error { return d.DeleteClient(ctx, "client") }},
		{"grant insert", []databaseStep{fail}, func(d *DAO) error { return d.IssueFamily(ctx, issue) }},
		{"access insert", []databaseStep{ok, fail}, func(d *DAO) error { return d.IssueFamily(ctx, issue) }},
		{"refresh insert", []databaseStep{ok, ok, fail}, func(d *DAO) error { return d.IssueFamily(ctx, issue) }},
		{"authorization cleanup lock", []databaseStep{fail}, func(d *DAO) error { _, err := d.PruneAuthorizations(ctx, now, 10); return err }},
		{"authorization cleanup cursor read", []databaseStep{ok, fail}, func(d *DAO) error { _, err := d.PruneAuthorizations(ctx, now, 10); return err }},
		{"authorization cleanup cursor write", []databaseStep{ok, {values: []any{0}}, fail}, func(d *DAO) error { _, err := d.PruneAuthorizations(ctx, now, 10); return err }},
		{"authorization cleanup first quota", []databaseStep{ok, {values: []any{0}}, ok, fail}, func(d *DAO) error { _, err := d.PruneAuthorizations(ctx, now, 10); return err }},
		{"authorization cleanup second quota", []databaseStep{ok, {values: []any{0}}, ok, ok, fail}, func(d *DAO) error { _, err := d.PruneAuthorizations(ctx, now, 10); return err }},
		{"authorization cleanup first spare", []databaseStep{ok, {values: []any{0}}, ok, ok, ok, fail}, func(d *DAO) error { _, err := d.PruneAuthorizations(ctx, now, 10); return err }},
		{"authorization cleanup second spare", []databaseStep{ok, {values: []any{0}}, ok, ok, ok, ok, fail}, func(d *DAO) error { _, err := d.PruneAuthorizations(ctx, now, 10); return err }},
		{"refresh lookup", []databaseStep{fail}, func(d *DAO) error { _, err := d.Refresh(ctx, nil, false); return err }},
		{"access grant lookup", []databaseStep{fail}, func(d *DAO) error { _, err := d.AccessGrant(ctx, nil); return err }},
		{"owner grants query", []databaseStep{fail}, func(d *DAO) error { _, err := d.OwnerGrants(ctx, "user"); return err }},
		{"credential cleanup cursor read", []databaseStep{fail}, func(d *DAO) error { _, err := d.PruneCredentials(ctx, now, 10); return err }},
		{"credential cleanup cursor write", []databaseStep{{values: []any{0}}, fail}, func(d *DAO) error { _, err := d.PruneCredentials(ctx, now, 10); return err }},
		{"credential cleanup first quota", []databaseStep{{values: []any{0}}, ok, fail}, func(d *DAO) error { _, err := d.PruneCredentials(ctx, now, 10); return err }},
		{"credential cleanup second quota", []databaseStep{{values: []any{0}}, ok, ok, fail}, func(d *DAO) error { _, err := d.PruneCredentials(ctx, now, 10); return err }},
		{"credential cleanup third quota", []databaseStep{{values: []any{0}}, ok, ok, ok, fail}, func(d *DAO) error { _, err := d.PruneCredentials(ctx, now, 10); return err }},
		{"credential cleanup first spare", []databaseStep{{values: []any{0}}, ok, ok, ok, ok, fail}, func(d *DAO) error { _, err := d.PruneCredentials(ctx, now, 10); return err }},
		{"credential cleanup second spare", []databaseStep{{values: []any{0}}, ok, ok, ok, ok, ok, fail}, func(d *DAO) error { _, err := d.PruneCredentials(ctx, now, 10); return err }},
		{"credential cleanup third spare", []databaseStep{{values: []any{0}}, ok, ok, ok, ok, ok, ok, fail}, func(d *DAO) error { _, err := d.PruneCredentials(ctx, now, 10); return err }},
		{"rotation consume", []databaseStep{fail}, func(d *DAO) error { return d.RotateRefresh(ctx, store.OAuthRotation{}) }},
		{"rotation access", []databaseStep{ok, fail}, func(d *DAO) error { return d.RotateRefresh(ctx, store.OAuthRotation{}) }},
		{"rotation refresh", []databaseStep{ok, ok, fail}, func(d *DAO) error { return d.RotateRefresh(ctx, store.OAuthRotation{}) }},
		{"revocation read", []databaseStep{fail}, func(d *DAO) error { _, err := d.RevokeFamily(ctx, "grant", now); return err }},
		{"revocation update", []databaseStep{grant, fail}, func(d *DAO) error { _, err := d.RevokeFamily(ctx, "grant", now); return err }},
		{"revocation access delete", []databaseStep{grant, ok, fail}, func(d *DAO) error { _, err := d.RevokeFamily(ctx, "grant", now); return err }},
		{"access authentication", []databaseStep{fail}, func(d *DAO) error { _, err := d.AuthenticateAccess(ctx, nil, "resource", "scope", now); return err }},
		{"grant inspection", []databaseStep{fail}, func(d *DAO) error { _, err := d.InspectGrant(ctx, "grant", true); return err }},
		{"client references", []databaseStep{fail}, func(d *DAO) error { _, err := d.ActiveClientReferences(ctx, "client", now); return err }},
	} {
		t.Run(test.name, func(t *testing.T) {
			tx := &failingTx{steps: append([]databaseStep(nil), test.steps...)}
			err := test.operation(NewDAO(tx))
			failed, state := store.DatabaseErrorFacts(err)
			if !errors.Is(err, cause) || !failed || state != cause.Code {
				t.Fatalf("database failure lost: %v (%v, %q)", err, failed, state)
			}
			if len(tx.steps) != 0 {
				t.Fatalf("operation returned before intended failure: %d unused steps", len(tx.steps))
			}
		})
	}
}

func TestMissingGrantPreservesAbsence(t *testing.T) {
	dao := NewDAO(&failingTx{steps: []databaseStep{{err: pgx.ErrNoRows}}})
	_, err := dao.InspectGrant(context.Background(), "missing", false)
	if !errors.Is(err, model.ErrNotFound) || !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("absence cause lost: %v", err)
	}
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		t.Fatalf("absence classified as database failure: %v", err)
	}
}

func TestAuthorizationFailuresPreserveDriverCauseAndSQLState(t *testing.T) {
	ctx, now := t.Context(), time.Now().UTC()
	cause := &pgconn.PgError{Code: "08006", Message: "authorization storage lost"}
	fail, ok := databaseStep{err: cause}, databaseStep{}
	fresh := databaseStep{values: []any{now}}
	zero := databaseStep{values: []any{0}}
	record := store.OAuthAuthorization{CreatedAt: now, ExpiresAt: now.Add(time.Minute), RetainUntil: now.Add(time.Hour)}
	for _, tc := range []struct {
		name  string
		steps []databaseStep
		call  func(*DAO) error
	}{
		{"insert capacity lock", []databaseStep{fail}, func(d *DAO) error { _, err := d.InsertAuthorization(ctx, record, 1, now); return err }},
		{"insert fresh clock", []databaseStep{ok, fail}, func(d *DAO) error { _, err := d.InsertAuthorization(ctx, record, 1, now); return err }},
		{"insert pending count", []databaseStep{ok, fresh, fail}, func(d *DAO) error { _, err := d.InsertAuthorization(ctx, record, 1, now); return err }},
		{"insert row", []databaseStep{ok, fresh, zero, fail}, func(d *DAO) error { _, err := d.InsertAuthorization(ctx, record, 1, now); return err }},
		{"authorization read", []databaseStep{fail}, func(d *DAO) error { _, err := d.Authorization(ctx, "id", true); return err }},
		{"code read", []databaseStep{fail}, func(d *DAO) error { _, err := d.AuthorizationByCode(ctx, nil, true); return err }},
		{"update", []databaseStep{fail}, func(d *DAO) error { return d.UpdateAuthorization(ctx, record) }},
		{"prune lock", []databaseStep{fail}, func(d *DAO) error { _, err := d.PruneAuthorizations(ctx, now, 1); return err }},
		{"prune expire", []databaseStep{ok, zero, ok, fail}, func(d *DAO) error { _, err := d.PruneAuthorizations(ctx, now, 1); return err }},
		{"prune delete", []databaseStep{ok, {values: []any{1}}, ok, fail}, func(d *DAO) error { _, err := d.PruneAuthorizations(ctx, now, 1); return err }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx := &failingTx{steps: append([]databaseStep(nil), tc.steps...)}
			err := tc.call(NewDAO(tx))
			failed, state := store.DatabaseErrorFacts(err)
			if !errors.Is(err, cause) || !failed || state != cause.Code || len(tx.steps) != 0 {
				t.Fatalf("failure=%v, facts=%v,%s, unused steps=%d", err, failed, state, len(tx.steps))
			}
		})
	}
}
