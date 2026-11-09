package postgres

import (
	"context"
	"crypto/rand"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	searchmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func searchTestStore(t *testing.T) *Store {
	t.Helper()
	ctx := context.Background()
	raw := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if raw == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	admin, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	schema := "test_search_" + strings.ToLower(rand.Text())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	values := u.Query()
	values.Set("search_path", schema)
	u.RawQuery = values.Encode()
	db, err := Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return db
}

func TestTaskSearchSQLMatchesEvidenceAndPaginates(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	project := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, project); err != nil {
		t.Fatal(err)
	}
	type fixture struct {
		id, title, description string
		updated                time.Time
	}
	texts := [][2]string{{"CacheManager", "old"}, {"缓存", "登录"}, {"cache", "数据库"}, {"猫", "Markdown **缓存** https://example.com"}, {strings.Repeat("x", 200) + "缓存", "x"}, {"İ Café", "%_\\"}, {"other", "CACHE"}, {"large", strings.Repeat("界", 300) + "缓存" + strings.Repeat("😀", 300)}, {"none", ""}}
	fixtures := make([]fixture, 0, len(texts))
	for i, pair := range texts {
		f := fixture{id: uuid.NewString(), title: pair[0], description: pair[1], updated: time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC)}
		fixtures = append(fixtures, f)
		if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,description,updated_at) VALUES($1,$2,$3,$4,$5)`, f.id, project, f.title, f.description, f.updated); err != nil {
			t.Fatal(err)
		}
	}
	queries := []string{`cache`, `缓存`, `title:缓存`, `description:"缓存"`, `NOT old`, `NOT (title:cache AND NOT description:old)`, `(title:缓存 AND description:数据库) OR description:登录`, `"%_\\"`, `café`, `İ`, `猫 OR cache`, `title:cache AND title:cache`, "\x00", "NOT \x00", "title:\x00 OR cache"}
	reader := NewTaskSearch(db.Pool)
	for _, text := range queries {
		t.Run(text, func(t *testing.T) {
			root, err := query.Parse(text)
			if err != nil {
				t.Fatal(err)
			}
			var expected []fixture
			for _, f := range fixtures {
				if query.Evaluate(root, f.title, f.description).Matches {
					expected = append(expected, f)
				}
			}
			sort.Slice(expected, func(i, j int) bool {
				a, b := query.Evaluate(root, expected[i].title, expected[i].description), query.Evaluate(root, expected[j].title, expected[j].description)
				if a.Title != b.Title {
					return a.Title
				}
				if !expected[i].updated.Equal(expected[j].updated) {
					return expected[i].updated.After(expected[j].updated)
				}
				return expected[i].id < expected[j].id
			})
			var got []string
			var after *store.TaskSearchPosition
			for {
				var page store.TaskSearchPage
				err := reader.ReadTaskSearch(ctx, func(snapshot store.TaskSearchSnapshot) error {
					var err error
					page, err = snapshot.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 2, After: after})
					return err
				})
				if err != nil {
					t.Fatal(err)
				}
				if page.Total != int64(len(expected)) {
					t.Fatalf("total %d, want %d", page.Total, len(expected))
				}
				for _, row := range page.Items {
					got = append(got, row.ID)
					if row.Description != "" {
						t.Fatal("full description crossed the database boundary")
					}
					var original fixture
					for _, value := range fixtures {
						if value.id == row.ID {
							original = value
							break
						}
					}
					evidence := query.Evaluate(root, original.title, original.description)
					hits := map[searchmodel.Atom]query.Evidence{}
					for _, hit := range row.Hits {
						leaf := query.Evaluate(&searchmodel.Node{Kind: searchmodel.Leaf, Atom: hit.Atom}, original.title, original.description)
						if hit.Title != leaf.Title || hit.Description != leaf.Description || !reflect.DeepEqual(hit.Snippet, query.Snippet(original.description, leaf)) {
							t.Fatalf("projected hit differs: %+v %+v", hit, leaf)
						}
						hits[hit.Atom] = query.Evidence{Title: hit.Title, Description: hit.Description}
					}
					projected, err := query.EvaluateHits(ctx, root, hits)
					if err != nil || !reflect.DeepEqual(projected, evidence) {
						t.Fatalf("projected evidence: %+v expected %+v err=%v", projected, evidence, err)
					}
					if !evidence.Matches || row.TitlePriority != evidence.Title {
						t.Fatalf("SQL evidence mismatch: %+v %+v", row, evidence)
					}
				}
				if !page.HasMore {
					break
				}
				last := page.Items[len(page.Items)-1]
				after = &store.TaskSearchPosition{ID: last.ID, UpdatedAt: last.UpdatedAt, TitlePriority: last.TitlePriority}
			}
			if len(got) != len(expected) {
				t.Fatalf("got %v, want %v", got, expected)
			}
			for i := range got {
				if got[i] != expected[i].id {
					t.Fatalf("order %v, want %v", got, expected)
				}
			}
		})
	}
}

func TestTaskSearchContextAndFence(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	project := uuid.NewString()
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, project); err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,$1::uuid::text)`, id, project); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,false),($1,$3,$4,false),($1,$4,$5,true)`, project, ids[0], ids[1], ids[2], ids[3]); err != nil {
		t.Fatal(err)
	}
	err := NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		fence, err := s.Fence(ctx, project)
		if err != nil {
			return err
		}
		if fence.Count != "4" || fence.VersionSum != "4" || fence.Epoch == "" {
			t.Errorf("fence: %+v", fence)
		}
		size, err := s.ContextSize(ctx, project, ids[:1])
		if err != nil {
			return err
		}
		if size.NodeCount != 3 || size.EdgeCount != 2 {
			t.Errorf("size: %+v", size)
		}
		graph, err := s.ContextGraph(ctx, project, ids[:1])
		if err != nil {
			return err
		}
		if len(graph.Nodes) != 3 || len(graph.Edges) != 2 {
			t.Errorf("graph: %+v", graph)
		}
		titles, err := s.Titles(ctx, project, ids[:3])
		if err != nil {
			return err
		}
		for _, id := range ids[:3] {
			if titles[id] != id {
				t.Errorf("title missing: %s", id)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTaskSearchSnapshotAndFilters(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	project, owner := uuid.NewString(), uuid.NewString()
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,status,assigned_to,allow_agents,required_platform)
 VALUES($1,$4,'word','done',$5,true,'linux'),($2,$4,'word','todo',NULL,false,NULL),($3,$4,'word','todo',$5,true,'macos')`, ids[0], ids[1], ids[2], project, owner); err != nil {
		t.Fatal(err)
	}
	root, err := query.Parse("word")
	if err != nil {
		t.Fatal(err)
	}
	reader := NewTaskSearch(db.Pool)
	var before store.TaskSearchFence
	err = reader.ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		var err error
		before, err = s.Fence(ctx, project)
		if err != nil {
			return err
		}
		status, ready, agents, platform := model.TaskTodo, true, true, model.PlatformMacOS
		page, err := s.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 10, Status: &status, Ready: &ready, AllowAgents: &agents, CompatiblePlatform: &platform, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: owner}})
		if err != nil {
			return err
		}
		if page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != ids[2] {
			t.Errorf("filtered page: %+v", page)
		}
		if _, err := db.Pool.Exec(ctx, `UPDATE tasks SET version=version+1,title='changed' WHERE id=$1`, ids[2]); err != nil {
			return err
		}
		after, err := s.Fence(ctx, project)
		if err != nil {
			return err
		}
		if after != before {
			t.Errorf("snapshot changed: %+v %+v", before, after)
		}
		page, err = s.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 10})
		if err != nil {
			return err
		}
		if page.Total != 3 {
			t.Errorf("snapshot match count: %d", page.Total)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = reader.ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		after, err := s.Fence(ctx, project)
		if err != nil {
			return err
		}
		if after == before || after.VersionSum != "4" {
			t.Errorf("committed fence: %+v", after)
		}
		page, err := s.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 10})
		if err != nil {
			return err
		}
		if page.Total != 2 {
			t.Errorf("new snapshot count: %d", page.Total)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTaskSearchProjectionBoundsHistoricalDescription(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	project, id := uuid.NewString(), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, project); err != nil {
		t.Fatal(err)
	}
	description := strings.Repeat("界", 800000) + "needle" + strings.Repeat("😀", 500000)
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,description) VALUES($1,$2,'small',$3)`, id, project, description); err != nil {
		t.Fatal(err)
	}
	root, err := query.Parse("description:needle")
	if err != nil {
		t.Fatal(err)
	}
	err = NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(snapshot store.TaskSearchSnapshot) error {
		page, err := snapshot.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 1})
		if err != nil {
			return err
		}
		if len(page.Items) != 1 || page.Items[0].Description != "" || len(page.Items[0].Hits) != 1 {
			t.Fatalf("unbounded projection: %+v", page)
		}
		want := "…" + strings.Repeat("界", 80) + "needle" + strings.Repeat("😀", 74) + "…"
		hit := page.Items[0].Hits[0]
		if !hit.Description || hit.Snippet == nil || *hit.Snippet != want {
			t.Fatalf("snippet differs: %+v", page.Items[0].Hits[0])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTaskSearchContextRepresentativeProjection(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	project, a, b, single := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$4,'a'),($2,$4,'b'),($3,$4,'single')`, a, b, single, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,false)`, project, b, a); err != nil {
		t.Fatal(err)
	}
	err := NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(snapshot store.TaskSearchSnapshot) error {
		rep, ok, err := snapshot.ContextRepresentative(ctx, project, b)
		if err != nil || !ok || rep != a {
			t.Fatalf("component representative %s %v %v", rep, ok, err)
		}
		rep, ok, err = snapshot.ContextRepresentative(ctx, project, single)
		if err != nil || !ok || rep != "" {
			t.Fatalf("singleton %s %v %v", rep, ok, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
