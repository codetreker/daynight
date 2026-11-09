package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func identityScopeTest(t *testing.T, s *Store, op func(IdentityScope) error) {
	t.Helper()
	completion, err := s.WriteIdentity(context.Background(), op)
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("identity transaction: %#v %v", completion, err)
	}
}

func TestIdentityDAOFailuresPreserveTransactionOutcome(t *testing.T) {
	for _, test := range []struct {
		name, table string
		operation   func(context.Context, IdentityScope, string) error
	}{
		{"PAT list", "personal_access_tokens", func(ctx context.Context, sc IdentityScope, id string) error {
			_, err := sc.IdentityDAO().ListPATs(ctx, id, time.Now())
			return err
		}},
		{"personal team lookup", "teams", func(ctx context.Context, sc IdentityScope, id string) error {
			_, err := sc.PersonalTeamDAO().PersonalTeam(ctx, id)
			return err
		}},
		{"device insert", "device_authorizations", func(ctx context.Context, sc IdentityScope, id string) error {
			return sc.IdentityDAO().InsertDevice(ctx, model.DeviceAuthorization{})
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := context.Background()
			user, _, _ := testAuthRecords(t, s)
			if _, err := s.Pool.Exec(ctx, "DROP TABLE "+test.table+" CASCADE"); err != nil {
				t.Fatal(err)
			}
			completion, err := s.WriteIdentity(ctx, func(sc IdentityScope) error { return test.operation(ctx, sc, user.ID) })
			var databaseError *pgconn.PgError
			if err == nil || !errors.As(err, &databaseError) || databaseError.Code != "42P01" || completion.Outcome != TransactionNotCommitted {
				t.Fatalf("database failure or outcome lost: %#v %v", completion, err)
			}
		})
	}
	s := isolatedStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	completion, err := s.WriteIdentity(ctx, func(IdentityScope) error { t.Error("operation ran after cancellation"); return nil })
	if !errors.Is(err, context.Canceled) || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("canceled begin: %#v %v", completion, err)
	}
}

func TestIdentityCleanupFailureRollsBackEarlierDeletes(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, _, session := testAuthRecords(t, s)
	login := model.LoginTransaction{ID: uuid.NewString(), StateHash: deviceStoreHash("expired-state"), BrowserBindingHash: deviceStoreHash("expired-binding"), ScopeHash: deviceStoreHash("scope"), Provider: "github", ReturnPath: "/", ExpiresAt: now.Add(-time.Hour)}
	identityScopeTest(t, s, func(scope IdentityScope) error { return scope.IdentityDAO().InsertLogin(ctx, login) })
	if _, err := s.Pool.Exec(ctx, `UPDATE sessions SET created_at=$2,expires_at=$3 WHERE id=$1`, session.ID, now.Add(-2*time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `DROP TABLE personal_access_tokens`); err != nil {
		t.Fatal(err)
	}
	completion, err := s.WriteIdentity(ctx, func(scope IdentityScope) error { return scope.IdentityDAO().CleanupCredentials(ctx, now) })
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "42P01" || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("cleanup failure: %#v %v", completion, err)
	}
	var logins, sessions int
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions WHERE id=$1),(SELECT count(*) FROM sessions WHERE id=$2)`, login.ID, session.ID).Scan(&logins, &sessions); err != nil || logins != 1 || sessions != 1 {
		t.Fatalf("cleanup committed partial deletes: %d %d %v", logins, sessions, err)
	}
}
