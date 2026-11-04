package store

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTeamMemberStoreSnapshotAndMutation(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	ctx := context.Background()
	_, other, _ := testAuthRecords(t, s)
	mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, other.UserID)
	err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		original, err := snapshot.TeamMembers(ctx, team.ID)
		if err != nil {
			return err
		}
		if len(original) != 2 || original[0].Membership.UserID != actor.UserID || original[1].Membership.UserID != other.UserID {
			t.Fatalf("directory: %#v", original)
		}
		if original[1].Profile.Name != nil || original[1].Profile.Email != nil || original[1].Profile.AvatarURL != nil {
			t.Fatalf("nullable profile: %#v", original[1].Profile)
		}
		err = s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error {
			member, err := tx.Member(ctx, other.UserID)
			if err != nil || member != original[1].Membership {
				t.Fatalf("member: %#v %v", member, err)
			}
			count, err := tx.AdminCount(ctx)
			if err != nil || count != 1 {
				t.Fatalf("admin count %d %v", count, err)
			}
			updated, err := tx.SetMemberRole(ctx, other.UserID, core.ProjectAdmin)
			if err != nil || updated.Role != core.ProjectAdmin || updated.Version <= member.Version {
				t.Fatalf("updated relation %#v %v", updated, err)
			}
			return nil
		})
		if err != nil {
			return err
		}
		again, err := snapshot.TeamMembers(ctx, team.ID)
		if err == nil && !reflect.DeepEqual(original, again) {
			t.Fatalf("snapshot changed: %#v %#v", original, again)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	err = s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error {
		count, err := tx.AdminCount(ctx)
		if err != nil || count != 2 {
			t.Fatalf("committed admin count %d %v", count, err)
		}
		return tx.RemoveMember(ctx, other.UserID)
	})
	if err != nil {
		t.Fatal(err)
	}
	err = s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error { _, err := tx.Member(ctx, other.UserID); return err })
	if !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("removed membership: %v", err)
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

func TestTeamMemberDirectoryFailuresDoNotPublishPartialResults(t *testing.T) {
	s, _, team := storeTeamFixture(t)
	ctx := context.Background()
	for _, mode := range []string{"query", "scan", "stream"} {
		cause := errors.New("directory stream failure")
		err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
			snapshot.tx = teamMembersFailureTx{Tx: snapshot.tx, cause: cause, scan: mode == "scan", failQuery: mode == "query"}
			items, err := snapshot.TeamMembers(ctx, team.ID)
			if items != nil || !errors.Is(err, cause) {
				t.Fatalf("partial directory %#v: %v", items, err)
			}
			return err
		})
		if !errors.Is(err, cause) {
			t.Fatalf("failure chain lost: %v", err)
		}
	}
	mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, uuid.NewString())
	err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		items, err := snapshot.TeamMembers(ctx, team.ID)
		if items != nil || err == nil {
			t.Fatalf("missing user accepted: %#v %v", items, err)
		}
		return err
	})
	if err == nil || errors.Is(err, core.ErrNotFound) {
		t.Fatalf("integrity failure hidden: %v", err)
	}
	err = s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		_, err := snapshot.TeamMembers(canceled, team.ID)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled list: %v", err)
	}
}

func TestTeamMemberMutationFailuresRollbackAndPreserveCauses(t *testing.T) {
	for _, operation := range []string{"update", "delete"} {
		t.Run(operation, func(t *testing.T) {
			s, actor, team := storeTeamFixture(t)
			ctx := context.Background()
			event := "UPDATE"
			if operation == "delete" {
				event = "DELETE"
			}
			mustQueryExec(t, s, `CREATE FUNCTION refuse_member_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'member failure'; END $$;
 CREATE TRIGGER refuse_member_change BEFORE `+event+` ON team_members FOR EACH ROW EXECUTE FUNCTION refuse_member_change()`)
			err := s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error {
				if operation == "update" {
					_, err := tx.SetMemberRole(ctx, actor.UserID, core.ProjectMemberRole)
					return err
				}
				return tx.RemoveMember(ctx, actor.UserID)
			})
			var transaction *TransactionError
			var database *pgconn.PgError
			if !errors.As(err, &transaction) || transaction.Outcome != TransactionNotCommitted || transaction.CommitAttempted || !errors.As(err, &database) || database.Code != "P0001" {
				t.Fatalf("rollback failure %#v %v", transaction, err)
			}
			if got := readStoreTeam(t, s, actor.UserID, team.ID); !reflect.DeepEqual(got, team) {
				t.Fatalf("failed mutation changed relationship: %#v", got)
			}
		})
	}
}

func TestTeamMemberCancellationAndUnknownCommit(t *testing.T) {
	s, actor, team := storeTeamFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	err := s.WriteTeam(ctx, team.ID, func(tx *TeamTx) error {
		if _, err := tx.SetMemberRole(ctx, actor.UserID, core.ProjectMemberRole); err != nil {
			return err
		}
		cancel()
		return nil
	})
	var failure *TransactionError
	if !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.Outcome != TransactionNotCommitted || failure.CommitAttempted {
		t.Fatalf("canceled write %#v %v", failure, err)
	}
	if got := readStoreTeam(t, s, actor.UserID, team.ID); !reflect.DeepEqual(got, team) {
		t.Fatalf("canceled write persisted: %#v", got)
	}
	base := context.Background()
	tx, err := s.Pool.BeginTx(base, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("commit response lost")
	err = transact(base, &threadCommitResponseLoss{Tx: tx, cause: lost}, func(raw pgx.Tx) error {
		var id string
		if err := raw.QueryRow(base, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, team.ID).Scan(&id); err != nil {
			return err
		}
		_, err := (&TeamTx{tx: raw, teamID: team.ID}).SetMemberRole(base, actor.UserID, core.ProjectMemberRole)
		return err
	})
	if !errors.Is(err, lost) || !errors.As(err, &failure) || failure.Outcome != TransactionUnknown || !failure.CommitAttempted {
		t.Fatalf("unknown write %#v %v", failure, err)
	}
	got := readStoreTeam(t, s, actor.UserID, team.ID)
	if got.Membership.Role != core.ProjectMemberRole || got.Membership.Version <= team.Membership.Version {
		t.Fatalf("actual committed membership: %#v", got.Membership)
	}
}

func TestTeamMemberAdminCountCancellationPreservesCause(t *testing.T) {
	s, _, team := storeTeamFixture(t)
	err := s.WriteTeam(context.Background(), team.ID, func(tx *TeamTx) error {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := tx.AdminCount(ctx)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled admin count: %v", err)
	}
}
