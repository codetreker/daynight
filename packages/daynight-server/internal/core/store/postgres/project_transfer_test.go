package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTransferTeamReadsMinimalMetadataAndPreservesFailures(t *testing.T) {
	s, actor, _, project := membershipFixture(t)
	ctx := context.Background()
	ordinary, err := testCreateTeam(s, ctx, actor.UserID, uuid.NewString(), "Target")
	if err != nil {
		t.Fatal(err)
	}
	err = s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		personal, err := snapshot.ProjectDAO().TransferTeam(ctx, project.Ownership.TeamID)
		if err != nil || personal.Ref.ID != project.Ownership.TeamID || personal.Ref.Kind != "personal" || personal.Ref.Name != nil || personal.Version != 1 {
			t.Fatalf("personal Team: %#v %v", personal, err)
		}
		target, err := snapshot.ProjectDAO().TransferTeam(ctx, ordinary.ID)
		if err != nil || target.Ref.ID != ordinary.ID || target.Ref.Kind != "ordinary" || target.Ref.Name == nil || *target.Ref.Name != "Target" || target.Version != ordinary.Version {
			t.Fatalf("ordinary Team: %#v %v", target, err)
		}
		_, err = snapshot.ProjectDAO().TransferTeam(ctx, uuid.NewString())
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing Team: %v", err)
		}
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		_, err = snapshot.ProjectDAO().TransferTeam(cancelled, ordinary.ID)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled Team lookup: %v", err)
		}
		return nil
	})
	// A canceled query can close the transaction's connection; the lookup's
	// error above is the observable result and the snapshot cleanup may fail.
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatal(err)
	}
}

func TestTransferOwnershipMissingAndCanceledLock(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancelled", true: "missing"}[missing], func(t *testing.T) {
			s, _, _, project := membershipFixture(t)
			ctx := context.Background()
			if missing {
				mustQueryExec(t, s, `DELETE FROM project_ownership WHERE project_id=$1`, project.ID)
			}
			raw, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Rollback(ctx)
			tx := &ProjectTx{tx: raw, projectID: project.ID}
			queryCtx := ctx
			if !missing {
				var cancel context.CancelFunc
				queryCtx, cancel = context.WithCancel(ctx)
				cancel()
			}
			_, err = tx.ProjectDAO().LockTransferOwnership(queryCtx)
			if missing && (err == nil || errors.Is(err, model.ErrNotFound) || !strings.Contains(err.Error(), "ownership is missing")) {
				t.Fatalf("missing ownership must be an integrity failure: %v", err)
			}
			if !missing && !errors.Is(err, context.Canceled) {
				t.Fatalf("lock cancellation lost: %v", err)
			}
		})
	}
}

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

func TestTransferPreviewRoleCombinesDestinationAndDirectGrant(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, actor, _ := testAuthRecords(t, s)
	_, other, _ := testAuthRecords(t, s)
	project, err := s.CreatePrivateProject(ctx, actor, uuid.NewString(), "Project", "host:repo")
	if err != nil {
		t.Fatal(err)
	}
	team, err := testCreateTeam(s, ctx, other.UserID, uuid.NewString(), "Destination")
	if err != nil {
		t.Fatal(err)
	}
	read := func() *model.ProjectRole {
		t.Helper()
		var role *model.ProjectRole
		err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			var err error
			role, err = snapshot.ProjectDAO().TransferRole(ctx, actor.UserID, project.ID, team.ID)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return role
	}
	if got := read(); got == nil || *got != model.ProjectAdmin {
		t.Fatalf("direct admin: %v", got)
	}
	if _, err = s.Pool.Exec(ctx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, project.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if got := read(); got == nil || *got != model.ProjectMemberRole {
		t.Fatalf("direct member: %v", got)
	}
	if _, err = s.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if got := read(); got == nil || *got != model.ProjectAdmin {
		t.Fatalf("inherited admin: %v", got)
	}
	if _, err = s.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if got := read(); got == nil || *got != model.ProjectAdmin {
		t.Fatalf("inherited only: %v", got)
	}
	if _, err = s.Pool.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != nil {
		t.Fatalf("no access: %v", got)
	}
}
