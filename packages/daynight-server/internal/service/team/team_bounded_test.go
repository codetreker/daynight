package team_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestBoundedTeamReadsAndWrites(t *testing.T) {
	_, db, _, actor := projectService(t)
	teams := teamservice.NewTeams(db)
	ctx := context.Background()
	initial := newTestTeam(t, teams, actor, "Before")
	name := strings.Repeat("<", (1<<20)-100)
	// Existing rows may predate the admission limit.
	if _, err := db.Pool.Exec(ctx, `UPDATE teams SET name=$2,version=version+1 WHERE id=$1`, initial.ID, name); err != nil {
		t.Fatal(err)
	}
	got, err := teams.GetBounded(ctx, actor, initial.ID, 1<<20)
	if err != nil || got.Name == nil || *got.Name != name {
		t.Fatalf("valid large read: %v", err)
	}
	// Legacy data can exceed request limits. The SQL projection rejects it before
	// materializing text, while normal REST service access remains unchanged.
	if _, err := db.Pool.Exec(ctx, `UPDATE teams SET name=repeat('x',$2),version=version+1 WHERE id=$1`, initial.ID, (1<<20)+1); err != nil {
		t.Fatal(err)
	}
	_, err = teams.GetBounded(ctx, actor, initial.ID, 1<<20)
	teamFault(t, err, "payload_too_large")
	full, err := teams.Get(ctx, actor, initial.ID)
	if err != nil || len(*full.Name) != (1<<20)+1 {
		t.Fatalf("full read changed: %v", err)
	}
	_, err = teams.RenameBounded(ctx, actor, initial.ID, coreteam.ChangeTeam{Name: "After", Version: full.Version, ExpectedUserID: actor.UserID}, 1<<20)
	teamFault(t, err, "payload_too_large")
	member, err := teams.Member(ctx, actor, initial.ID, actor.UserID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = teams.MembersPage(ctx, actor, initial.ID, model.PageRequest{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = teams.RemoveMemberBounded(ctx, actor, initial.ID, actor.UserID, coreteam.ChangeTeamMember{Version: member.Version, ExpectedUserID: actor.UserID}, 1<<20)
	teamFault(t, err, "payload_too_large")
	outsider := servicePrincipal(t, db)
	_, err = teams.GetBounded(ctx, outsider, initial.ID, 1<<20)
	teamFault(t, err, "not_found")
	_, err = teams.Member(ctx, outsider, initial.ID, actor.UserID)
	teamFault(t, err, "not_found")
	if err := teams.Delete(ctx, actor, initial.ID, coreteam.ChangeTeam{Name: *full.Name, Version: full.Version, ExpectedUserID: actor.UserID}); err != nil {
		t.Fatalf("legacy exact-name deletion: %v", err)
	}
	_, err = teams.Get(ctx, actor, initial.ID)
	teamFault(t, err, "not_found")
}

func TestBoundedTeamsStopBeforeOversizedItem(t *testing.T) {
	_, db, _, actor := projectService(t)
	teams := teamservice.NewTeams(db)
	ctx := context.Background()
	team := newTestTeam(t, teams, actor, "Oversized")
	if _, err := db.Pool.Exec(ctx, `UPDATE teams SET name=repeat('x',20000) WHERE id=$1`, team.ID); err != nil {
		t.Fatal(err)
	}
	page, err := teams.ListBounded(ctx, actor, model.PageRequest{Limit: 100}, 16<<10)
	if err != nil || len(page.Items) != 1 || page.NextCursor == nil {
		t.Fatalf("prefix: %#v %v", page, err)
	}
	_, err = teams.ListBounded(ctx, actor, model.PageRequest{Limit: 100, Cursor: page.NextCursor}, 16<<10)
	teamFault(t, err, "payload_too_large")
	if !strings.Contains(err.Error(), team.ID) {
		t.Fatalf("missing Team ID: %v", err)
	}
	full, err := teams.List(ctx, actor, model.PageRequest{Limit: 100})
	if err != nil || len(full.Items) != 2 {
		t.Fatalf("REST list changed: %#v %v", full, err)
	}
}

func TestPersonalTeamIDDoesNotReadProfile(t *testing.T) {
	_, db, _, actor := projectService(t)
	ctx := context.Background()
	if _, err := db.Pool.Exec(ctx, `UPDATE users SET name=repeat('x',$2),email=repeat('y',$2) WHERE id=$1`, actor.UserID, 2<<20); err != nil {
		t.Fatal(err)
	}
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

func TestBoundedWritesRecheckActorAfterLockWait(t *testing.T) {
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
				pre, err := teams.GetBounded(ctx, actor, team.ID, 1<<20)
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
						_, writeErr = teams.RenameBounded(ctx, actor, team.ID, coreteam.ChangeTeam{Name: "Changed", Version: pre.Version, ExpectedUserID: actor.UserID}, 1<<20)
					case "delete":
						writeErr = teams.DeleteBounded(ctx, actor, team.ID, coreteam.ChangeTeam{Name: "Original", Version: pre.Version, ExpectedUserID: actor.UserID}, 1<<20)
					case "set_role":
						_, writeErr = teams.SetMemberRoleBounded(ctx, actor, team.ID, target.UserID, coreteam.ChangeTeamMember{Version: member.Version, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID}, 1<<20)
					case "remove":
						_, writeErr = teams.RemoveMemberBounded(ctx, actor, team.ID, target.UserID, coreteam.ChangeTeamMember{Version: member.Version, ExpectedUserID: actor.UserID}, 1<<20)
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

func TestBoundedTeamsQueryFailureIsNotAnEmptyPage(t *testing.T) {
	_, db, _, actor := projectService(t)
	teams := teamservice.NewTeams(db)
	if _, err := db.Pool.Exec(context.Background(), `DROP TABLE teams`); err != nil {
		t.Fatal(err)
	}
	page, err := teams.ListBounded(context.Background(), actor, model.PageRequest{Limit: 10}, 16<<10)
	var pgErr *pgconn.PgError
	if err == nil || !errors.As(err, &pgErr) || pgErr.Code != "42P01" || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("database failure became page: %#v %v", page, err)
	}
}
