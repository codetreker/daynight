package github_test

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestProjectAppAdmissionFactsAndProjectionShareSnapshot(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	if err := f.db.ReadGitHubProjectApp(ctx, f.project, func(dao store.GitHubProjectAppReadDAO) error {
		narrow, ok := dao.(store.GitHubProjectAppAdmissionReader)
		if !ok {
			t.Fatal("admission capability missing")
		}
		access, err := narrow.ProjectAppAccess(ctx, f.p)
		if err != nil {
			return err
		}
		if access.TeamID != f.team || access.OwnershipVersion != 1 || access.ConnectionVersion != 1 || access.Access.Role != model.ProjectAdmin {
			t.Fatalf("access %+v", access)
		}
		version, err := narrow.ProjectAppVersion(ctx, f.app, f.grant, f.team)
		if err != nil || version != 1 {
			t.Fatalf("version %d %v", version, err)
		}
		if _, err = narrow.ProjectAppVersion(ctx, f.app, f.grant, uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("wrong team: %v", err)
		}
		stranger := f.p
		stranger.UserID = uuid.NewString()
		if _, err = narrow.ProjectAppAccess(ctx, stranger); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("hidden project: %v", err)
		}
		if _, err = f.db.Pool.Exec(ctx, `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, f.grant); err != nil {
			return err
		}
		facts, err := dao.Facts(ctx, f.p)
		if err != nil {
			return err
		}
		app, err := dao.App(ctx, f.app, f.grant, f.team)
		if err != nil || app.ID != f.app || facts.Connection.Version != access.ConnectionVersion {
			t.Fatalf("snapshot facts=%+v app=%+v err=%v", facts, app, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.ReadGitHubProjectApp(ctx, f.project, func(dao store.GitHubProjectAppReadDAO) error {
		_, err := dao.(store.GitHubProjectAppAdmissionReader).ProjectAppVersion(ctx, f.app, f.grant, f.team)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("revoked grant: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestProjectAppAdmissionFactsAndProjectionShareWriteScope(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	completion, err := f.db.WriteGitHubProjectApp(ctx, f.project, f.p.UserID, f.app, func(dao store.GitHubProjectAppWriteDAO) error {
		narrow, ok := dao.(store.GitHubProjectAppAdmissionReader)
		if !ok {
			t.Fatal("write admission capability missing")
		}
		access, err := narrow.ProjectAppAccess(ctx, f.p)
		if err != nil {
			return err
		}
		version, err := narrow.ProjectAppVersion(ctx, f.app, f.grant, f.team)
		if err != nil {
			return err
		}
		facts, err := dao.Facts(ctx, f.p)
		if err != nil {
			return err
		}
		app, err := dao.App(ctx, f.app, f.grant, f.team)
		if err != nil {
			return err
		}
		if access.TeamID != f.team || access.OwnershipVersion != facts.Project.Ownership.Version || access.ConnectionVersion != facts.Connection.Version || version != app.Version {
			t.Fatalf("access=%+v facts=%+v app=%+v", access, facts, app)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("completion %+v error %v", completion, err)
	}
}
