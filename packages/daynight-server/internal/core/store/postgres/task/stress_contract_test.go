//go:build stress

package task_test

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
	"github.com/google/uuid"
)

func TestTaskSearchManyComponentsStress(t *testing.T) {
	db := readerStore(t)
	ctx := context.Background()
	project := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'components','example')`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `CREATE TABLE search_components_fixture(n integer PRIMARY KEY,solo uuid NOT NULL,root uuid NOT NULL,child uuid NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO search_components_fixture SELECT n,gen_random_uuid(),gen_random_uuid(),gen_random_uuid() FROM generate_series(1,1101) n`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title)
 SELECT solo,$1::uuid,'standalone' FROM search_components_fixture UNION ALL
 SELECT root,$1::uuid,'componentroot' FROM search_components_fixture UNION ALL
 SELECT child,$1::uuid,'componenttarget' FROM search_components_fixture`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external)
 SELECT $1,child,root,false FROM search_components_fixture`, project); err != nil {
		t.Fatal(err)
	}

	reader := postgres.NewTaskSearch(db.Pool)
	for _, test := range []struct {
		expression string
		connected  bool
	}{{"title:standalone", false}, {"title:componenttarget", true}} {
		expression, err := query.Parse(test.expression)
		if err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		var after *store.TaskSearchPosition
		for {
			deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
			var page store.TaskSearchPage
			var graph store.TaskSearchGraph
			err := reader.ReadTaskSearch(deadline, func(snapshot store.TaskSearchSnapshot) error {
				var err error
				page, err = snapshot.Matches(deadline, project, store.TaskSearchQuery{Expression: expression, Limit: 100, After: after})
				if err != nil {
					return err
				}
				ids := make([]string, 0, len(page.Items))
				for _, item := range page.Items {
					ids = append(ids, item.ID)
				}
				graph, err = snapshot.ContextGraph(deadline, project, ids)
				return err
			})
			cancel()
			if err != nil {
				t.Fatal(err)
			}
			if page.Total != 1101 {
				t.Fatalf("total %d", page.Total)
			}
			nodes, edges := len(page.Items), 0
			if test.connected {
				nodes *= 2
				edges = len(page.Items)
			}
			if len(graph.Nodes) != nodes || len(graph.Edges) != edges {
				t.Fatalf("context closure: nodes=%d edges=%d want=%d/%d", len(graph.Nodes), len(graph.Edges), nodes, edges)
			}
			for _, item := range page.Items {
				if seen[item.ID] {
					t.Fatalf("repeated SQL row %+v", item)
				}
				seen[item.ID] = true
			}
			if !page.HasMore {
				break
			}
			if len(page.Items) == 0 {
				t.Fatal("page has no continuation row")
			}
			last := page.Items[len(page.Items)-1]
			after = &store.TaskSearchPosition{ExactIDPriority: last.ExactIDPriority, TitlePriority: last.TitlePriority, UpdatedAt: last.UpdatedAt, ID: last.ID}
		}
		if len(seen) != 1101 {
			t.Fatalf("seen %d", len(seen))
		}
	}
}
func TestTaskSearchLinearContextStress(t *testing.T) {
	db := readerStore(t)
	ctx := context.Background()
	project := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'linear','example')`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `CREATE TABLE search_linear_fixture(n integer PRIMARY KEY,id uuid NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO search_linear_fixture SELECT n,gen_random_uuid() FROM generate_series(1,20000) n`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) SELECT id,$1,CASE WHEN n=1 THEN 'linearroot' ELSE n::text END FROM search_linear_fixture`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external)
 SELECT $1,source.id,target.id,false FROM search_linear_fixture source JOIN search_linear_fixture target ON target.n=source.n-1`, project); err != nil {
		t.Fatal(err)
	}
	var seed string
	if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM search_linear_fixture WHERE n=1`).Scan(&seed); err != nil {
		t.Fatal(err)
	}

	reader := postgres.NewTaskSearch(db.Pool)
	expression, err := query.Parse("title:linearroot")
	if err != nil {
		t.Fatal(err)
	}
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var page store.TaskSearchPage
	var graph store.TaskSearchGraph
	err = reader.ReadTaskSearch(deadline, func(snapshot store.TaskSearchSnapshot) error {
		var err error
		page, err = snapshot.Matches(deadline, project, store.TaskSearchQuery{Expression: expression, Limit: 10})
		if err != nil {
			return err
		}
		if len(page.Items) != 1 || page.Items[0].ID != seed || page.Total != 1 {
			t.Fatalf("linear match %+v", page)
		}
		graph, err = snapshot.ContextGraph(deadline, project, []string{seed})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(graph.Nodes) != 20000 || len(graph.Edges) != 19999 {
		t.Fatalf("linear closure: nodes=%d edges=%d", len(graph.Nodes), len(graph.Edges))
	}
}
