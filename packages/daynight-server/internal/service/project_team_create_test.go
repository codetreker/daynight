package service

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

func TestCreateProjectTeamAndIdentity(t *testing.T) {
	projects, db, _, admin := projectService(t)
	ctx := context.Background()
	member, outsider := servicePrincipal(t, db), servicePrincipal(t, db)
	team := newTestTeam(t, NewTeams(db), admin, "Team")
	var personalTeam string
	if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`, admin.UserID).Scan(&personalTeam); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, member.UserID); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		actor core.Principal
		team  *string
		repo  string
		role  core.ProjectRole
	}{
		{admin, &team.ID, "https://example.com/Org/Repo.git", core.ProjectAdmin},
		{member, &team.ID, "ssh://git@example.com:2222/Org/Repo.git", core.ProjectMemberRole},
		{admin, nil, "git@example.com:Org/Repo.git", core.ProjectAdmin},
		{admin, &personalTeam, "git@example.com:Org/Repo.git", core.ProjectAdmin},
	} {
		project, access, err := projects.CreateWithAccess(ctx, test.actor, CreateProject{Name: "  原始 name  ", RepoURL: test.repo, TeamID: test.team, ExpectedUserID: test.actor.UserID})
		if err != nil {
			t.Fatal(err)
		}
		if project.Name != "  原始 name  " || project.RepoURL != test.repo || access.ProjectID != project.ID || access.Role != core.ProjectAdmin || access.DirectGrant == nil || access.DirectGrant.UserID != test.actor.UserID || access.DirectGrant.Role != core.ProjectAdmin || access.TeamRole == nil || *access.TeamRole != test.role || access.Ownership.TeamID != project.Ownership.TeamID || (test.team != nil && project.Ownership.TeamID != *test.team) {
			t.Fatalf("project/access mismatch %#v %#v", project, access)
		}
	}
	snapshot := func() string {
		var state string
		err := db.Pool.QueryRow(ctx, `SELECT jsonb_build_object('teams',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM teams t),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY team_id,user_id) FROM team_members m),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'ownership',(SELECT jsonb_agg(to_jsonb(o) ORDER BY project_id) FROM project_ownership o),'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY project_id,user_id) FROM project_grants g))::text`).Scan(&state)
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := snapshot()
	_, err := projects.Create(ctx, outsider, CreateProject{Name: "Refused", RepoURL: "host:repo", TeamID: &team.ID, ExpectedUserID: outsider.UserID})
	if !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("non-member: %v", err)
	}
	_, err = NewProjects(nil).Create(ctx, admin, CreateProject{Name: "Mismatch", RepoURL: "host:repo", ExpectedUserID: outsider.UserID})
	requireFault(t, err, "identity_mismatch")
	for _, target := range []string{"bad", uuid.NewString()} {
		_, err := projects.Create(ctx, admin, CreateProject{Name: "Refused", RepoURL: "host:repo", TeamID: &target, ExpectedUserID: admin.UserID})
		if target == "bad" {
			requireFault(t, err, "invalid_input")
		} else if !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("missing Team: %v", err)
		}
	}
	if after := snapshot(); before != after {
		t.Fatal("rejected writes changed domain rows or versions")
	}
}
