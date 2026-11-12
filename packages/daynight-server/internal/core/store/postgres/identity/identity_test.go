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
	family := &struct{ store.CredentialFamilyDAO }{}
	scope := NewScope(tx, family)
	if scope.CredentialFamilyDAO() != family {
		t.Fatal("credential family injection lost")
	}
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
	dao := NewScope(tx, struct{ store.CredentialFamilyDAO }{}).IdentityDAO()
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

func TestLoginAdmissionPreservesLockAndClockFailures(t *testing.T) {
	cause := &pgconn.PgError{Code: "08006", Message: "connection failure"}
	for _, tx := range []*recordingTx{{cause: cause}, {rowCause: cause}} {
		_, _, err := NewScope(tx, struct{ store.CredentialFamilyDAO }{}).IdentityDAO().AdmitLogin(context.Background(), nil, 10000, 5)
		failed, state := store.DatabaseErrorFacts(err)
		if !errors.Is(err, cause) || !failed || state != cause.Code {
			t.Fatalf("login admission lost database failure: %v (%v, %q)", err, failed, state)
		}
	}
}

func (tx *recordingTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, tx.cause
}

func TestIdentityOperationsPreserveDatabaseFailures(t *testing.T) {
	cause := &pgconn.PgError{Code: "08006", Message: "connection failure"}
	sc := NewScope(&recordingTx{cause: cause, rowCause: cause}, struct{ store.CredentialFamilyDAO }{})
	dao, teams := sc.IdentityDAO(), sc.PersonalTeamDAO()
	ctx, now := context.Background(), time.Now()
	for _, test := range []struct {
		name      string
		operation func() error
	}{
		{"admit login", func() error { _, _, err := dao.AdmitLogin(ctx, nil, 10000, 5); return err }},
		{"insert login", func() error { return dao.InsertLogin(ctx, model.LoginTransaction{}) }},
		{"consume login", func() error { _, err := dao.ConsumeLogin(ctx, nil, nil, now); return err }},
		{"ensure user", func() error { _, _, err := dao.EnsureUser(ctx, model.User{}, now); return err }},
		{"patch user", func() error {
			_, err := dao.PatchUser(ctx, "", model.UserProfilePatch{Name: model.ProfileField{Present: true}})
			return err
		}},
		{"insert session", func() error { return dao.InsertSession(ctx, model.Session{}) }},
		{"authenticate", func() error { _, err := dao.Authenticate(ctx, model.SessionCredential, nil, now); return err }},
		{"read user", func() error { _, _, err := dao.IdentityUser(ctx, ""); return err }},
		{"read identity personal team", func() error { _, err := dao.IdentityPersonalTeam(ctx, ""); return err }},
		{"delete session", func() error { return dao.DeleteSession(ctx, model.Principal{}) }},
		{"lock session", func() error { return dao.LockSession(ctx, model.Principal{Kind: model.SessionCredential}, now) }},
		{"insert PAT", func() error { return dao.InsertPAT(ctx, model.PersonalAccessToken{}) }},
		{"list PATs", func() error { _, err := dao.ListPATs(ctx, "", now); return err }},
		{"delete PAT", func() error { return dao.DeletePAT(ctx, "", "") }},
		{"lock PAT", func() error { _, err := dao.LockActivePAT(ctx, "", "", now); return err }},
		{"set PAT expiry", func() error { _, err := dao.SetPATExpiry(ctx, "", &now); return err }},
		{"prune device rates", func() error { return dao.PruneDeviceRates(ctx, now) }},
		{"increment device rate", func() error { _, err := dao.IncrementDeviceRate(ctx, model.DeviceRateBucket{}, now); return err }},
		{"prune devices", func() error { return dao.PruneDevices(ctx, now) }},
		{"read device", func() error { _, err := dao.DeviceByUserCode(ctx, "", "", false); return err }},
		{"lock device", func() error { _, err := dao.LockDeviceByHash(ctx, nil); return err }},
		{"set device decision", func() error { return dao.SetDeviceDecision(ctx, "", "", "") }},
		{"delay device poll", func() error { return dao.DelayDevicePoll(ctx, "", now, false) }},
		{"consume device", func() error { return dao.ConsumeDevice(ctx, "") }},
		{"insert personal team", func() error { _, err := teams.InsertPersonalTeam(ctx, "", "", now); return err }},
		{"insert personal owner", func() error { return teams.InsertPersonalOwner(ctx, "", "", now) }},
		{"read personal team", func() error { _, err := teams.PersonalTeam(ctx, ""); return err }},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := test.operation()
			failed, state := store.DatabaseErrorFacts(err)
			if !errors.Is(err, cause) || !failed || state != cause.Code {
				t.Fatalf("database failure lost: %v (%v, %q)", err, failed, state)
			}
		})
	}
}

type ensureReadFailureTx struct {
	pgx.Tx
	calls int
	cause error
}

func (tx *ensureReadFailureTx) QueryRow(context.Context, string, ...any) pgx.Row {
	tx.calls++
	if tx.calls == 1 {
		return errorRow{err: pgx.ErrNoRows}
	}
	return errorRow{err: tx.cause}
}

func TestEnsureUserPreservesConflictReadFailures(t *testing.T) {
	for _, cause := range []error{pgx.ErrNoRows, &pgconn.PgError{Code: "08006", Message: "connection failure"}} {
		tx := &ensureReadFailureTx{cause: cause}
		user, inserted, err := NewScope(tx, struct{ store.CredentialFamilyDAO }{}).IdentityDAO().EnsureUser(t.Context(), model.User{}, time.Now())
		if !errors.Is(err, cause) || inserted || user.ID != "" || tx.calls != 2 {
			t.Fatalf("conflict read failure lost: user=%+v inserted=%t calls=%d error=%v", user, inserted, tx.calls, err)
		}
	}
}
