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
}
