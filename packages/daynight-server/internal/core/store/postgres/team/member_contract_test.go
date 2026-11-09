package team_test

import (
	"context"
	"errors"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	teamstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
)

func TestTeamMemberDirectoryFailuresDoNotPublishPartialResults(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	_, team := testutil.TeamFixture(t, s)
	ctx := context.Background()
	for _, mode := range []string{"query", "scan", "stream"} {
		cause := errors.New("directory stream failure")
		err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			raw, err := s.Pool.Begin(ctx)
			if err != nil {
				return err
			}
			defer raw.Rollback(ctx)
			reader := teamstore.NewReader(teamMembersFailureTx{Tx: raw, cause: cause, scan: mode == "scan", failQuery: mode == "query"})
			items, err := reader.TeamMembers(ctx, team.ID)
			if items != nil || !errors.Is(err, cause) {
				t.Fatalf("partial directory %#v: %v", items, err)
			}
			return err
		})
		if !errors.Is(err, cause) {
			t.Fatalf("failure chain lost: %v", err)
		}
	}
	err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		_, err := snapshot.TeamDAO().TeamMembers(canceled, team.ID)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled list: %v", err)
	}
}

func TestTeamMemberAdminCountCancellationPreservesCause(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	_, team := testutil.TeamFixture(t, s)
	err := testutil.WriteTeam(context.Background(), s, team.ID, func(tx TeamWriteDAO) error {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := tx.AdminCount(ctx)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled admin count: %v", err)
	}
}

// A reader must not expose a partial directory when decoding or streaming fails.
type teamMembersFailureTx struct {
	pgx.Tx
	cause     error
	scan      bool
	failQuery bool
}

func (tx teamMembersFailureTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if tx.failQuery {
		return nil, tx.cause
	}
	rows, err := tx.Tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return teamMembersFailureRows{Rows: rows, cause: tx.cause, scan: tx.scan}, nil
}

type teamMembersFailureRows struct {
	pgx.Rows
	cause error
	scan  bool
}

func (rows teamMembersFailureRows) Scan(dest ...any) error {
	if rows.scan {
		return rows.cause
	}
	return rows.Rows.Scan(dest...)
}
func (rows teamMembersFailureRows) Err() error {
	if err := rows.Rows.Err(); err != nil {
		return err
	}
	if !rows.scan {
		return rows.cause
	}
	return nil
}
