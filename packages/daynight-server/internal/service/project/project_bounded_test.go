package project

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

func TestBoundedScopedProjectsPreservePrefixAndAuthority(t *testing.T) {
	projects, database, _, owner := projectService(t)
	ctx := context.Background()
	outsider := servicePrincipal(t, database)
	var ids []string
	var team string
	for i := 0; i < 3; i++ {
		p, err := projects.Create(ctx, owner, coreproject.CreateProject{ExpectedUserID: owner.UserID, Name: fmt.Sprintf("project %d", i), RepoURL: "host:repo"})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, p.ID)
		team = p.Ownership.TeamID
		if _, err = database.Pool.Exec(ctx, `UPDATE projects SET created_at='2024-01-01 00:00:00+00'::timestamptz + $2::int * interval '1 second' WHERE id=$1`, p.ID, i); err != nil {
			t.Fatal(err)
		}
	}
	big := strings.Repeat("x", 256<<10)
	if _, err := database.Pool.Exec(ctx, `UPDATE projects SET name=$2 WHERE id=$1`, ids[1], big); err != nil {
		t.Fatal(err)
	}
	req := coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 100}, TeamID: &team}
	page, err := projects.ListScopedBounded(ctx, owner, req, 16<<10)
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != ids[0] || page.NextCursor == nil {
		t.Fatalf("bounded prefix: %#v %v", page, err)
	}
	req.Page.Cursor = page.NextCursor
	_, err = projects.ListScopedBounded(ctx, owner, req, 16<<10)
	fault := requireFault(t, err, "payload_too_large")
	if !strings.Contains(fault.Message, ids[1]) {
		t.Fatalf("missing oversized ID: %v", err)
	}
	req.Page.Cursor = nil
	_, err = projects.ListScopedBounded(ctx, outsider, req, 16<<10)
	requireFault(t, err, "not_found")
	all, err := projects.ListScoped(ctx, owner, req)
	if err != nil || len(all.Items) != 3 || all.Items[1].Name != big {
		t.Fatalf("REST scope changed: %#v %v", all, err)
	}
}

func TestBoundedProjectListRejectsInvalidBudgets(t *testing.T) {
	projects, _, _, owner := projectService(t)
	request := coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1}}
	for _, limit := range []int{-1, 0, (128 << 20) + 1} {
		page, err := projects.ListScopedBounded(context.Background(), owner, request, limit)
		requireFault(t, err, "invalid_input")
		if len(page.Items) != 0 || page.NextCursor != nil {
			t.Fatalf("invalid budget yielded page: %#v", page)
		}
	}
}
