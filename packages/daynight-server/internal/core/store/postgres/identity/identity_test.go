package identity

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type recordingTx struct {
	pgx.Tx
	statements int
	cause      error
	rowCause   error
}

func (tx *recordingTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	tx.statements++
	return pgconn.CommandTag{}, tx.cause
}

type errorRow struct{ err error }

func (row errorRow) Scan(...any) error { return row.err }
func (tx *recordingTx) QueryRow(context.Context, string, ...any) pgx.Row {
	return errorRow{err: tx.rowCause}
}

func TestScopeBindsBothDAOsToSameTransaction(t *testing.T) {
	cause := errors.New("transaction failed")
	tx := &recordingTx{cause: cause}
	scope := NewScope(tx)
	if err := scope.IdentityDAO().InsertLogin(context.Background(), model.LoginTransaction{}); !errors.Is(err, cause) {
		t.Fatalf("identity operation: %v", err)
	}
	if err := scope.PersonalTeamDAO().InsertPersonalOwner(context.Background(), "team", "user", time.Time{}); !errors.Is(err, cause) {
		t.Fatalf("personal team operation: %v", err)
	}
	if tx.statements != 2 {
		t.Fatalf("transaction received %d statements, want 2", tx.statements)
	}
}

func TestIdentityDAOClassifiesDriverFailuresAndAbsence(t *testing.T) {
	driver := &pgconn.PgError{Code: "23505", Message: "private"}
	tx := &recordingTx{cause: driver, rowCause: driver}
	dao := NewScope(tx).IdentityDAO()
	for _, err := range []error{
		dao.InsertDevice(context.Background(), model.DeviceAuthorization{}),
		func() error { _, err := dao.UpsertUser(context.Background(), model.User{}, time.Time{}); return err }(),
		dao.CleanupCredentials(context.Background(), time.Time{}),
	} {
		failed, state := store.DatabaseErrorFacts(err)
		if !failed || state != "23505" || !errors.Is(err, driver) {
			t.Fatalf("driver failure facts=(%v,%q), error=%v", failed, state, err)
		}
	}
	tx.rowCause = pgx.ErrNoRows
	_, err := dao.ConsumeLogin(context.Background(), nil, nil, time.Time{})
	failed, _ := store.DatabaseErrorFacts(err)
	if failed || !errors.Is(err, model.ErrNotFound) || !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing login was classified as a database failure: %v", err)
	}
}
