package team_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTeamSnapshotsPaginateJoinedMembershipsAndPreciseMetadata(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	ctx := context.Background()
	_, actor, _ := testutil.AuthRecords(t, s)
	raw := " \t研发😀\u2003 " + strings.Repeat("x", 180)
	first, err := testutil.CreateTeam(ctx, s, actor.UserID, uuid.NewString(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if first.Kind != "ordinary" || first.Name == nil || *first.Name != raw || first.Version != 1 || first.Membership.TeamID != first.ID || first.Membership.UserID != actor.UserID || first.Membership.Role != model.ProjectAdmin || first.Membership.Version < 1 || first.CreatedAt.IsZero() || !first.CreatedAt.Equal(first.UpdatedAt) || first.Membership.CreatedAt.IsZero() || !first.Membership.CreatedAt.Equal(first.Membership.UpdatedAt) {
		t.Fatalf("incomplete raw Team metadata: %#v", first)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		got, err := snapshot.TeamDAO().Team(ctx, actor.UserID, first.ID)
		if err == nil && !reflect.DeepEqual(got, first) {
			t.Fatalf("Team creation and read differ: %#v %#v", first, got)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	_, other, _ := testutil.AuthRecords(t, s)
	if _, err := testutil.CreateTeam(ctx, s, other.UserID, uuid.NewString(), "An invisible Team between visible rows"); err != nil {
		t.Fatal(err)
	}
	second, err := testutil.CreateTeam(ctx, s, actor.UserID, uuid.NewString(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID == first.ID || second.Name == nil || *second.Name != raw {
		t.Fatalf("duplicate raw name resolved an existing Team: %#v %#v", first, second)
	}
	const metadataVersion int64 = 9007199254740993
	const memberVersion int64 = 9007199254740995
	testutil.MustExec(t, s.Pool, `UPDATE teams SET version=$2 WHERE id=$1`, first.ID, metadataVersion)
	testutil.MustExec(t, s.Pool, `UPDATE team_members SET version=$3 WHERE team_id=$1 AND user_id=$2`, first.ID, actor.UserID, memberVersion)
	var ids []string
	var page Page
	page.Limit = 1
	for {
		var result TeamPage
		if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			var err error
			result, err = snapshot.TeamDAO().Teams(ctx, actor.UserID, page)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if result.Items == nil || len(result.Items) != 1 {
			t.Fatalf("membership-filtered page %#v", result)
		}
		team := result.Items[0]
		if team.Membership.UserID != actor.UserID || team.Membership.TeamID != team.ID {
			t.Fatalf("wrong actor membership %#v", team)
		}
		if team.ID == first.ID && (team.Version != metadataVersion || team.Membership.Version != memberVersion) {
			t.Fatalf("rounded versions %#v", team)
		}
		if (team.ID == first.ID || team.ID == second.ID) && (team.Name == nil || *team.Name != raw) {
			t.Fatalf("joined page changed raw Team name: %#v", team)
		}
		if len(ids) == 0 && (team.Kind != "personal" || team.Name != nil || team.Membership.Role != model.ProjectAdmin) {
			t.Fatalf("Personal projection %#v", team)
		}
		ids = append(ids, team.ID)
		page.After = &Position{CreatedAt: team.CreatedAt, ID: team.ID}
		if !result.HasMore {
			break
		}
	}
	if len(ids) != 3 || ids[1] != first.ID || ids[2] != second.ID {
		t.Fatalf("joined list pagination/order %#v", ids)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		last, err := snapshot.TeamDAO().Teams(ctx, actor.UserID, page)
		if err == nil && (last.Items == nil || len(last.Items) != 0 || last.HasMore) {
			t.Fatalf("empty final page %#v", last)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTeamSnapshotAbsenceAndCancellation(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	actor, team := testutil.TeamFixture(t, s)
	ctx := context.Background()
	_, outsider, _ := testutil.AuthRecords(t, s)
	for _, target := range []struct{ userID, teamID string }{{outsider.UserID, team.ID}, {actor.UserID, uuid.NewString()}} {
		err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			_, err := snapshot.TeamDAO().Team(ctx, target.userID, target.teamID)
			return err
		})
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing Team membership cause %v", err)
		}
	}
	err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		_, err := snapshot.TeamDAO().Teams(canceled, actor.UserID, Page{Limit: 1})
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled list cause was lost %v", err)
	}
	testutil.MustExec(t, s.Pool, `DROP TABLE teams`)
	var page TeamPage
	err = s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var err error
		page, err = snapshot.TeamDAO().Teams(ctx, actor.UserID, Page{Limit: 10})
		return err
	})
	var database *pgconn.PgError
	if !errors.As(err, &database) || database.Code != "42P01" || len(page.Items) != 0 || page.HasMore {
		t.Fatalf("missing Team table became an empty successful page: %#v %v", page, err)
	}
}

func TestTeamOwnershipCheckDoesNotLockProject(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	actor, team := testutil.TeamFixture(t, s)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	project, err := testutil.CreatePrivateProject(ctx, s, actor, uuid.NewString(), "Existing", "host:repo")
	if err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, s.Pool, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, team.ID)
	holder, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err := holder.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
		t.Fatal(err)
	}
	bounded, finish := context.WithTimeout(ctx, time.Second)
	defer finish()
	err = testutil.WriteTeam(bounded, s, team.ID, func(tx TeamWriteDAO) error {
		found, err := tx.HasProjects(bounded)
		if err == nil && !found {
			return errors.New("ownership disappeared")
		}
		return err
	})
	if err != nil {
		t.Fatalf("Team-only check waited for existing Project lock %v", err)
	}
}
