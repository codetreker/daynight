package team_test

import (
	"context"
	"math"
	"strings"
	"testing"

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
	rename := func(actorID string, who int, version int64) error {
		actor := admin
		if who == 1 {
			actor = member
		} else if who == 2 {
			actor = outsider
		}
		change := coreteam.ChangeTeam{Name: name, Version: version, ExpectedUserID: actorID}
		_, err := teams.Rename(ctx, actor, team.ID, change)
		return err
	}
	teamFault(t, rename(admin.UserID, 0, team.Version+1), "version_conflict")
	teamFault(t, rename(member.UserID, 1, team.Version), "forbidden")
	teamFault(t, rename(outsider.UserID, 2, team.Version), "not_found")
	teamFault(t, rename(outsider.UserID, 0, team.Version), "identity_mismatch")
	teamFault(t, rename(admin.UserID, 0, team.Version), "invalid_input")
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
	got, err = teams.Get(ctx, admin, team.ID)
	if err != nil || got.Name == nil || *got.Name != "Original" || got.Version != math.MaxInt64 {
		t.Fatalf("exhausted rename changed Team: %#v %v", got, err)
	}
}
