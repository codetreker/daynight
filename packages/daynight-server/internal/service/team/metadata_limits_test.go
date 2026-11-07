package team_test

import (
	"context"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

func TestRenameMetadataLimitPreservesAuthorizationAndVersionPriority(t *testing.T) {
	_, db, _, admin := projectService(t)
	teams := teamservice.NewTeams(db)
	ctx := context.Background()
	team := newTestTeam(t, teams, admin, "Original")
	member, outsider := servicePrincipal(t, db), servicePrincipal(t, db)
	if _, err := db.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, member.UserID); err != nil {
		t.Fatal(err)
	}
	name := strings.Repeat("a", 257)
	for _, bounded := range []bool{false, true} {
		rename := func(actorID string, who int, version int64) error {
			actor := admin
			if who == 1 {
				actor = member
			} else if who == 2 {
				actor = outsider
			}
			change := coreteam.ChangeTeam{Name: name, Version: version, ExpectedUserID: actorID}
			if bounded {
				_, err := teams.RenameBounded(ctx, actor, team.ID, change, 1<<20)
				return err
			}
			_, err := teams.Rename(ctx, actor, team.ID, change)
			return err
		}
		teamFault(t, rename(admin.UserID, 0, team.Version+1), "version_conflict")
		teamFault(t, rename(member.UserID, 1, team.Version), "forbidden")
		teamFault(t, rename(outsider.UserID, 2, team.Version), "not_found")
		teamFault(t, rename(outsider.UserID, 0, team.Version), "identity_mismatch")
		teamFault(t, rename(admin.UserID, 0, team.Version), "invalid_input")
	}
	got, err := teams.Get(ctx, admin, team.ID)
	if err != nil || got.Name == nil || *got.Name != "Original" || got.Version != team.Version {
		t.Fatalf("rejected rename changed Team: %#v %v", got, err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE teams SET version=$2 WHERE id=$1`, team.ID, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	change := coreteam.ChangeTeam{Name: name, Version: math.MaxInt64, ExpectedUserID: admin.UserID}
	_, err = teams.Rename(ctx, admin, team.ID, change)
	teamFault(t, err, "version_exhausted")
	_, err = teams.RenameBounded(ctx, admin, team.ID, change, 1<<20)
	teamFault(t, err, "version_exhausted")
	got, err = teams.Get(ctx, admin, team.ID)
	if err != nil || got.Name == nil || *got.Name != "Original" || got.Version != math.MaxInt64 {
		t.Fatalf("exhausted rename changed Team: %#v %v", got, err)
	}
}

func TestRenameLegacyOverLimitNameNoOp(t *testing.T) {
	_, db, _, admin := projectService(t)
	teams := teamservice.NewTeams(db)
	ctx := context.Background()
	name := strings.Repeat("😀", 256) + "a"
	for _, version := range []int64{7, math.MaxInt64} {
		team := newTestTeam(t, teams, admin, "Original")
		if _, err := db.Pool.Exec(ctx, `UPDATE teams SET name=$2,version=$3 WHERE id=$1`, team.ID, name, version); err != nil {
			t.Fatal(err)
		}
		snapshot := func() string {
			t.Helper()
			var state string
			err := db.Pool.QueryRow(ctx, `SELECT jsonb_build_object('team',(SELECT to_jsonb(t) FROM teams t WHERE id=$1),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY user_id) FROM team_members m WHERE team_id=$1))::text`, team.ID).Scan(&state)
			if err != nil {
				t.Fatal(err)
			}
			return state
		}
		before := snapshot()
		original, err := teams.Get(ctx, admin, team.ID)
		if err != nil {
			t.Fatal(err)
		}
		input := coreteam.ChangeTeam{Name: name, Version: version, ExpectedUserID: admin.UserID}
		for _, bounded := range []bool{false, true} {
			var got model.Team
			if bounded {
				got, err = teams.RenameBounded(ctx, admin, team.ID, input, 1<<20)
			} else {
				got, err = teams.Rename(ctx, admin, team.ID, input)
			}
			if err != nil || !reflect.DeepEqual(got, original) {
				t.Fatalf("version %d bounded %t: got %#v, err %v", version, bounded, got, err)
			}
			if after := snapshot(); after != before {
				t.Fatalf("version %d bounded %t changed stored rows", version, bounded)
			}
		}
	}
}
