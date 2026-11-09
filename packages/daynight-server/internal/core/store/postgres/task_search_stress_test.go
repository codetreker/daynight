//go:build stress

package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	"github.com/google/uuid"
)

type observingSearchReader struct {
	inner      store.TaskSearchReader
	graphReads int
}
type observingSearchSnapshot struct {
	store.TaskSearchSnapshot
	owner *observingSearchReader
}

func (r *observingSearchReader) ReadTaskSearch(ctx context.Context, operation func(store.TaskSearchSnapshot) error) error {
	return r.inner.ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		return operation(&observingSearchSnapshot{TaskSearchSnapshot: s, owner: r})
	})
}

// Authorization is supplied by the test seam to focus on context projection.
func (s *observingSearchSnapshot) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	return model.ProjectAccess{}, nil
}
func (s *observingSearchSnapshot) ContextGraph(ctx context.Context, project string, ids []string) (store.TaskSearchGraph, error) {
	s.owner.graphReads++
	return s.TaskSearchSnapshot.ContextGraph(ctx, project, ids)
}

func TestTaskSearchManyComponentsStress(t *testing.T) {
	db := searchTestStore(t)
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
	reader := &observingSearchReader{inner: NewTaskSearch(db.Pool)}
	principal := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	for _, test := range []struct {
		expression string
		connected  bool
	}{{"title:standalone", false}, {"title:componenttarget", true}} {
		seen := map[string]bool{}
		var cursor *string
		for {
			deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
			page, err := tasksearch.Search(deadline, reader, principal, project, tasksearch.Request{Query: test.expression, Limit: 100, Cursor: cursor})
			cancel()
			if err != nil {
				t.Fatal(err)
			}
			if page.Total != 1101 {
				t.Fatalf("total %d", page.Total)
			}
			for _, item := range page.Items {
				if seen[item.ID] || (item.Context != nil) != test.connected {
					t.Fatalf("bad item %+v", item)
				}
				seen[item.ID] = true
			}
			if page.NextCursor == nil {
				break
			}
			cursor = page.NextCursor
		}
		if len(seen) != 1101 {
			t.Fatalf("seen %d", len(seen))
		}
	}
}

func TestTaskSearchLinearContextStress(t *testing.T) {
	db := searchTestStore(t)
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
	reader := &observingSearchReader{inner: NewTaskSearch(db.Pool)}
	principal := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	page, err := tasksearch.Search(deadline, reader, principal, project, tasksearch.Request{Query: "title:linearroot", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if reader.graphReads != 1 || page.NodeCount != 20000 || len(page.Items) != 1 || page.Items[0].Context == nil || page.Items[0].Context.TaskID != seed {
		t.Fatalf("linear result %+v; graph reads %d", page, reader.graphReads)
	}
}
