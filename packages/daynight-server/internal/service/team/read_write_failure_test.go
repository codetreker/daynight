package team_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestPersonalTeamIDRequiresOwnerMembership(t *testing.T) {
	_, db, _, actor := projectService(t)
	ctx := context.Background()
	identity := identityservice.New(db, nil, "")
	id, err := identity.PersonalTeamID(ctx, actor)
	if err != nil || id == "" {
		t.Fatalf("personal team id %q: %v", id, err)
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := identity.PersonalTeamID(ctx, actor); err == nil {
		t.Fatal("invalid personal membership accepted")
	}
}

func TestWritesRecheckActorAfterLockWait(t *testing.T) {
	for _, operation := range []string{"rename", "delete", "set_role", "remove"} {
		for _, change := range []string{"demote", "remove"} {
			t.Run(operation+"/"+change, func(t *testing.T) {
				_, db, _, actor := projectService(t)
				teams := teamservice.NewTeams(db)
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				otherAdmin := servicePrincipal(t, db)
				target := servicePrincipal(t, db)
				team := newTestTeam(t, teams, actor, "Original")
				if _, err := db.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')`, team.ID, otherAdmin.UserID, target.UserID); err != nil {
					t.Fatal(err)
				}
				pre, err := teams.Get(ctx, actor, team.ID)
				if err != nil {
					t.Fatal(err)
				}
				member, err := teams.Member(ctx, actor, team.ID, target.UserID)
				if err != nil {
					t.Fatal(err)
				}
				blocker, err := db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer blocker.Rollback(context.Background())
				if _, err = blocker.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
					t.Fatal(err)
				}
				result := make(chan error, 1)
				go func() {
					var writeErr error
					switch operation {
					case "rename":
						_, writeErr = teams.Rename(ctx, actor, team.ID, coreteam.ChangeTeam{Name: "Changed", Version: pre.Version, ExpectedUserID: actor.UserID})
					case "delete":
						writeErr = teams.Delete(ctx, actor, team.ID, coreteam.ChangeTeam{Name: "Original", Version: pre.Version, ExpectedUserID: actor.UserID})
					case "set_role":
						_, writeErr = teams.SetMemberRole(ctx, actor, team.ID, target.UserID, coreteam.ChangeTeamMember{Version: member.Version, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID})
					case "remove":
						_, writeErr = teams.RemoveMember(ctx, actor, team.ID, target.UserID, coreteam.ChangeTeamMember{Version: member.Version, ExpectedUserID: actor.UserID})
					}
					result <- writeErr
				}()
				for {
					var waiting bool
					if e := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker.Conn().PgConn().PID()).Scan(&waiting); e != nil {
						t.Fatal(e)
					}
					if waiting {
						break
					}
					select {
					case <-ctx.Done():
						t.Fatal("write did not wait")
					case <-time.After(5 * time.Millisecond):
					}
				}
				if change == "demote" {
					_, err = blocker.Exec(ctx, `UPDATE team_members SET role='member',version=nextval('team_member_versions') WHERE team_id=$1 AND user_id=$2`, team.ID, actor.UserID)
				} else {
					_, err = blocker.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, actor.UserID)
				}
				if err != nil {
					t.Fatal(err)
				}
				if err = blocker.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case got := <-result:
					if change == "demote" {
						teamFault(t, got, "forbidden")
					} else {
						teamFault(t, got, "not_found")
					}
				case <-ctx.Done():
					t.Fatal("write did not finish")
				}
				after, err := teams.Get(ctx, otherAdmin, team.ID)
				if err != nil || after.Name == nil || *after.Name != "Original" || after.Version != pre.Version {
					t.Fatalf("Team changed: %#v %v", after, err)
				}
				afterMember, err := teams.Member(ctx, otherAdmin, team.ID, target.UserID)
				if err != nil || afterMember.Role != member.Role || afterMember.Version != member.Version {
					t.Fatalf("member changed: %#v %v", afterMember, err)
				}
			})
		}
	}
}

func TestTeamsQueryFailureIsNotAnEmptyPage(t *testing.T) {
	_, db, _, actor := projectService(t)
	teams := teamservice.NewTeams(db)
	if _, err := db.Pool.Exec(context.Background(), `DROP TABLE teams`); err != nil {
		t.Fatal(err)
	}
	page, err := teams.List(context.Background(), actor, model.PageRequest{Limit: 10})
	var pgErr *pgconn.PgError
	if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "42P01" || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("database failure became page: %#v %v", page, err)
	}
}
