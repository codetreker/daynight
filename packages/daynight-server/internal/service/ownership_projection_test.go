package service

import (
	"context"
	"strings"
	"sync"
	"testing"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestMembersAndActorAccessShareSnapshotAcrossSourceChange(t *testing.T) {
	f := newMembershipFixture(t)
	actor := f.user(t)
	project := f.project(t, actor, "Snapshot source")
	teamID := uuid.NewString()
	ctx := context.Background()
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'Snapshot owner')`, []any{teamID}},
		{`UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, []any{project.ID, teamID}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{teamID, actor.UserID}},
		{`DELETE FROM project_grants WHERE project_id=$1`, []any{project.ID}},
	} {
		if _, err := f.database.Pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	var once sync.Once
	var changed error
	traced := tracedTasks(t, f.database.Pool.Config().ConnString(), taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "FROM projects p LEFT JOIN project_ownership") }, end: func() {
		once.Do(func() {
			_, changed = f.database.Pool.Exec(ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, teamID, actor.UserID)
		})
	}})
	result, err := projectservice.NewMemberships(traced.store).ListWithAccess(ctx, actor, project.ID)
	if changed != nil || err != nil || result.ActorAccess.Role != model.ProjectAdmin || !result.ActorAccess.CanTransfer || result.ActorAccess.DirectGrant != nil || result.ActorAccess.TeamRole == nil || *result.ActorAccess.TeamRole != model.ProjectAdmin || len(result.Items) != 1 || result.Items[0].EffectiveRole != model.ProjectAdmin || result.Items[0].InheritedFrom == nil || result.Items[0].InheritedFrom.Role != model.ProjectAdmin {
		t.Fatalf("mixed snapshot: %#v changed=%v err=%v", result, changed, err)
	}
	after, err := f.projects.Access(ctx, actor, project.ID)
	if err != nil || after.Role != model.ProjectMemberRole || after.CanTransfer {
		t.Fatalf("new snapshot failed to observe downgrade: %#v %v", after, err)
	}
}

func TestProjectAndAccessShareSnapshotAcrossOwnershipChange(t *testing.T) {
	projects, database, databaseURL, actor := projectService(t)
	ctx := context.Background()
	project, err := projects.Create(ctx, actor, coreproject.CreateProject{ExpectedUserID: actor.UserID, Name: "Ownership snapshot", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	newTeam := uuid.NewString()
	if _, err := database.Pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'New owner')`, newTeam); err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	var changed error
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "FROM projects p LEFT JOIN project_ownership") }, end: func() {
		once.Do(func() {
			_, changed = database.Pool.Exec(ctx, `UPDATE project_ownership SET team_id=$2,version=9007199254740993 WHERE project_id=$1`, project.ID, newTeam)
		})
	}})
	got, access, err := projectservice.NewProjects(traced.store).GetWithAccess(ctx, actor, project.ID)
	if changed != nil || err != nil || got.Ownership != project.Ownership || access.Ownership != got.Ownership || access.OwnerTeam.ID != project.Ownership.TeamID || access.OwnerTeam.Kind != "personal" {
		t.Fatalf("mixed Project/access snapshot: %#v %#v changed=%v err=%v", got, access, changed, err)
	}
	after, current, err := projects.GetWithAccess(ctx, actor, project.ID)
	if err != nil || after.Ownership.TeamID != newTeam || after.Ownership.Version != 9007199254740993 || current.OwnerTeam.ID != newTeam || current.OwnerTeam.Kind != "ordinary" || current.TeamRole != nil || current.CanTransfer || current.DirectGrant == nil {
		t.Fatalf("new ownership not observed: %#v %#v %v", after, current, err)
	}
}
