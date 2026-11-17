package postgres

import (
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestGitHubResourcesShareProjectSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	ctx := t.Context()
	mustQueryExec(t, database, `INSERT INTO project_github(project_id,version,revision) VALUES($1,2,1)`, project.ID)
	mustQueryExec(t, database, `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,1,1,'url','first','open',false,'main','sha',now(),now(),now(),1)`, project.ID)
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		if _, err := scope.ProjectDAO().Project(ctx, project.ID); err != nil {
			return err
		}
		before, err := scope.GitHubDAO().Connection(ctx, project.ID)
		if err != nil {
			return err
		}
		mustQueryExec(t, database, `UPDATE project_github SET revision=2 WHERE project_id=$1`, project.ID)
		mustQueryExec(t, database, `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,2,2,'url','second','open',false,'main','sha',now(),now(),now(),2)`, project.ID)
		counts, err := scope.GitHubDAO().PullRequestCounts(ctx, GitHubPRCountsQuery{ProjectID: project.ID})
		if err != nil {
			return err
		}
		page, err := scope.GitHubDAO().PullRequests(ctx, GitHubPRQuery{ProjectID: project.ID, State: "all", Limit: 10})
		if err != nil {
			return err
		}
		if before.Revision != 1 || counts.All != 1 || page.Total != 1 || len(page.Items) != 1 || page.Items[0].Number != 1 {
			return fmt.Errorf("mixed snapshot: connection=%+v counts=%+v page=%+v", before, counts, page)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		c, err := scope.GitHubDAO().Connection(ctx, project.ID)
		if err != nil {
			return err
		}
		counts, err := scope.GitHubDAO().PullRequestCounts(ctx, GitHubPRCountsQuery{ProjectID: project.ID})
		if err != nil {
			return err
		}
		if c.Revision != 2 || counts.All != 2 {
			return fmt.Errorf("fresh snapshot missed write: %+v %+v", c, counts)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestGitHubConfigurationSharesProjectTransaction(t *testing.T) {
	parallelRootDatabaseTest(t)
	database, actor, project, team, app, grant := projectAppScopeFixture(t)
	ctx := t.Context()
	principal := model.Principal{Kind: model.SessionCredential, UserID: actor, CredentialID: uuid.NewString()}
	appID, installationID, repositoryID, credential := int64(9), int64(7), int64(8), int64(1)
	account, fullName := "o", "o/r"
	write := GitHubProjectAppWrite{Configuration: GitHubConfigurationWrite{ExpectedVersion: 1, Version: 2, Generation: 1, Revision: 1, Enabled: true, AppID: &appID, InstallationID: &installationID, RepositoryID: &repositoryID, InstallationAccountLogin: &account, RepositoryFullName: &fullName, PollIntervalMinutes: 5, AccessState: "available"}, AppResourceID: &app, GrantID: &grant, CredentialVersion: &credential}
	rollback := errors.New("abort transaction")
	apply := func(abort bool) (Completion, error) {
		return database.WriteGitHubProjectApp(ctx, project, actor, app, func(dao GitHubProjectAppWriteDAO) error {
			facts, err := dao.Facts(ctx, principal)
			if err != nil {
				return err
			}
			if facts.Project.ID != project || facts.Project.Ownership.TeamID != team || facts.Connection.Version != 1 || facts.AppResourceID != nil {
				return fmt.Errorf("initial facts: %+v", facts)
			}
			selected, err := dao.App(ctx, app, grant, team)
			if err != nil {
				return err
			}
			if selected.ID != app || selected.CredentialVersion != credential {
				return fmt.Errorf("selected App: %+v", selected)
			}
			ok, err := dao.Save(ctx, write)
			if err != nil {
				return err
			}
			if !ok {
				return errors.New("configuration not written")
			}
			if abort {
				return rollback
			}
			return nil
		})
	}
	completion, err := apply(true)
	if !errors.Is(err, rollback) || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		c, err := scope.GitHubDAO().Connection(ctx, project)
		if err != nil {
			return err
		}
		if c.Version != 1 || c.Generation != 0 || c.Revision != 0 || c.Enabled || c.PollIntervalMinutes != 5 || c.AccessState != "unknown" || c.CreatedAt != nil {
			return fmt.Errorf("virtual default after rollback: %+v", c)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	completion, err = apply(false)
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("commit: %+v %v", completion, err)
	}
	if err := database.ReadGitHubProjectApp(ctx, project, func(dao GitHubProjectAppReadDAO) error {
		facts, err := dao.Facts(ctx, principal)
		if err != nil {
			return err
		}
		if facts.Connection.Version != 2 || facts.Connection.CreatedAt == nil || !facts.Connection.Enabled || facts.AppResourceID == nil || *facts.AppResourceID != app || facts.GrantID == nil || *facts.GrantID != grant || facts.CredentialVersion == nil || *facts.CredentialVersion != credential {
			return fmt.Errorf("committed facts: %+v", facts)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	completion, err = database.WriteGitHubProjectApp(ctx, project, actor, app, func(dao GitHubProjectAppWriteDAO) error {
		ok, err := dao.Save(ctx, write)
		if err != nil {
			return err
		}
		if ok {
			return errors.New("stale configuration accepted")
		}
		return nil
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("stale condition: %+v %v", completion, err)
	}
	bad := write
	bad.Configuration.ExpectedVersion, bad.Configuration.Version = 2, 3
	invalidCredential := credential + 1
	bad.CredentialVersion = &invalidCredential
	completion, err = database.WriteGitHubProjectApp(ctx, project, actor, app, func(dao GitHubProjectAppWriteDAO) error {
		_, err := dao.Save(ctx, bad)
		return err
	})
	if err == nil || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("invalid App binding: %+v %v", completion, err)
	}
	if err := database.ReadGitHubProjectApp(ctx, project, func(dao GitHubProjectAppReadDAO) error {
		facts, err := dao.Facts(ctx, principal)
		if err != nil {
			return err
		}
		if facts.Connection.Version != 2 || facts.AppResourceID == nil || *facts.AppResourceID != app || facts.GrantID == nil || *facts.GrantID != grant || facts.CredentialVersion == nil || *facts.CredentialVersion != credential {
			return fmt.Errorf("failed write changed binding: %+v", facts)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
