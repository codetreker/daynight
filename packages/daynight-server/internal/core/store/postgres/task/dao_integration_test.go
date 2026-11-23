package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type fixture struct {
	db                   *postgres.Store
	tx                   pgx.Tx
	project, other, user string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return newFixtureWithStore(t, db)
}

func newFixtureWithStore(t *testing.T, db *postgres.Store) fixture {
	t.Helper()
	f := fixture{db: db, project: uuid.NewString(), other: uuid.NewString(), user: uuid.NewString()}
	for _, p := range []string{f.project, f.other} {
		if _, err := db.Pool.Exec(t.Context(), `INSERT INTO projects(id,name,repo_url) VALUES($1,'DAO test','repo')`, p); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1,$2,'Author',now(),now())`, f.user, f.user); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{`INSERT INTO teams(id,personal_user_id) VALUES($1,$1)`, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$1,'admin')`} {
		if _, err := db.Pool.Exec(t.Context(), statement, f.user); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, f.project, f.user); err != nil {
		t.Fatal(err)
	}
	var err error
	f.tx, err = db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := f.tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("rollback DAO fixture: %v", err)
		}
	})
	return f
}
func mustTask(t *testing.T, w store.TaskWriteDAO, v store.TaskWrite) model.Task {
	t.Helper()
	if v.Status == "" {
		v.Status = model.TaskTodo
	}
	r, e := w.CreateTask(t.Context(), uuid.NewString(), v)
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func mustOK(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
}
func taskIDs(v []model.Task) []string {
	r := []string{}
	for _, x := range v {
		r = append(r, x.ID)
	}
	return r
}

func TestTaskDAOStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "WriterPersistenceDependenciesAndDeletion", testWriterPersistenceDependenciesAndDeletion)
	suite.run(t, "ReaderListsGraphsSyncAndAssignees", testReaderListsGraphsSyncAndAssignees)
	suite.run(t, "TaskHeaderAndTouchReadbackAndMissingErrors", testTaskHeaderAndTouchReadbackAndMissingErrors)
	suite.run(t, "WorkerInventoryFilteringAndThreadSource", testWorkerInventoryFilteringAndThreadSource)
	suite.run(t, "StoredWorkerRoundTrip", testStoredWorkerRoundTrip)
}

func testWriterPersistenceDependenciesAndDeletion(t *testing.T, database *postgres.Store) {
	f := newFixtureWithStore(t, database)
	ctx := t.Context()
	w := task.NewWriter(f.tx, f.project)
	r := task.NewReader(f.tx)
	a := mustTask(t, w, store.TaskWrite{Title: "prerequisite"})
	b := mustTask(t, w, store.TaskWrite{Title: "dependent", Status: model.TaskInProgress, DependsOn: []string{a.ID}, ExternalDependsOn: []string{a.ID}, Properties: model.TaskProperties{"pullRequests": []byte(`[]`)}})
	got, e := w.Task(ctx, b.ID)
	mustOK(t, e)
	if !reflect.DeepEqual(got.DependsOn, []string{a.ID}) || !reflect.DeepEqual(got.ExternalDependsOn, []string{a.ID}) || !reflect.DeepEqual(got.BlockedBy, []string{a.ID}) || got.Ready || got.Properties["pullRequests"] == nil {
		t.Fatalf("dependency/property readback: %+v", got)
	}
	rows, e := w.TasksByID(ctx, []string{a.ID, b.ID})
	mustOK(t, e)
	if len(rows) != 2 {
		t.Fatalf("prerequisites: %+v", rows)
	}
	foreign := mustTask(t, task.NewWriter(f.tx, f.other), store.TaskWrite{Title: "foreign"})
	rows, e = w.TasksByID(ctx, []string{foreign.ID})
	mustOK(t, e)
	if len(rows) != 0 {
		t.Fatal("cross-project task leaked")
	}
	for _, read := range []func(context.Context, string) ([]string, error){w.DependentIDs, w.ActiveDependentIDs} {
		ids, e := read(ctx, a.ID)
		mustOK(t, e)
		if !reflect.DeepEqual(ids, []string{b.ID}) {
			t.Fatalf("dependents: %v", ids)
		}
	}
	for _, c := range []struct {
		from, to    string
		replacement store.DependencyReplacement
		want        bool
	}{{b.ID, a.ID, store.DependencyReplacement{TaskID: b.ID, DependsOn: []string{a.ID}}, true}, {b.ID, a.ID, store.DependencyReplacement{TaskID: b.ID}, false}} {
		yes, e := w.Reachable(ctx, c.from, c.to, c.replacement)
		mustOK(t, e)
		if yes != c.want {
			t.Fatalf("replacement reachability = %v", yes)
		}
	}
	updated, e := w.UpdateTask(ctx, b.ID, store.TaskWrite{Title: "finished", Description: "persisted", Status: model.TaskDone, DependsOn: []string{a.ID}, AssignedTo: &f.user})
	mustOK(t, e)
	if updated.Version != b.Version+1 || updated.CompletedAt == nil || updated.Title != "finished" || len(updated.ExternalDependsOn) != 0 {
		t.Fatalf("updated: %+v", updated)
	}
	observed, e := w.ObservedAt(ctx)
	mustOK(t, e)
	if observed.IsZero() || observed.Location() != time.UTC {
		t.Fatalf("clock: %v", observed)
	}
	_, e = w.DeleteTask(ctx, a.ID, true)
	mustOK(t, e)
	updated, e = w.Task(ctx, b.ID)
	mustOK(t, e)
	if len(updated.DependsOn) != 0 || updated.Version != b.Version+2 {
		t.Fatalf("dependent after delete: %+v", updated)
	}
	presence, e := r.TaskPresence(ctx, f.project, a.ID)
	mustOK(t, e)
	if !presence.Found || presence.DeletedAt == nil {
		t.Fatalf("deleted presence: %+v", presence)
	}
	if _, e = r.Task(ctx, f.project, a.ID); !errors.Is(e, model.ErrNotFound) {
		t.Fatalf("deleted read: %v", e)
	}
	if _, e = w.DeleteTask(ctx, a.ID, false); !errors.Is(e, model.ErrNotFound) {
		t.Fatalf("repeat delete: %v", e)
	}
	if _, e = w.UpdateTask(ctx, uuid.NewString(), store.TaskWrite{Status: model.TaskTodo}); !errors.Is(e, model.ErrNotFound) {
		t.Fatalf("missing update: %v", e)
	}
	if _, e = w.CreateTask(ctx, uuid.NewString(), store.TaskWrite{Properties: model.TaskProperties{"worker": []byte(`{}`)}}); e == nil {
		t.Fatal("invalid worker property accepted")
	}
	if _, e = w.UpdateTask(ctx, b.ID, store.TaskWrite{Properties: model.TaskProperties{"worker": []byte(`{}`)}}); e == nil {
		t.Fatal("invalid worker update accepted")
	}
	mustOK(t, f.tx.Commit(ctx))
	var title string
	mustOK(t, f.db.Pool.QueryRow(ctx, `SELECT title FROM tasks WHERE id=$1`, b.ID).Scan(&title))
	if title != "finished" {
		t.Fatal("committed title missing")
	}
}

func testReaderListsGraphsSyncAndAssignees(t *testing.T, database *postgres.Store) {
	f := newFixtureWithStore(t, database)
	ctx := t.Context()
	w := task.NewWriter(f.tx, f.project)
	r := task.NewReader(f.tx)
	a := mustTask(t, w, store.TaskWrite{Title: "ready long title", AllowAgents: true})
	b := mustTask(t, w, store.TaskWrite{Title: "blocked", DependsOn: []string{a.ID}, AssignedTo: &f.user})
	c := mustTask(t, w, store.TaskWrite{Title: "running", Status: model.TaskInProgress})
	d := mustTask(t, w, store.TaskWrite{Title: "external", Status: model.TaskDone})
	_, e := w.UpdateTask(ctx, b.ID, store.TaskWrite{Title: b.Title, Status: model.TaskTodo, DependsOn: []string{a.ID, d.ID}, ExternalDependsOn: []string{d.ID}, AssignedTo: &f.user})
	mustOK(t, e)
	foreign := mustTask(t, task.NewWriter(f.tx, f.other), store.TaskWrite{Title: "foreign"})
	page, e := r.Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 2}})
	mustOK(t, e)
	if len(page.Items) != 2 || !page.HasMore || page.Items[0].ID != a.ID || page.Items[1].ID != b.ID {
		t.Fatalf("first page: %+v", page)
	}
	page, e = r.Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 10, After: &store.Position{CreatedAt: b.CreatedAt, ID: b.ID}}})
	mustOK(t, e)
	if !reflect.DeepEqual(taskIDs(page.Items), []string{c.ID, d.ID}) || page.HasMore {
		t.Fatalf("continuation: %+v", page)
	}
	for _, c := range []struct {
		filter model.TaskAssignmentFilter
		count  int
	}{{model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned}, 3}, {model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: f.user}, 1}} {
		page, e = r.Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 10}, AssignedTo: c.filter})
		mustOK(t, e)
		if len(page.Items) != c.count {
			t.Fatalf("assignment page: %+v", page)
		}
	}
	ready := true
	page, e = r.Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 10}, Ready: &ready, AllowAgents: &ready})
	mustOK(t, e)
	if len(page.Items) != 1 || page.Items[0].ID != a.ID {
		t.Fatalf("ready: %+v", page)
	}
	priority, e := r.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{Limit: 2})
	mustOK(t, e)
	if len(priority.Items) != 2 || !priority.HasMore || priority.Items[0].Task.ID != c.ID || priority.Items[1].Task.ID != a.ID {
		t.Fatalf("priority: %+v", priority)
	}
	priority, e = r.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{Limit: 10, After: &store.TaskPriorityPosition{Group: 1, CreatedAt: a.CreatedAt, ID: a.ID}})
	mustOK(t, e)
	if len(priority.Items) != 2 || priority.Items[0].Task.ID != b.ID || priority.Items[0].BlockedByCount != 1 {
		t.Fatalf("priority continuation: %+v", priority)
	}
	for _, filter := range []model.TaskAssignmentFilter{{Mode: model.TaskAssignmentUnassigned}, {Mode: model.TaskAssignmentUser, UserID: f.user}} {
		p, e := r.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{Limit: 10, AssignedTo: filter})
		mustOK(t, e)
		if len(p.Items) == 0 {
			t.Fatal("assignment priority empty")
		}
	}
	fence, e := r.TaskListFence(ctx, f.project)
	mustOK(t, e)
	if fence.Count != "4" || fence.VersionSum != "5" {
		t.Fatalf("fence: %+v", fence)
	}
	selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
	graph, e := r.TaskGraphTasks(ctx, f.project, a.ID, selection, 5)
	mustOK(t, e)
	if len(graph) != 3 || graph[0].ID != a.ID || graph[0].TitlePreview != "ready" || !graph[0].TitleTruncated {
		t.Fatalf("graph: %+v", graph)
	}
	epoch, e := r.TaskCacheEpoch(ctx, f.project)
	mustOK(t, e)
	if epoch == "" {
		t.Fatal("empty epoch")
	}
	sync, e := r.TaskSyncTasks(ctx, f.project, nil, 5)
	mustOK(t, e)
	if len(sync) != 4 || sync[0].TitlePreview != "ready" || !sync[0].TitleTruncated {
		t.Fatalf("sync: %+v", sync)
	}
	lower := sync[0].UpdatedAt.Add(time.Nanosecond)
	sync, e = r.TaskSyncTasks(ctx, f.project, &lower, 5)
	mustOK(t, e)
	for _, v := range sync {
		if v.ID == a.ID {
			t.Fatal("nanosecond lower bound rounded down")
		}
	}
	facts, e := r.TaskAssignees(ctx, f.project)
	mustOK(t, e)
	if len(facts) != 1 || facts[0].UserID != f.user || !facts[0].HasProjectAccess {
		t.Fatalf("assignees: %+v", facts)
	}
	missing := uuid.NewString()
	facts, e = r.ResolveTaskAssignees(ctx, f.project, []string{f.user, missing})
	mustOK(t, e)
	if len(facts) != 2 {
		t.Fatalf("resolved: %+v", facts)
	}
	for _, v := range facts {
		if v.UserID == missing && (v.Qualified || v.ProfileID != nil) {
			t.Fatalf("unqualified disclosure: %+v", v)
		}
	}
	if _, e = r.Task(ctx, f.project, foreign.ID); !errors.Is(e, model.ErrNotFound) {
		t.Fatalf("cross-project read: %v", e)
	}
	for _, filter := range []model.TaskAssignmentFilter{{Mode: "bad"}, {UserID: f.user}, {Mode: model.TaskAssignmentUnassigned, UserID: f.user}} {
		if _, e = r.Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 1}, AssignedTo: filter}); e == nil {
			t.Fatal("invalid assignment accepted")
		}
		if _, e = r.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{Limit: 1, AssignedTo: filter}); e == nil {
			t.Fatal("invalid priority assignment accepted")
		}
	}
	if _, e = r.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{Limit: 0}); e == nil {
		t.Fatal("invalid priority limit accepted")
	}
}

func testTaskHeaderAndTouchReadbackAndMissingErrors(t *testing.T, database *postgres.Store) {
	f := newFixtureWithStore(t, database)
	ctx := t.Context()
	w := task.NewWriter(f.tx, f.project)
	r := task.NewReader(f.tx)
	a := mustTask(t, w, store.TaskWrite{Title: "touch"})
	stamp := time.Now().UTC().Truncate(time.Microsecond).Add(time.Second)
	hdr, err := w.TaskHeader(ctx, a.ID)
	mustOK(t, err)
	mustOK(t, w.TouchTask(ctx, a.ID, stamp))
	rh, err := r.TaskHeader(ctx, f.project, a.ID)
	mustOK(t, err)
	if rh.Version != hdr.Version+1 {
		t.Fatal("touch did not advance revision")
	}
	if err = w.TouchTask(ctx, uuid.NewString(), stamp); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing touch: %v", err)
	}
	mustOK(t, f.tx.Commit(ctx))
	var version int64
	var updated time.Time
	mustOK(t, f.db.Pool.QueryRow(ctx, `SELECT version,updated_at FROM tasks WHERE id=$1`, a.ID).Scan(&version, &updated))
	if version != rh.Version || !updated.Equal(stamp) {
		t.Fatalf("committed touch version=%d updated=%v", version, updated)
	}
}

func testWorkerInventoryFilteringAndThreadSource(t *testing.T, database *postgres.Store) {
	f := newFixtureWithStore(t, database)
	ctx := t.Context()
	w := task.NewWriter(f.tx, f.project)
	r := task.NewReader(f.tx)
	worker := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: f.user, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, State: model.WorkerActive, ClaimedAt: time.Now().UTC()}
	raw, e := taskproperties.EncodeWorker(&worker)
	mustOK(t, e)
	mustTask(t, w, store.TaskWrite{Title: "without worker"})
	a := mustTask(t, w, store.TaskWrite{Title: "active", Properties: model.TaskProperties{"worker": raw}})
	mustTask(t, w, store.TaskWrite{Title: "released without current worker"})
	b := mustTask(t, w, store.TaskWrite{Title: "second active", Properties: model.TaskProperties{"worker": raw}})
	q := store.TaskQuery{Page: store.Page{Limit: 1}, Worker: &store.WorkerQuery{UserID: f.user, WorkerID: worker.WorkerID}}
	page, e := r.Tasks(ctx, f.project, q)
	mustOK(t, e)
	if len(page.Items) != 1 || page.Items[0].ID != a.ID || !page.HasMore {
		t.Fatalf("worker first page: %+v", page)
	}
	q.Page.After = &store.Position{CreatedAt: a.CreatedAt, ID: a.ID}
	page, e = r.Tasks(ctx, f.project, q)
	mustOK(t, e)
	if len(page.Items) != 1 || page.Items[0].ID != b.ID || page.HasMore {
		t.Fatalf("worker second page: %+v", page)
	}
	q.Worker.UserID = uuid.NewString()
	page, e = r.Tasks(ctx, f.project, q)
	mustOK(t, e)
	if len(page.Items) != 0 {
		t.Fatal("another user received worker inventory")
	}
	source, e := task.NewThreadDAO(f.tx).SourceTask(ctx, f.project, a.ID)
	mustOK(t, e)
	decoded, e := taskproperties.Worker(source.Properties)
	mustOK(t, e)
	if decoded.ClaimID != worker.ClaimID || decoded.State != model.WorkerActive {
		t.Fatalf("thread source worker: %+v", decoded)
	}
}

// Persisted worker documents may predate the current admission contract.
func testStoredWorkerRoundTrip(t *testing.T, database *postgres.Store) {
	f := newFixtureWithStore(t, database)
	ctx := t.Context()
	w := task.NewWriter(f.tx, f.project)
	want := make(map[string]model.WorkerClaim)
	for _, mode := range []model.WorkerAgentControlMode{model.AgentControlModeWeb, model.AgentControlModeHerdr} {
		claim := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: f.user, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine 中文"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: mode, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, State: model.WorkerActive, ClaimedAt: time.Now().UTC()}
		if mode == model.AgentControlModeHerdr {
			claim.Herdr = &model.WorkerHerdr{Session: "会话\n&", WorkspaceID: "workspace", PaneID: "pane"}
		}
		raw, err := taskproperties.EncodeWorker(&claim)
		mustOK(t, err)
		if mode == model.AgentControlModeWeb {
			var doc map[string]json.RawMessage
			mustOK(t, json.Unmarshal(raw, &doc))
			delete(doc, "herdr")
			raw, err = json.Marshal(doc)
			mustOK(t, err)
		}
		item := mustTask(t, w, store.TaskWrite{Title: "stored worker"})
		want[item.ID] = claim
		_, err = f.tx.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, item.ID, string(raw))
		mustOK(t, err)
		loaded, err := w.Task(ctx, item.ID)
		mustOK(t, err)
		got, err := taskproperties.Worker(loaded.Properties)
		mustOK(t, err)
		if got.AgentControlMode != mode || !reflect.DeepEqual(got.Herdr, claim.Herdr) {
			t.Fatalf("stored %s worker: %+v", mode, got)
		}
		updated, err := w.UpdateTask(ctx, item.ID, store.TaskWrite{Title: "updated", Status: model.TaskTodo, Properties: loaded.Properties})
		mustOK(t, err)
		got, err = taskproperties.Worker(updated.Properties)
		mustOK(t, err)
		if got.AgentControlMode != mode || !reflect.DeepEqual(got.Herdr, claim.Herdr) {
			t.Fatalf("updated %s worker: %+v", mode, got)
		}
	}
	mustOK(t, f.tx.Commit(ctx))
	readTx, err := database.Pool.Begin(ctx)
	mustOK(t, err)
	defer readTx.Rollback(ctx)
	r := task.NewReader(readTx)
	for id, claim := range want {
		loaded, err := r.Task(ctx, f.project, id)
		mustOK(t, err)
		got, err := taskproperties.Worker(loaded.Properties)
		mustOK(t, err)
		if got.ClaimID != claim.ClaimID || got.AgentControlMode != claim.AgentControlMode || !reflect.DeepEqual(got.Herdr, claim.Herdr) {
			t.Fatalf("committed worker: %+v", got)
		}
	}
}
