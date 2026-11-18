package github_test

import (
	"errors"
	"math"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/google/uuid"
)

func hookPtr[T any](v T) *T { return &v }
func expectHookCode(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("got %v want %s", err, code)
	}
}
func TestProjectWebhookPersistence(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	if _, _, err := f.write(ctx, "connect", 1, nil); err != nil {
		t.Fatal(err)
	}
	m := service.NewProjectWebhookManager(f.db)
	in := core.ProjectWebhookInput{ExpectedUserID: f.p.UserID, Enabled: true, RepositoryID: hookPtr(int64(8)), Secret: hookPtr("a\x00b")}
	out, err := m.Update(ctx, f.p, f.project, in)
	if err != nil || out.Version == nil || *out.Version != 1 {
		t.Fatalf("create %+v %v", out, err)
	}
	credential, err := f.db.ReadGitHubProjectWebhookSecret(ctx, f.project)
	if err != nil || string(credential.Secret) != "a\x00b" {
		t.Fatalf("credential %v %v", credential.Version, err)
	}
	app := service.NewProjectAppManager(f.db, nil, nil)
	_, safe, err := app.GetWithProjectWebhook(ctx, f.p, f.project)
	if err != nil || safe.Version == nil || *safe.Version != 1 {
		t.Fatalf("safe %+v %v", safe, err)
	}
	memberID := uuid.NewString()
	if _, err = f.db.Pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,$1::text,now(),now())`, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, f.team, memberID); err != nil {
		t.Fatal(err)
	}
	member := model.Principal{Kind: model.SessionCredential, UserID: memberID, CredentialID: uuid.NewString()}
	if _, read, e := app.GetWithProjectWebhook(ctx, member, f.project); e != nil || read.Version == nil || *read.Version != 1 {
		t.Fatalf("member read %+v %v", read, e)
	}
	memberInput := in
	memberInput.ExpectedUserID = memberID
	memberInput.Version = out.Version
	memberInput.Enabled = false
	_, err = m.Update(ctx, member, f.project, memberInput)
	expectHookCode(t, err, "forbidden")
	if _, err = f.db.Pool.Exec(ctx, `UPDATE project_github SET hook_last_received_at=now() WHERE project_id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	in.Version = out.Version
	out, err = m.Update(ctx, f.p, f.project, in)
	if err != nil || *out.Version != 1 || out.LastReceivedAt == nil {
		t.Fatalf("same %+v %v", out, err)
	}
	in.Secret = hookPtr("rotated")
	out, err = m.Update(ctx, f.p, f.project, in)
	if err != nil || *out.Version != 2 || out.LastReceivedAt != nil {
		t.Fatalf("rotate %+v %v", out, err)
	}
	_, err = m.Update(ctx, f.p, f.project, in)
	expectHookCode(t, err, "version_conflict")
	in.Version = out.Version
	in.Enabled = false
	in.Secret = nil
	out, err = m.Update(ctx, f.p, f.project, in)
	if err != nil || *out.Version != 3 || out.Enabled {
		t.Fatalf("disable %+v %v", out, err)
	}
	if _, err = f.db.ReadGitHubProjectWebhookSecret(ctx, f.project); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("disabled secret %v", err)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE project_github SET hook_version=$2 WHERE project_id=$1`, f.project, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	in.Version = hookPtr(int64(math.MaxInt64))
	_, err = m.Update(ctx, f.p, f.project, in)
	if err != nil {
		t.Fatalf("max no-op %v", err)
	}
	in.Enabled = true
	_, err = m.Update(ctx, f.p, f.project, in)
	expectHookCode(t, err, "version_exhausted")
	if _, err = f.db.Pool.Exec(ctx, `UPDATE project_github SET hook_version=3,repository_id=999 WHERE project_id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	in.Version = hookPtr(int64(3))
	_, err = m.Update(ctx, f.p, f.project, in)
	expectHookCode(t, err, "github_repository_mismatch")
	if _, err = f.db.Pool.Exec(ctx, `UPDATE project_github SET repository_id=8 WHERE project_id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	rollback := errors.New("abort")
	c, err := f.db.WriteProject(ctx, f.project, func(s store.ProjectWriteScope) error {
		dao := s.(store.GitHubProjectWebhookScope).GitHubProjectWebhookDAO()
		_, e := core.ManageProjectWebhook(ctx, dao, f.p, core.ProjectWebhookInput{ExpectedUserID: f.p.UserID, Version: hookPtr(int64(3)), Enabled: false, Secret: hookPtr("x")})
		if e != nil {
			return e
		}
		return rollback
	})
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, rollback) {
		t.Fatalf("rollback %+v %v", c, err)
	}
	var secret []byte
	if err = f.db.Pool.QueryRow(ctx, `SELECT hook_secret FROM project_github WHERE project_id=$1`, f.project).Scan(&secret); err != nil || string(secret) != "rotated" {
		t.Fatalf("rolled back secret: %q %v", secret, err)
	}
}

func TestProjectWebhookRejectsInvalidPersistedCombinations(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	if _, _, err := f.write(ctx, "connect", 1, nil); err != nil {
		t.Fatal(err)
	}
	app := service.NewProjectAppManager(f.db, nil, nil)
	for _, tc := range []struct{ name, sql string }{
		{"orphan secret", `UPDATE project_github SET hook_version=NULL,hook_repository_id=NULL,hook_enabled=false,hook_secret=''::bytea WHERE project_id=$1`},
		{"missing secret", `UPDATE project_github SET hook_version=1,hook_repository_id=8,hook_enabled=true,hook_secret=NULL WHERE project_id=$1`},
		{"disabled receipt", `UPDATE project_github SET hook_version=1,hook_repository_id=8,hook_enabled=false,hook_secret='x'::bytea,hook_last_received_at=now() WHERE project_id=$1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := f.db.Pool.Exec(ctx, tc.sql, f.project); err != nil {
				t.Fatal(err)
			}
			if _, _, err := app.GetWithProjectWebhook(ctx, f.p, f.project); err == nil {
				t.Fatal("invalid state accepted")
			}
		})
	}
}
