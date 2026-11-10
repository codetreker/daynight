package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestTaskSearchStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "TaskSearchRejectsInvalidDAOInputs", testTaskSearchRejectsInvalidDAOInputs)
	suite.run(t, "TaskSearchReadFailuresDoNotBecomeResults", testTaskSearchReadFailuresDoNotBecomeResults)
	suite.run(t, "TaskSearchSQLMatchesEvidenceAndPaginates", testTaskSearchSQLMatchesEvidenceAndPaginates)
	suite.run(t, "TaskSearchContextAndFence", testTaskSearchContextAndFence)
	suite.run(t, "TaskSearchIDOrderingAndPagination", testTaskSearchIDOrderingAndPagination)
	suite.run(t, "TaskSearchFenceTracksCommittedDAOMutations", testTaskSearchFenceTracksCommittedDAOMutations)
}

func testTaskSearchRejectsInvalidDAOInputs(t *testing.T, db *postgres.Store) {
	valid := &tasksearch.Node{Kind: tasksearch.Leaf, Atom: tasksearch.Atom{Field: tasksearch.AnyField, Term: "word"}}
	invalid := []*tasksearch.Node{nil, {Kind: tasksearch.Leaf}, {Kind: tasksearch.Leaf, Atom: tasksearch.Atom{Field: tasksearch.Field(255), Term: "word"}}, {Kind: tasksearch.Kind(255)}, {Kind: tasksearch.And, Left: nil, Right: valid}, {Kind: tasksearch.Or, Left: valid, Right: nil}}
	err := postgres.NewTaskSearch(db.Pool).ReadTaskSearch(context.Background(), func(s store.TaskSearchSnapshot) error {
		for _, node := range invalid {
			if _, err := s.Matches(context.Background(), uuid.NewString(), store.TaskSearchQuery{Expression: node, Limit: 1}); err == nil {
				t.Fatalf("accepted invalid expression: %+v", node)
			}
		}
		for _, input := range []store.TaskSearchQuery{{Expression: valid, Limit: 0}, {Expression: valid, Limit: 101}, {Expression: valid, Limit: 1, AssignedTo: model.TaskAssignmentFilter{Mode: "invalid"}}} {
			if _, err := s.Matches(context.Background(), uuid.NewString(), input); err == nil {
				t.Errorf("accepted invalid query %+v", input)
			}
		}

		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func testTaskSearchReadFailuresDoNotBecomeResults(t *testing.T, db *postgres.Store) {
	ctx := context.Background()
	project, a, b := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$3,'a'),($2,$3,'b')`, a, b, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project, b, a); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name                    string
		failAt                  int
		scan, iteration, titles bool
	}{
		{"nodes query", 1, false, false, false}, {"nodes scan", 1, true, false, false}, {"nodes iteration", 1, false, true, false},
		{"edges query", 2, false, false, false}, {"edges scan", 2, true, false, false}, {"edges iteration", 2, false, true, false},
		{"titles query", 1, false, false, true}, {"titles scan", 1, true, false, true}, {"titles iteration", 1, false, true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := postgres.ReadOnlySnapshot(ctx, db.Pool, func(tx pgx.Tx) error {
				s := task.NewSearchSnapshot(&readerFaultQueryTx{Tx: tx, failAt: test.failAt, scan: test.scan, iteration: test.iteration})
				var err error
				if test.titles {
					_, err = s.Titles(ctx, project, []string{a})
				} else {
					_, err = s.ContextGraph(ctx, project, []string{a})
				}
				if !errors.Is(err, readerInjectedReadFailure) {
					t.Fatalf("lost cause: %v", err)
				}
				var wrapped *store.Error
				if !errors.As(err, &wrapped) || strings.Contains(err.Error(), readerInjectedReadFailure.Error()) {
					t.Fatalf("unsafe or unwrapped error: %v", err)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, read := range []func(store.TaskSearchSnapshot) error{
		func(s store.TaskSearchSnapshot) error { _, err := s.Fence(ctx, uuid.NewString()); return err },
		func(s store.TaskSearchSnapshot) error {
			_, err := s.ContextGraph(ctx, "not-a-uuid", []string{a})
			return err
		},
	} {
		err := postgres.NewTaskSearch(db.Pool).ReadTaskSearch(ctx, read)
		if err == nil {
			t.Fatal("database failure became success")
		}
		var failure *store.Error
		if !errors.As(err, &failure) {
			t.Fatalf("missing store failure: %v", err)
		}
	}
}

var readerInjectedReadFailure = errors.New("injected read failure")

type readerFaultQueryTx struct {
	pgx.Tx
	failAt, calls   int
	scan, iteration bool
}

func (tx *readerFaultQueryTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	tx.calls++
	if tx.calls == tx.failAt && !tx.scan && !tx.iteration {
		return nil, readerInjectedReadFailure
	}
	rows, err := tx.Tx.Query(ctx, sql, args...)
	if err != nil || tx.calls != tx.failAt {
		return rows, err
	}
	return &readerFaultQueryRows{Rows: rows, scan: tx.scan, iteration: tx.iteration}, nil
}

type readerFaultQueryRows struct {
	pgx.Rows
	scan, iteration bool
}

func (r *readerFaultQueryRows) Scan(dest ...any) error {
	if r.scan {
		return readerInjectedReadFailure
	}
	return r.Rows.Scan(dest...)
}

func (r *readerFaultQueryRows) Err() error {
	if r.iteration {
		return readerInjectedReadFailure
	}
	return r.Rows.Err()
}

func testTaskSearchSQLMatchesEvidenceAndPaginates(t *testing.T, db *postgres.Store) {
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
	reader := postgres.NewTaskSearch(db.Pool)
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

func testTaskSearchContextAndFence(t *testing.T, db *postgres.Store) {
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
	err := postgres.NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
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

func testTaskSearchIDOrderingAndPagination(t *testing.T, db *postgres.Store) {
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
	reader := postgres.NewTaskSearch(db.Pool)
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

func testTaskSearchFenceTracksCommittedDAOMutations(t *testing.T, database *postgres.Store) {
	project := readerProject(t, database, 1)
	target := readerTask(t, database, project.ID, 11, model.TaskTodo)
	predecessor := readerTask(t, database, project.ID, 12, model.TaskTodo)
	ctx := t.Context()
	initial := readerSearchFence(t, database, project.ID)
	if initial.Count != "2" || initial.VersionSum != "2" || initial.Epoch == "" {
		t.Fatalf("unexpected initial fence: %+v", initial)
	}

	check := func(t *testing.T, creates, replacesEpoch bool, operation func(store.ProjectWriteScope) error) {
		t.Helper()
		before := readerSearchFence(t, database, project.ID)
		completion, err := database.WriteProject(ctx, project.ID, operation)
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("DAO mutation did not commit: %+v %v", completion, err)
		}
		after := readerSearchFence(t, database, project.ID)
		expected := before
		if replacesEpoch {
			if after.Epoch == before.Epoch || after.Epoch == "" {
				t.Fatalf("cache invalidation retained epoch: %+v -> %+v", before, after)
			}
			expected.Epoch = after.Epoch
		} else {
			expected.VersionSum = readerFenceIncrement(t, before.VersionSum)
			if creates {
				expected.Count = readerFenceIncrement(t, before.Count)
			}
		}
		if after != expected {
			t.Fatalf("committed DAO fence: got %+v, want %+v (before %+v)", after, expected, before)
		}
	}

	t.Run("create", func(t *testing.T) {
		check(t, true, false, func(scope store.ProjectWriteScope) error {
			_, err := scope.TaskDAO().CreateTask(ctx, readerID(13), store.TaskWrite{Title: "New", Status: model.TaskTodo})
			return err
		})
	})

	for _, mutation := range []struct {
		name   string
		values func(*store.TaskWrite)
	}{
		{"title", func(values *store.TaskWrite) { values.Title = "Changed title" }},
		{"description", func(values *store.TaskWrite) { values.Description = "Changed description" }},
		{"assignment", func(values *store.TaskWrite) { assignee := readerID(20); values.AssignedTo = &assignee }},
		{"platform", func(values *store.TaskWrite) { platform := model.PlatformLinux; values.RequiredPlatform = &platform }},
		{"agent permission", func(values *store.TaskWrite) { values.AllowAgents = true }},
		{"dependency", func(values *store.TaskWrite) { values.DependsOn = []string{predecessor.ID} }},
		{"property", func(values *store.TaskWrite) {
			values.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[]`)}
		}},
		{"status", func(values *store.TaskWrite) { values.Status = model.TaskInProgress }},
		{"worker claim", func(values *store.TaskWrite) {
			values.Properties = readerTaskProperties(t, readerWorkerClaim(11, readerID(20), readerID(21), model.WorkerActive))
		}},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			before := target
			values := readerMutationValues(target)
			mutation.values(&values)
			check(t, false, false, func(scope store.ProjectWriteScope) error {
				var err error
				target, err = scope.TaskDAO().UpdateTask(ctx, target.ID, values)
				return err
			})
			stored := readerSnapshotTask(t, database, project.ID, target.ID)
			if target.Version != before.Version+1 || !reflect.DeepEqual(stored, target) || !reflect.DeepEqual(readerMutationValues(stored), values) {
				t.Fatalf("mutation result did not match persistent version: %+v %+v", target, stored)
			}
		})
	}

	t.Run("step parent revision", func(t *testing.T) {
		check(t, false, false, func(scope store.ProjectWriteScope) error {
			dao := scope.TaskDAO()
			observed, err := dao.ObservedAt(ctx)
			if err != nil {
				return err
			}
			if err := dao.InsertTaskStep(ctx, target.ID, model.TaskStep{ID: "abcdef01", Position: 0, Title: "Step", Status: model.TaskStepTodo, CreatedAt: observed, UpdatedAt: observed}); err != nil {
				return err
			}
			return dao.TouchTask(ctx, target.ID, observed)
		})
		target = readerSnapshotTask(t, database, project.ID, target.ID)
	})

	t.Run("soft deletion retains row in fence", func(t *testing.T) {
		check(t, false, false, func(scope store.ProjectWriteScope) error {
			_, err := scope.TaskDAO().DeleteTask(ctx, readerID(13), false)
			return err
		})
	})

	t.Run("history epoch replacement", func(t *testing.T) {
		check(t, false, true, func(scope store.ProjectWriteScope) error {
			return scope.ProjectDAO().InvalidateTaskCache(ctx)
		})
	})

}

func readerSearchFence(t *testing.T, database *postgres.Store, projectID string) store.TaskSearchFence {
	t.Helper()
	var fence store.TaskSearchFence
	if err := postgres.NewTaskSearch(database.Pool).ReadTaskSearch(t.Context(), func(snapshot store.TaskSearchSnapshot) error {
		var err error
		fence, err = snapshot.Fence(t.Context(), projectID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return fence
}

func readerFenceIncrement(t *testing.T, number string) string {
	t.Helper()
	value, valid := new(big.Int).SetString(number, 10)
	if !valid {
		t.Fatalf("invalid decimal fence value %q", number)
	}
	return value.Add(value, big.NewInt(1)).String()
}
