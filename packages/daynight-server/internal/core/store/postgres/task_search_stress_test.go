//go:build stress

package postgres

import (
	"context"
	"errors"
	"runtime"
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

// The scope of this test is capacity, with authorization supplied by the test seam.
func (s *observingSearchSnapshot) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	return model.ProjectAccess{}, nil
}
func (s *observingSearchSnapshot) ContextGraph(ctx context.Context, project string, ids []string) (store.TaskSearchGraph, error) {
	s.owner.graphReads++
	return s.TaskSearchSnapshot.ContextGraph(ctx, project, ids)
}

func TestTaskSearchContextCapacityStress(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	project := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'capacity','example')`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `CREATE TABLE search_capacity_fixture (n integer PRIMARY KEY,id uuid NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO search_capacity_fixture SELECT n,gen_random_uuid() FROM generate_series(1,20000) n`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) SELECT id,$1,n::text FROM search_capacity_fixture`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external)
 SELECT $1::uuid,source.id,root.id,false FROM search_capacity_fixture source CROSS JOIN search_capacity_fixture root WHERE source.n>1 AND root.n=1
 UNION ALL SELECT $1::uuid,source.id,target.id,false FROM search_capacity_fixture source CROSS JOIN generate_series(1,4) k JOIN search_capacity_fixture target ON target.n=source.n-k WHERE source.n>=6
 UNION ALL SELECT $1::uuid,source.id,target.id,false FROM search_capacity_fixture source JOIN search_capacity_fixture target ON target.n=source.n-5 WHERE source.n BETWEEN 7 AND 27`, project); err != nil {
		t.Fatal(err)
	}
	var seed string
	if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM search_capacity_fixture WHERE n=1`).Scan(&seed); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE tasks SET title='capacityroot' WHERE id=$1`, seed); err != nil {
		t.Fatal(err)
	}
	reader := &observingSearchReader{inner: NewTaskSearch(db.Pool)}
	principal := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	search := func() (tasksearch.Page, error) {
		deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return tasksearch.Search(deadline, reader, principal, project, tasksearch.Request{Query: "title:capacityroot", Limit: 10})
	}
	check := func(nodes, edges int64) {
		t.Helper()
		err := NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
			size, err := s.ContextSize(ctx, project, []string{seed})
			if err != nil {
				return err
			}
			if size.NodeCount != nodes || size.EdgeCount != edges {
				t.Errorf("size %+v, want %d/%d", size, nodes, edges)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	check(20000, 100000)
	// TotalAlloc captures all Go heap allocation during the complete request,
	// including unrelated runtime work; PostgreSQL memory is outside this bound.
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	page, err := search()
	runtime.ReadMemStats(&after)
	allocated := after.TotalAlloc - before.TotalAlloc
	t.Logf("complete boundary search Go heap allocated: %d bytes", allocated)
	if allocated > 64<<20 {
		t.Fatalf("boundary search allocated %d bytes, maximum %d", allocated, 64<<20)
	}
	if err != nil {
		t.Fatal(err)
	}
	if reader.graphReads != 1 || page.Total != 1 || len(page.Items) != 1 || page.Items[0].Context == nil || page.Items[0].Context.TaskID != seed {
		t.Fatalf("boundary result %+v; graph reads %d", page, reader.graphReads)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external)
 SELECT $1,source.id,target.id,false FROM search_capacity_fixture source JOIN search_capacity_fixture target ON target.n=source.n-5 WHERE source.n=28`, project); err != nil {
		t.Fatal(err)
	}
	check(20000, 100001)
	reader.graphReads = 0
	_, err = search()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "search_context_limit_exceeded" || fault.GraphLimit == nil || fault.GraphLimit.NodeCount != 20000 || fault.GraphLimit.EdgeCount != 100001 || reader.graphReads != 0 {
		t.Fatalf("edge refusal %v, reads %d", err, reader.graphReads)
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM task_dependencies d USING search_capacity_fixture source,search_capacity_fixture target
 WHERE d.project_id=$1 AND source.n IN (27,28) AND target.n=source.n-5 AND d.task_id=source.id AND d.depends_on_task_id=target.id`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `WITH added AS (INSERT INTO tasks(id,project_id,title) VALUES(gen_random_uuid(),$1,'extra') RETURNING id)
 INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) SELECT $1,id,$2,false FROM added`, project, seed); err != nil {
		t.Fatal(err)
	}
	check(20001, 100000)
	reader.graphReads = 0
	_, err = search()
	fault = nil
	if !errors.As(err, &fault) || fault.Code != "search_context_limit_exceeded" || fault.GraphLimit == nil || fault.GraphLimit.NodeCount != 20001 || fault.GraphLimit.EdgeCount != 100000 || reader.graphReads != 0 {
		t.Fatalf("node refusal %v, reads %d", err, reader.graphReads)
	}
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

func TestTaskSearchLinearCapacityStress(t *testing.T) {
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
