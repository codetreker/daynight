package postgres

import (
	"errors"
	"fmt"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestGitHubResourcesShareProjectSnapshot(t *testing.T) {
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
		counts, err := scope.GitHubDAO().PullRequestCounts(ctx, project.ID)
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
		counts, err := scope.GitHubDAO().PullRequestCounts(ctx, project.ID)
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
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	ctx := t.Context()
	rollback := errors.New("abort transaction")
	write := GitHubConfigurationWrite{ExpectedVersion: 1, Version: 2, PollIntervalMinutes: 5, AccessState: "unknown"}
	completion, err := database.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		if _, err := scope.GitHubDAO().Connection(ctx); err != nil {
			return err
		}
		ok, err := scope.GitHubDAO().SaveConfiguration(ctx, write)
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("configuration not written")
		}
		return rollback
	})
	if !errors.Is(err, rollback) || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		c, err := scope.GitHubDAO().Connection(ctx, project.ID)
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
	completion, err = database.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		if _, err := scope.GitHubDAO().Connection(ctx); err != nil {
			return err
		}
		ok, err := scope.GitHubDAO().SaveConfiguration(ctx, write)
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("configuration not written")
		}
		return nil
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("commit: %+v %v", completion, err)
	}
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		c, err := scope.GitHubDAO().Connection(ctx, project.ID)
		if err != nil {
			return err
		}
		if c.Version != 2 || c.CreatedAt == nil {
			return fmt.Errorf("committed configuration: %+v", c)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
