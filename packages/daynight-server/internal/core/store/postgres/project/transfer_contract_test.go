package project_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	pgproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestTransferTeamReadsMinimalMetadataAndPreservesFailures(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	actor, _, project := testutil.ProjectMembershipFixture(t, s)
	ctx := context.Background()
	ordinary, err := testutil.CreateTeam(ctx, s, actor.UserID, uuid.NewString(), "Target")
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
			s := testutil.OpenStore(t, postgres.Open)
			_, _, project := testutil.ProjectMembershipFixture(t, s)
			ctx := context.Background()
			if missing {
				testutil.MustExec(t, s.Pool, `DELETE FROM project_ownership WHERE project_id=$1`, project.ID)
			}
			raw, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Rollback(ctx)
			dao := pgproject.NewWriter(raw, project.ID)
			queryCtx := ctx
			if !missing {
				var cancel context.CancelFunc
				queryCtx, cancel = context.WithCancel(ctx)
				cancel()
			}
			_, err = dao.LockTransferOwnership(queryCtx)
			if missing && (err == nil || errors.Is(err, model.ErrNotFound) || !strings.Contains(err.Error(), "ownership is missing")) {
				t.Fatalf("missing ownership must be an integrity failure: %v", err)
			}
			if !missing && !errors.Is(err, context.Canceled) {
				t.Fatalf("lock cancellation lost: %v", err)
			}
		})
	}
}

func TestTransferPreviewRoleCombinesDestinationAndDirectGrant(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	ctx := context.Background()
	_, actor, _ := testutil.AuthRecords(t, s)
	_, other, _ := testutil.AuthRecords(t, s)
	project, err := testutil.CreatePrivateProject(ctx, s, actor, uuid.NewString(), "Project", "host:repo")
	if err != nil {
		t.Fatal(err)
	}
	team, err := testutil.CreateTeam(ctx, s, other.UserID, uuid.NewString(), "Destination")
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

	t.Run("committed move preserves membership rows", func(t *testing.T) {
		ctx := t.Context()
		testutil.MustExec(t, s.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, other.UserID)
		invite := testutil.ProjectInvitation(project, actor, "transfer-test")
		testutil.MustExec(t, s.Pool, `INSERT INTO project_invitations(id,project_id,created_by,token_hash,created_at,expires_at)
			VALUES($1,$2,$3,$4,$5,$6)`, invite.ID, invite.ProjectID, invite.CreatedBy, invite.TokenHash, invite.CreatedAt, invite.ExpiresAt)
		readMembership := func() (grants, invites string) {
			t.Helper()
			err := s.Pool.QueryRow(ctx, `SELECT
				(SELECT jsonb_agg(to_jsonb(g) ORDER BY user_id)::text FROM project_grants g WHERE project_id=$1),
				(SELECT jsonb_agg(to_jsonb(i) ORDER BY id)::text FROM project_invitations i WHERE project_id=$1)`,
				project.ID).Scan(&grants, &invites)
			if err != nil {
				t.Fatalf("read nonempty grants and invitations: %v", err)
			}
			return grants, invites
		}
		grantsBefore, invitesBefore := readMembership()
		completion, err := s.WriteProject(ctx, project.ID, func(tx ProjectWriteScope) error {
			dao := tx.ProjectDAO()
			owner, err := dao.LockTransferOwnership(ctx)
			if err != nil {
				return err
			}
			if _, _, err := dao.LockTransferTeams(ctx, owner.TeamID, team.ID); err != nil {
				return err
			}
			_, err = dao.MoveOwnership(ctx, team.ID)
			return err
		})
		if err != nil || completion.Outcome != TransactionCommitted {
			t.Fatalf("move did not commit: %#v %v", completion, err)
		}
		var owner string
		var version int64
		err = s.Pool.QueryRow(ctx, `SELECT team_id::text,version FROM project_ownership WHERE project_id=$1`,
			project.ID).Scan(&owner, &version)
		if err != nil || owner != team.ID || version != project.Ownership.Version+1 {
			t.Fatalf("committed ownership: Team %s version %d, error %v", owner, version, err)
		}
		if grants, invites := readMembership(); grants != grantsBefore || invites != invitesBefore {
			t.Fatalf("move changed grants or invitations: grants %s → %s, invitations %s → %s", grantsBefore, grants, invitesBefore, invites)
		}
		err = s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().ProjectAccess(ctx, actor, project.ID)
			return err
		})
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("previous owner retained access after the move: %v", err)
		}
	})
}
