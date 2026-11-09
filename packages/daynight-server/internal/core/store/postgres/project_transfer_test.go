package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTransferUpdateFailureRollsBackOwnershipAndProject(t *testing.T) {
	for _, table := range []string{"project_ownership", "projects"} {
		t.Run(table, func(t *testing.T) {
			s, actor, _, project := membershipFixture(t)
			ctx := context.Background()
			target, err := testCreateTeam(s, ctx, actor.UserID, uuid.NewString(), "Target")
			if err != nil {
				t.Fatal(err)
			}
			var beforeUpdated time.Time
			if err := s.Pool.QueryRow(ctx, `SELECT updated_at FROM projects WHERE id=$1`, project.ID).Scan(&beforeUpdated); err != nil {
				t.Fatal(err)
			}
			mustQueryExec(t, s, `CREATE FUNCTION refuse_transfer_update() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='transfer update rejected'; END $$;
 CREATE TRIGGER refuse_transfer_update BEFORE UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_transfer_update()`)
			err = writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
				if _, err := tx.ProjectDAO().LockTransferOwnership(ctx); err != nil {
					return err
				}
				_, err := tx.ProjectDAO().MoveOwnership(ctx, target.ID)
				return err
			})
			var postgres *pgconn.PgError
			if !errors.As(err, &postgres) || postgres.Code != "P0001" {
				t.Fatalf("database rejection was lost: %v", err)
			}
			var owner string
			var version int64
			var updated time.Time
			if err := s.Pool.QueryRow(ctx, `SELECT o.team_id::text,o.version,p.updated_at FROM project_ownership o
 JOIN projects p ON p.id=o.project_id WHERE p.id=$1`, project.ID).Scan(&owner, &version, &updated); err != nil {
				t.Fatal(err)
			}
			if owner != project.Ownership.TeamID || version != project.Ownership.Version || !updated.Equal(beforeUpdated) {
				t.Fatalf("failed transfer committed partial state: owner=%s version=%d updated=%s", owner, version, updated)
			}
		})
	}
}

func TestTransferCommitResponseLossRemainsUnknown(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, actor, _ := testAuthRecords(t, s)
	_, other, _ := testAuthRecords(t, s)
	project, err := s.CreatePrivateProject(ctx, actor, uuid.NewString(), "Project", "host:repo")
	if err != nil {
		t.Fatal(err)
	}
	target, err := testCreateTeam(s, ctx, other.UserID, uuid.NewString(), "Target")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	raw, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("commit response lost")
	err = transact(ctx, &threadCommitResponseLoss{Tx: raw, cause: lost}, func(raw pgx.Tx) error {
		var id string
		if err := raw.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 FOR UPDATE`, project.ID).Scan(&id); err != nil {
			return err
		}
		tx := &ProjectTx{tx: raw, projectID: project.ID}
		owner, err := tx.ProjectDAO().LockTransferOwnership(ctx)
		if err != nil {
			return err
		}
		if _, _, err = tx.ProjectDAO().LockTransferTeams(ctx, owner.TeamID, target.ID); err != nil {
			return err
		}
		_, err = tx.ProjectDAO().MoveOwnership(ctx, target.ID)
		return err
	})
	var failure *TransactionError
	if !errors.As(err, &failure) || !failure.CommitAttempted || failure.Outcome != TransactionUnknown || !errors.Is(err, lost) {
		t.Fatalf("lost COMMIT result: %#v %v", failure, err)
	}
	var actual string
	var version int64
	if err = s.Pool.QueryRow(ctx, `SELECT team_id::text,version FROM project_ownership WHERE project_id=$1`, project.ID).Scan(&actual, &version); err != nil || actual != target.ID || version != project.Ownership.Version+1 {
		t.Fatalf("committed owner %s %d %v", actual, version, err)
	}
	err = s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.ProjectDAO().ProjectAccess(ctx, actor, project.ID)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("actor retained access: %v", err)
	}
}
