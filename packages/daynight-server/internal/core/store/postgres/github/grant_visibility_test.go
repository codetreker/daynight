package github_test

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
)

func TestGrantAndImpactVisibilitySnapshots(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	app, teamID, grant, outsider := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	queries := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'Team')`, []any{teamID}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{teamID, actor}},
		{`INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,91,'App','Remote','remote','key','secret')`, []any{app}},
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, []any{app, actor}},
		{`INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, []any{grant, app, teamID}},
	}
	for _, q := range queries {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.ReadGitHubGrants(ctx, func(d store.GitHubGrantReadDAO) error {
		v, ok := d.(store.GitHubGrantVisibilityDAO)
		if !ok {
			t.Fatal("visibility capability missing")
		}
		for _, tc := range []struct {
			app, actor, team, grant string
			teamOnly, visible       bool
		}{
			{app, actor, "", "", false, true}, {app, actor, teamID, "", false, true}, {app, actor, "", grant, false, true},
			{"", actor, teamID, "", true, true}, {app, outsider, "", "", false, false},
			{app, actor, uuid.NewString(), "", false, false}, {app, actor, "", uuid.NewString(), false, false},
			{"", outsider, teamID, "", true, false},
		} {
			err := v.GrantVisibility(ctx, tc.app, tc.actor, tc.team, tc.grant, tc.teamOnly)
			if tc.visible && err != nil || !tc.visible && !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("visibility %+v: %v", tc, err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) error {
		v, ok := d.(store.GitHubAppImpactVisibilityDAO)
		if !ok {
			t.Fatal("impact capability missing")
		}
		facts, err := v.ImpactVisibility(ctx, store.GitHubAppImpactQuery{AppID: app, ActorID: actor, GrantID: &grant})
		if err != nil || facts.Version < 1 || facts.GrantMissing || facts.TotalProjects != 0 {
			t.Fatalf("facts %+v %v", facts, err)
		}
		missing := uuid.NewString()
		facts, err = v.ImpactVisibility(ctx, store.GitHubAppImpactQuery{AppID: app, ActorID: actor, GrantID: &missing})
		if err != nil || !facts.GrantMissing {
			t.Fatalf("missing %+v %v", facts, err)
		}
		_, err = v.ImpactVisibility(ctx, store.GitHubAppImpactQuery{AppID: app, ActorID: outsider})
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("outsider %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, grant); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubGrants(ctx, func(d store.GitHubGrantReadDAO) error {
		return d.(store.GitHubGrantVisibilityDAO).GrantVisibility(ctx, app, actor, "", grant, false)
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("revoked grant visibility: %v", err)
	}
	if err := db.ReadGitHubAppImpact(ctx, func(d store.GitHubAppImpactDAO) error {
		facts, err := d.(store.GitHubAppImpactVisibilityDAO).ImpactVisibility(ctx, store.GitHubAppImpactQuery{AppID: app, ActorID: actor, GrantID: &grant})
		if err != nil {
			return err
		}
		if !facts.GrantMissing {
			t.Fatal("revoked grant was visible")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

}

func TestGrantWriteAdmissionPropagatesMissingRoots(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	teamID := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'Team')`, teamID); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, tc := range []struct{ team, app string }{{uuid.NewString(), uuid.NewString()}, {teamID, uuid.NewString()}} {
		w := github.NewGrantWriter(tx, tc.team, tc.app)
		admission, ok := w.(store.GitHubGrantWriteAdmissionDAO)
		if !ok {
			t.Fatal("missing admission capability")
		}
		_, err := admission.GrantWriteAdmission(ctx, actor)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing root team=%s: %v", tc.team, err)
		}
	}
}
