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
				if query.Evaluate(root, query.Text{ID: f.id, Title: f.title, Description: f.description}).Matches {
					expected = append(expected, f)
				}
			}
			sort.Slice(expected, func(i, j int) bool {
				a, b := query.Evaluate(root, query.Text{ID: expected[i].id, Title: expected[i].title, Description: expected[i].description}), query.Evaluate(root, query.Text{ID: expected[j].id, Title: expected[j].title, Description: expected[j].description})
				if a.ExactID != b.ExactID {
					return a.ExactID
				}
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
					evidence := query.Evaluate(root, query.Text{ID: row.ID, Title: row.Title, Description: row.Description})
					if !evidence.Matches || row.TitlePriority != evidence.Title || row.ExactIDPriority != evidence.ExactID {
						t.Fatalf("SQL evidence mismatch: %+v %+v", row, evidence)
					}
				}
				if !page.HasMore {
					break
				}
				last := page.Items[len(page.Items)-1]
				after = &store.TaskSearchPosition{ID: last.ID, UpdatedAt: last.UpdatedAt, TitlePriority: last.TitlePriority, ExactIDPriority: last.ExactIDPriority}
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

func TestTaskSearchIDOrderingAndPagination(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	project := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, project); err != nil {
		t.Fatal(err)
	}
	const a = "05d609a8-50e2-4aaf-a31d-82466dca2a36"
	const b = "05d609a8-f3f0-4120-9458-d7dc74e10a61"
	const c = "c28f741e-8022-4e31-9bc0-c5443a19eb10"
	const d = "d148ab6c-8d0b-4611-aa26-d9c84f06da20"
	rows := []struct{ id, title, description string }{{a, "ok", "clean"}, {b, "other", "clean"}, {c, "ref " + a, "mentions " + a}, {d, "ok", "clean"}}
	for i, row := range rows {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,description,updated_at) VALUES($1,$2,$3,$4,$5)`, row.id, project, row.title, row.description, time.Date(2026, 11, 9, 0, i, 0, 0, time.UTC)); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		expression string
		want       []string
	}{
		{a, []string{a, c}}, {"id:" + a, []string{a}}, {"05d609a8", []string{c, b, a}}, {"id:05D609A8", []string{b, a}},
		{`id:"50e2-4aaf"`, []string{a}}, {"id:05d609a850e2", nil}, {"id:xyz", nil}, {"id:*", nil},
		{"title:" + a, []string{c}}, {"description:" + a, []string{c}}, {"id:" + a + " OR title:ok", []string{a, d}}, {a + " OR title:ok OR id:05d609a8", []string{a, d, c, b}},
		{"(id:" + a + " AND title:missing) OR title:ok", []string{d, a}}, {"NOT id:05d609a8", []string{d, c}},
		{"NOT 05d609a8", []string{d}}, {"NOT NOT id:" + a, []string{a}}, {"NOT (NOT id:" + a + " OR title:missing)", []string{a}},
	}
	reader := NewTaskSearch(db.Pool)
	for _, tc := range cases {
		t.Run(tc.expression, func(t *testing.T) {
			root, err := query.Parse(tc.expression)
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			var after *store.TaskSearchPosition
			for {
				var page store.TaskSearchPage
				err = reader.ReadTaskSearch(ctx, func(snapshot store.TaskSearchSnapshot) error {
					var err error
					page, err = snapshot.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 1, After: after})
					return err
				})
				if err != nil {
					t.Fatal(err)
				}
				if page.Total != int64(len(tc.want)) {
					t.Fatalf("total=%d want=%d", page.Total, len(tc.want))
				}
				for _, row := range page.Items {
					got = append(got, row.ID)
					var original query.Text
					for _, source := range rows {
						if source.id == row.ID {
							original = query.Text{ID: source.id, Title: source.title, Description: source.description}
							break
						}
					}
					raw := query.Evaluate(root, original)
					if row.ExactIDPriority != raw.ExactID || row.TitlePriority != raw.Title || !raw.Matches {
						t.Fatalf("rank %+v evidence %+v", row, raw)
					}

				}
				if !page.HasMore {
					break
				}
				if len(page.Items) != 1 {
					t.Fatal("missing page item")
				}
				last := page.Items[0]
				after = &store.TaskSearchPosition{ExactIDPriority: last.ExactIDPriority, TitlePriority: last.TitlePriority, UpdatedAt: last.UpdatedAt, ID: last.ID}
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
	t.Run("same timestamp ID tie", func(t *testing.T) {
		const e = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		const f = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
		when := time.Date(2026, 11, 9, 0, 10, 0, 0, time.UTC)
		for _, id := range []string{f, e} {
			if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,updated_at) VALUES($1,$2,'tie',$3)`, id, project, when); err != nil {
				t.Fatal(err)
			}
		}
		root, err := query.Parse("title:tie")
		if err != nil {
			t.Fatal(err)
		}
		var after *store.TaskSearchPosition
		for _, id := range []string{e, f} {
			var page store.TaskSearchPage
			err = reader.ReadTaskSearch(ctx, func(snapshot store.TaskSearchSnapshot) error {
				var err error
				page, err = snapshot.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 1, After: after})
				return err
			})
			if err != nil || len(page.Items) != 1 || page.Items[0].ID != id {
				t.Fatalf("page %+v err %v", page, err)
			}
			last := page.Items[0]
			after = &store.TaskSearchPosition{ExactIDPriority: last.ExactIDPriority, TitlePriority: last.TitlePriority, UpdatedAt: last.UpdatedAt, ID: last.ID}
		}
	})

}
