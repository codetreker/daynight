package team_test

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	teamstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
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
	testutil.MustExec(t, s.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, uuid.NewString())
	err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		items, err := snapshot.TeamDAO().TeamMembers(ctx, team.ID)
		if items != nil || err == nil {
			t.Fatalf("missing user accepted: %#v %v", items, err)
		}
		return err
	})
	if err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("integrity failure hidden: %v", err)
	}
	err = s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
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

func TestTeamMemberPageDoesNotMaterializeOversizedProfile(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	_, team := testutil.TeamFixture(t, s)
	_, other, _ := testutil.AuthRecords(t, s)
	testutil.MustExec(t, s.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, other.UserID)
	testutil.MustExec(t, s.Pool, `UPDATE users SET name=repeat('x',$2) WHERE id=$1`, other.UserID, TeamMemberProfileByteLimit+1)
	ctx := context.Background()
	var checked bool
	err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		raw, err := s.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer raw.Rollback(ctx)
		tx := &boundedTeamMembersTx{Tx: raw, t: t}
		page, err := teamstore.NewReader(tx).TeamMembersPage(ctx, team.ID, Page{Limit: 100})
		if err != nil {
			return err
		}
		checked = tx.sawOversized
		if len(page.Items) != 1 || !page.HasMore {
			t.Fatalf("page %#v", page)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !checked {
		t.Fatal("oversized profile was not observed")
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

type boundedTeamMembersTx struct {
	pgx.Tx
	t            *testing.T
	sawOversized bool
}

func (tx *boundedTeamMembersTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	rows, err := tx.Tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return boundedTeamMembersRows{Rows: rows, tx: tx}, nil
}

type boundedTeamMembersRows struct {
	pgx.Rows
	tx *boundedTeamMembersTx
}

func (rows boundedTeamMembersRows) Scan(dest ...any) error {
	if err := rows.Rows.Scan(dest...); err != nil {
		return err
	}
	if *dest[10].(*bool) {
		rows.tx.sawOversized = true
		for _, field := range dest[7:10] {
			if *field.(**string) != nil {
				rows.tx.t.Fatal("oversized profile field crossed the database boundary")
			}
		}
	}
	return nil
}
