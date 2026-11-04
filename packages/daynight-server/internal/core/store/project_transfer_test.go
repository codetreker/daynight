package store

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestTransferCommitResponseLossRemainsUnknown(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, actor, _ := testAuthRecords(t, s)
	_, other, _ := testAuthRecords(t, s)
	project, err := s.CreatePrivateProject(ctx, actor, uuid.NewString(), "Project", "host:repo")
	if err != nil {
		t.Fatal(err)
	}
	target, err := s.CreateTeam(ctx, other.UserID, uuid.NewString(), "Target")
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
		owner, err := tx.LockTransferOwnership(ctx)
		if err != nil {
			return err
		}
		if _, _, err = tx.LockTransferTeams(ctx, owner.TeamID, target.ID); err != nil {
			return err
		}
		_, err = tx.MoveOwnership(ctx, target.ID)
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
	err = s.ReadSnapshot(ctx, func(snapshot *Snapshot) error { _, err := snapshot.ProjectAccess(ctx, actor, project.ID); return err })
	if !errors.Is(err, core.ErrNotFound) {
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
	team, err := s.CreateTeam(ctx, other.UserID, uuid.NewString(), "Destination")
	if err != nil {
		t.Fatal(err)
	}
	read := func() *core.ProjectRole {
		t.Helper()
		var role *core.ProjectRole
		err := s.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
			var err error
			role, err = snapshot.TransferRole(ctx, actor.UserID, project.ID, team.ID)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return role
	}
	if got := read(); got == nil || *got != core.ProjectAdmin {
		t.Fatalf("direct admin: %v", got)
	}
	if _, err = s.Pool.Exec(ctx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, project.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if got := read(); got == nil || *got != core.ProjectMemberRole {
		t.Fatalf("direct member: %v", got)
	}
	if _, err = s.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if got := read(); got == nil || *got != core.ProjectAdmin {
		t.Fatalf("inherited admin: %v", got)
	}
	if _, err = s.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if got := read(); got == nil || *got != core.ProjectAdmin {
		t.Fatalf("inherited only: %v", got)
	}
	if _, err = s.Pool.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != nil {
		t.Fatalf("no access: %v", got)
	}
}
