package project_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestScopedProjectsPagesUseOneRepeatableSnapshot(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	owner, person, _ := testutil.ProjectMembershipFixture(t, database)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	projects := make([]model.Project, 5)
	for i := range projects {
		var err error
		projects[i], err = testutil.CreatePrivateProject(ctx, database, owner, testutil.QueryID(i+1), "Project", "https://example.com/owner/repo")
		if err != nil {
			t.Fatal(err)
		}
		testutil.MustExec(t, database.Pool, `UPDATE projects SET created_at='2024-01-01 00:00:00+00' WHERE id=$1`, projects[i].ID)
	}
	team := testutil.OrdinaryProjectTeam(t, database.Pool, projects[1].ID)
	testutil.MustExec(t, database.Pool, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team, person.UserID)
	for _, i := range []int{0, 2, 4} {
		testutil.MustExec(t, database.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, projects[i].ID, person.UserID)
	}
	testutil.MustExec(t, database.Pool, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, projects[4].ID)

	readPage := func(scope SnapshotScope, after *Position) (ProjectPage, error) {
		return scope.ProjectDAO().ScopedProjects(ctx, person, ProjectScope{Kind: ProjectScopeAll}, Page{Limit: 1, After: after})
	}
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		first, err := readPage(scope, nil)
		if err != nil || len(first.Items) != 1 || first.Items[0].ID != projects[0].ID || !first.HasMore {
			return fmt.Errorf("first page: %#v %v", first, err)
		}
		write, err := database.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer write.Rollback(context.Background())
		for _, operation := range []struct {
			query string
			args  []any
		}{
			{`DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, []any{team, person.UserID}},
			{`UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, []any{projects[2].ID}},
			{`INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, []any{projects[3].ID, person.UserID}},
		} {
			if _, err := write.Exec(ctx, operation.query, operation.args...); err != nil {
				return err
			}
		}
		if err := write.Commit(ctx); err != nil {
			return err
		}
		after := &Position{ID: first.Items[0].ID, CreatedAt: first.Items[0].CreatedAt}
		second, err := readPage(scope, after)
		if err != nil || len(second.Items) != 1 || second.Items[0].ID != projects[1].ID || !second.HasMore {
			return fmt.Errorf("second page after concurrent changes: %#v %v", second, err)
		}
		after = &Position{ID: second.Items[0].ID, CreatedAt: second.Items[0].CreatedAt}
		third, err := readPage(scope, after)
		if err != nil || len(third.Items) != 1 || third.Items[0].ID != projects[2].ID || third.HasMore {
			return fmt.Errorf("third page after concurrent changes: %#v %v", third, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		page, err := scope.ProjectDAO().ScopedProjects(ctx, person, ProjectScope{Kind: ProjectScopeAll}, Page{Limit: 10})
		if err != nil {
			return err
		}
		ids := make([]string, len(page.Items))
		for i, item := range page.Items {
			ids[i] = item.ID
		}
		if !slices.Equal(ids, []string{projects[0].ID, projects[3].ID}) || page.HasMore {
			return fmt.Errorf("fresh snapshot did not observe access and deletion changes: %v, more=%t", ids, page.HasMore)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
