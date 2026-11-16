package github_test

import (
	"errors"
	"testing"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestAppImpactPrivacyPaginationAndVersion(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	app, grant, grant2 := uuid.NewString(), uuid.NewString(), uuid.NewString()
	team1, team2 := "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	projects := []string{"00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012", "00000000-0000-4000-8000-000000000013"}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO github_apps (id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES ($1,1,'app','remote','remote','key','secret')`, app)
	exec(`INSERT INTO github_app_admins (app_resource_id,user_id) VALUES ($1,$2)`, app, actor)
	exec(`INSERT INTO teams (id,name) VALUES ($1,'ordinary')`, team1)
	exec(`INSERT INTO teams (id,personal_user_id) VALUES ($1,$2)`, team2, uuid.NewString())
	exec(`INSERT INTO github_app_team_grants (id,app_resource_id,team_id) VALUES ($1,$2,$3),($4,$2,$5)`, grant, app, team1, grant2, team2)
	for i, id := range projects {
		exec(`INSERT INTO projects (id,name,repo_url) VALUES ($1,$2,$3)`, id, "project", "https://example.test/repo")
		owner, g := team1, grant
		if i == 2 {
			owner, g = team2, grant2
		}
		exec(`INSERT INTO project_ownership (project_id,team_id) VALUES ($1,$2)`, id, owner)
		exec(`INSERT INTO project_github (project_id,enabled,app_resource_id,team_grant_id) VALUES ($1,true,$2,$3)`, id, app, g)
	}
	for _, id := range projects[1:] {
		exec(`INSERT INTO project_grants (project_id,user_id,role) VALUES ($1,$2,'member')`, id, actor)
	}
	p := model.Principal{Kind: model.PATCredential, UserID: actor, CredentialID: uuid.NewString()}
	input := coregithub.AppImpactInput{AppID: app, Limit: 1}
	var first coregithub.AppImpactPage
	if err := db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) (err error) {
		first, err = coregithub.ReadAppImpact(ctx, d, p, input)
		return
	}); err != nil {
		t.Fatal(err)
	}
	if first.TotalProjects != 3 || first.VisibleProjects != 2 || first.HiddenProjects != 1 || len(first.Teams) != 1 || first.Teams[0].Team.ID != team1 || first.Teams[0].Projects != 2 || first.NextCursor == nil {
		t.Fatalf("first team page: %+v", first)
	}
	input.Cursor = *first.NextCursor
	var second coregithub.AppImpactPage
	if err := db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) (err error) {
		second, err = coregithub.ReadAppImpact(ctx, d, p, input)
		return
	}); err != nil {
		t.Fatal(err)
	}
	if len(second.Teams) != 1 || second.Teams[0].Team.ID != team2 || second.Teams[0].Team.Kind != "personal" || second.Teams[0].Team.Name != nil || second.Teams[0].Projects != 1 || second.NextCursor != nil {
		t.Fatalf("second team page: %+v", second)
	}
	input.Cursor = ""
	var pg coregithub.AppImpactProjectsPage
	if err := db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) (err error) {
		pg, err = coregithub.ReadAppImpactProjects(ctx, d, p, input)
		return
	}); err != nil {
		t.Fatal(err)
	}
	if len(pg.Items) != 1 || pg.Items[0].ID != projects[1] || pg.HiddenProjects != 1 || pg.NextCursor == nil {
		t.Fatalf("filtered project page: %+v", pg)
	}
	input.Cursor = *pg.NextCursor
	exec(`DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, projects[2], actor)
	if err := db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) (err error) {
		pg, err = coregithub.ReadAppImpactProjects(ctx, d, p, input)
		return
	}); err != nil {
		t.Fatal(err)
	}
	if len(pg.Items) != 0 || pg.HiddenProjects != 2 || pg.NextCursor != nil {
		t.Fatalf("permission revocation: %+v", pg)
	}
	exec(`UPDATE github_apps SET impact_version=impact_version+1 WHERE id=$1`, app)
	err := db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) error {
		_, err := coregithub.ReadAppImpactProjects(ctx, d, p, input)
		return err
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "impact_changed" {
		t.Fatalf("stale cursor: %v", err)
	}
	input.Cursor = ""
	input.GrantID = &grant
	if err := db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) (err error) {
		first, err = coregithub.ReadAppImpact(ctx, d, p, input)
		return
	}); err != nil {
		t.Fatal(err)
	}
	if first.TotalProjects != 2 || first.VisibleProjects != 1 || first.HiddenProjects != 1 || len(first.Teams) != 1 || first.Teams[0].Team.ID != team1 {
		t.Fatalf("exact grant: %+v", first)
	}
	exec(`INSERT INTO team_members (team_id,user_id,role) VALUES ($1,$2,'member')`, team1, actor)
	if err := db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) (err error) {
		first, err = coregithub.ReadAppImpact(ctx, d, p, input)
		return
	}); err != nil {
		t.Fatal(err)
	}
	if first.VisibleProjects != 2 || first.HiddenProjects != 0 {
		t.Fatalf("owner Team membership access: %+v", first)
	}
	var grantProjects coregithub.AppImpactProjectsPage
	if err := db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) (err error) {
		grantProjects, err = coregithub.ReadAppImpactProjects(ctx, d, p, input)
		return
	}); err != nil || grantProjects.NextCursor == nil {
		t.Fatalf("grant project cursor: %+v %v", grantProjects, err)
	}
	other := p
	other.UserID = uuid.NewString()
	err = db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) error {
		_, err := coregithub.ReadAppImpact(ctx, d, other, input)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("non-admin read: %v", err)
	}
	exec(`UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, grant)
	exec(`UPDATE github_apps SET impact_version=impact_version+1 WHERE id=$1`, app)
	input.Cursor = *grantProjects.NextCursor
	err = db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) error {
		_, err := coregithub.ReadAppImpactProjects(ctx, d, p, input)
		return err
	})
	if !errors.As(err, &fault) || fault.Code != "impact_changed" {
		t.Fatalf("revoked grant cursor: %v", err)
	}
	input.Cursor = ""
	err = db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) error {
		_, err := coregithub.ReadAppImpact(ctx, d, p, input)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("revoked grant: %v", err)
	}
}
