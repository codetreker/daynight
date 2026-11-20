package github_test

import (
	"errors"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestGrantWriteAdmissionUsesLockedFactsAndDenialDoesNotWrite(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	app, teamID, grant := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'Team')`, []any{teamID}},
		{`INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,91,'App','Remote','remote','key','secret')`, []any{app}},
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, []any{app, actor}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	p := model.Principal{Kind: model.PATCredential, UserID: actor, CredentialID: uuid.NewString()}
	in := core.CreateGrantInput{ID: grant, TeamID: teamID, ExpectedUserID: actor, Version: 1, TeamVersion: 1}
	denied := errors.New("scope denied")
	c, err := db.WriteGitHubGrant(ctx, teamID, app, actor, func(w store.GitHubGrantWriteDAO) error {
		v, ok := w.(store.GitHubGrantWriteAdmissionDAO)
		if !ok {
			t.Fatal("missing admission capability")
		}
		facts, err := v.GrantWriteAdmission(ctx, actor)
		if err != nil || facts.TeamID != teamID || facts.TeamVersion != 1 || facts.AppVersion != 1 || facts.ImpactVersion != 1 || !facts.IsAdmin {
			t.Fatalf("facts: %+v %v", facts, err)
		}
		if err := v.RequireLiveGrant(ctx, grant); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing grant: %v", err)
		}
		_, err = core.CreateGrantWithAdmission(ctx, w, p, in, func() error { return denied })
		return err
	})
	if !errors.Is(err, denied) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("denial: %+v %v", c, err)
	}
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM github_app_team_grants WHERE id=$1`, grant).Scan(&count); err != nil || count != 0 {
		t.Fatalf("grant persisted: %d %v", count, err)
	}
	c, err = db.WriteGitHubGrant(ctx, teamID, app, actor, func(w store.GitHubGrantWriteDAO) error {
		_, err := core.CreateGrantWithAdmission(ctx, w, p, in, func() error { return nil })
		return err
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("create: %+v %v", c, err)
	}
	c, err = db.WriteGitHubGrant(ctx, teamID, app, actor, func(w store.GitHubGrantWriteDAO) error {
		v := w.(store.GitHubGrantWriteAdmissionDAO)
		if err := v.RequireLiveGrant(ctx, grant); err != nil {
			t.Fatal(err)
		}
		return core.RevokeGrantWithAdmission(ctx, w, p, grant, core.RevokeGrantInput{ExpectedUserID: actor, Version: 1, ImpactVersion: 2}, func() error { return denied })
	})
	if !errors.Is(err, denied) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("revoke denial: %+v %v", c, err)
	}
	var live bool
	if err := db.Pool.QueryRow(ctx, `SELECT revoked_at IS NULL FROM github_app_team_grants WHERE id=$1`, grant).Scan(&live); err != nil || !live {
		t.Fatalf("grant revoked: %v %v", live, err)
	}
}
