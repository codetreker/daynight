package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestTaskAssigneeStoreCatalogueAndBoundedResolution(t *testing.T) {
	database := readerStore(t)
	project, other := readerProject(t, database, 1), readerProject(t, database, 2)
	current := readerAssigneeUser(t, database, project.ID, 101, true)
	named := readerAssigneeUser(t, database, project.ID, 102, true)
	former := readerAssigneeUser(t, database, project.ID, 103, true)
	deleted := readerAssigneeUser(t, database, project.ID, 104, true)
	foreign := readerAssigneeUser(t, database, other.ID, 105, true)
	unrelated := readerAssigneeUser(t, database, project.ID, 106, false)
	name, avatar := "Canonical name", "https://images.example.test/person.png"
	readerExec(t, database, `UPDATE users SET name=$2,avatar_url=$3 WHERE id=$1`, named, name, avatar)
	for _, seed := range []struct {
		projectID, userID string
		number            int
		status            model.TaskStatus
	}{
		{project.ID, named, 11, model.TaskTodo}, {project.ID, former, 12, model.TaskDone},
		{project.ID, former, 13, model.TaskInProgress}, {project.ID, deleted, 14, model.TaskTodo},
		{other.ID, foreign, 15, model.TaskTodo},
	} {
		readerTask(t, database, seed.projectID, seed.number, seed.status)
		readerExec(t, database, `UPDATE tasks SET assigned_to=$2 WHERE id=$1`, readerID(seed.number), seed.userID)
	}
	readerExec(t, database, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, readerID(14))
	readerExec(t, database, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=ANY($2::uuid[])`, project.ID, []string{former, deleted})
	var before string
	if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	catalogue, err := readerAssigneeRead(t, database, project.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	var ownerID string
	if err := database.Pool.QueryRow(context.Background(), `SELECT personal_user_id::text FROM teams WHERE id=$1`, project.Ownership.TeamID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	readerAssertAssignees(t, catalogue, map[string]bool{ownerID: true, current: true, named: true, former: false}, nil)
	people := make(map[string]model.TaskAssigneeFact, len(catalogue))
	for _, person := range catalogue {
		people[person.UserID] = person
	}
	if people[current].Name != nil || people[current].AvatarURL != nil || people[named].Name == nil || *people[named].Name != name || people[named].AvatarURL == nil || *people[named].AvatarURL != avatar {
		t.Fatalf("nullable canonical profile facts changed: %#v", catalogue)
	}
	requested := []string{current, former, deleted, foreign, unrelated, readerID(107)}
	resolved, err := readerAssigneeRead(t, database, project.ID, requested)
	if err != nil {
		t.Fatal(err)
	}
	readerAssertAssignees(t, resolved, map[string]bool{current: true, former: false}, []string{deleted, foreign, unrelated, readerID(107)})
	var after string
	if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t`).Scan(&after); err != nil || before != after {
		t.Fatal("people reads changed task facts", err)
	}
	empty, err := readerAssigneeRead(t, database, readerID(999), nil)
	if err != nil {
		t.Fatal(err)
	}
	readerAssertAssignees(t, empty, map[string]bool{}, nil)
}

func TestTaskAssigneeStorePreservesMissingQualifiedProfileFacts(t *testing.T) {
	for _, retained := range []bool{false, true} {
		database := readerStore(t)
		project := readerProject(t, database, 1)
		readerAssigneeUser(t, database, project.ID, 101, true)
		missing := readerAssigneeUser(t, database, project.ID, 102, true)
		if retained {
			readerTask(t, database, project.ID, 11, model.TaskDone)
			readerExec(t, database, `UPDATE tasks SET assigned_to=$2 WHERE id=$1`, readerID(11), missing)
			readerExec(t, database, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, missing)
		}
		readerExec(t, database, `DELETE FROM users WHERE id=$1`, missing)
		resolved, err := readerAssigneeRead(t, database, project.ID, []string{readerID(101)})
		if err != nil {
			t.Fatalf("unrequested missing profile broke bounded resolution: %v", err)
		}
		readerAssertAssignees(t, resolved, map[string]bool{readerID(101): true}, nil)
		for _, ids := range [][]string{nil, {readerID(101), missing}} {
			result, err := readerAssigneeRead(t, database, project.ID, ids)
			if err != nil {
				t.Fatal(err)
			}
			var absent *model.TaskAssigneeFact
			for index := range result {
				if result[index].UserID == missing {
					absent = &result[index]
				}
			}
			if absent == nil || absent.ProfileID != nil || absent.HasProjectAccess == retained || ids != nil && !absent.Qualified {
				t.Fatalf("missing qualified profile facts lost: %#v", result)
			}

		}
	}
}

func TestTaskAssigneeStoreQueryAndRowFailuresPreserveCauses(t *testing.T) {
	for _, kind := range []string{"query", "scan", "iteration"} {
		database := readerStore(t)
		project := readerProject(t, database, 1)
		readerAssigneeUser(t, database, project.ID, 101, true)
		readerAssigneeUser(t, database, project.ID, 102, true)
		switch kind {
		case "query":
			readerExec(t, database, `DROP TABLE tasks CASCADE`)
		case "scan":
			readerExec(t, database, `ALTER TABLE users RENAME TO assignee_user_source;
				CREATE VIEW users AS SELECT id,uniauth_id,email,email_verified,'\x01'::bytea AS name,avatar_url,created_at,updated_at FROM assignee_user_source`)
		case "iteration":
			readerExec(t, database, `CREATE FUNCTION refuse_assignee_profile(id uuid) RETURNS text LANGUAGE plpgsql AS $$
				BEGIN IF id='00000000-0000-4000-8000-000000000102'::uuid THEN RAISE EXCEPTION USING ERRCODE='P1032',MESSAGE='private profile diagnostic'; END IF; RETURN 'Visible'; END $$;
				ALTER TABLE users RENAME TO assignee_user_source;
				CREATE VIEW users AS SELECT id,uniauth_id,email,email_verified,refuse_assignee_profile(id) AS name,avatar_url,created_at,updated_at FROM assignee_user_source`)
		}
		for _, resolve := range []bool{false, true} {
			var ids []string
			if resolve {
				ids = []string{readerID(101), readerID(102)}
			}
			result, err := readerAssigneeRead(t, database, project.ID, ids)
			var failure *Error
			if !errors.As(err, &failure) || len(result) != 0 || strings.Contains(err.Error(), "private profile") {
				t.Fatalf("%s failure became partial or unsafe: %#v %v", kind, result, err)
			}
			if kind == "query" || kind == "iteration" {
				var cause *pgconn.PgError
				code := "42P01"
				if kind == "iteration" {
					code = "P1032"
				}
				if !errors.As(err, &cause) || cause.Code != code {
					t.Fatalf("%s failure lost PostgreSQL cause: %v", kind, err)
				}
			}
		}
	}
}

func TestTaskAssigneeStoreQueryCancellation(t *testing.T) {
	for _, resolve := range []bool{false, true} {
		database := readerStore(t)
		project := readerProject(t, database, 1)
		readerAssigneeUser(t, database, project.ID, 101, true)
		ctx, cancel := context.WithCancel(context.Background())
		config := database.Pool.Config()
		config.ConnConfig.Tracer = readerAssigneeCancelTracer{cancel: cancel}
		pool, err := pgxpool.NewWithConfig(context.Background(), config)
		if err != nil {
			t.Fatal(err)
		}
		traced := &postgres.Store{Pool: pool}
		var result []model.TaskAssigneeFact
		err = traced.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			var err error
			if resolve {
				result, err = snapshot.TaskDAO().ResolveTaskAssignees(ctx, project.ID, []string{readerID(101)})
			} else {
				result, err = snapshot.TaskDAO().TaskAssignees(ctx, project.ID)
			}
			return err
		})
		cancel()
		pool.Close()
		if !errors.Is(err, context.Canceled) || len(result) != 0 {
			t.Fatalf("directory cancellation lost cause or returned data: %#v %v", result, err)
		}
	}
}

func TestTaskAssignmentStoreFiltersAndInvalidSelectors(t *testing.T) {
	database := readerStore(t)
	project := readerProject(t, database, 1)
	first := readerTask(t, database, project.ID, 11, model.TaskTodo)
	second := readerTask(t, database, project.ID, 12, model.TaskTodo)
	readerTask(t, database, project.ID, 13, model.TaskTodo)
	userID := readerID(101)
	readerExec(t, database, `UPDATE tasks SET assigned_to=$2 WHERE id=$1`, second.ID, userID)
	for _, test := range []struct {
		filter model.TaskAssignmentFilter
		want   []string
	}{
		{model.TaskAssignmentFilter{}, []string{first.ID, second.ID, readerID(13)}},
		{model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned}, []string{first.ID, readerID(13)}},
		{model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: userID}, []string{second.ID}},
	} {
		if err := database.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
			page, err := snapshot.TaskDAO().Tasks(context.Background(), project.ID, TaskQuery{Page: Page{Limit: 10}, AssignedTo: test.filter})
			var ids []string
			for _, item := range page.Items {
				ids = append(ids, item.ID)
			}
			if err != nil || !slices.Equal(ids, test.want) || page.HasMore {
				t.Fatalf("native assignment selector: %#v got %v want %v, %v", test.filter, ids, test.want, err)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, invalid := range []model.TaskAssignmentFilter{{Mode: model.TaskAssignmentAll, UserID: userID}, {Mode: model.TaskAssignmentUnassigned, UserID: userID}, {Mode: "unknown"}} {
		err := database.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
			page, err := snapshot.TaskDAO().Tasks(context.Background(), project.ID, TaskQuery{Page: Page{Limit: 10}, AssignedTo: invalid})
			if len(page.Items) != 0 {
				t.Fatal("invalid selector returned an unfiltered page")
			}
			return err
		})
		if err == nil {
			t.Fatalf("invalid assignment selector silently became all: %#v", invalid)
		}
	}
}

type readerAssigneeCancelTracer struct{ cancel context.CancelFunc }

func (tracer readerAssigneeCancelTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.HasPrefix(data.SQL, "WITH candidate_ids") || strings.HasPrefix(data.SQL, "SELECT requested.user_id::text") {
		tracer.cancel()
	}
	return ctx
}

func (readerAssigneeCancelTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestTaskPlatformSpecificFiltersBeforePagination(t *testing.T) {
	database := readerStore(t)
	project := readerProject(t, database, 1)
	rows := []model.Task{}
	for _, number := range []int{11, 12, 13, 14, 15} {
		rows = append(rows, readerTask(t, database, project.ID, number, model.TaskTodo))
	}
	instant := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	actor := readerID(100)
	readerExec(t, database, "UPDATE tasks SET created_at=$1, allow_agents=true, assigned_to=$2", instant, actor)
	readerExec(t, database, "UPDATE tasks SET required_platform='windows' WHERE id=$1", rows[1].ID)
	readerExec(t, database, "UPDATE tasks SET required_platform='macos' WHERE id IN ($1,$2)", rows[2].ID, rows[4].ID)
	yes, no := true, false
	macos := model.PlatformMacOS
	for _, test := range []struct {
		name string
		tier *bool
		ids  []string
	}{
		{"compatible", nil, []string{rows[0].ID, rows[2].ID, rows[3].ID, rows[4].ID}},
		{"specific", &yes, []string{rows[2].ID, rows[4].ID}},
		{"unrestricted", &no, []string{rows[0].ID, rows[3].ID}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := database.ReadSnapshot(context.Background(), func(scope SnapshotScope) error {
				query := TaskQuery{Page: Page{Limit: 1}, Ready: &yes, AllowAgents: &yes, CompatiblePlatform: &macos, PlatformSpecific: test.tier, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: actor}}
				ids := []string{}
				for {
					page, err := scope.TaskDAO().Tasks(t.Context(), project.ID, query)
					if err != nil {
						return err
					}
					if len(page.Items) != 1 {
						t.Fatalf("page=%#v", page)
					}
					last := page.Items[0]
					ids = append(ids, last.ID)
					if !page.HasMore {
						break
					}
					if len(ids) >= len(test.ids) {
						t.Fatalf("unexpected extra page: %v", ids)
					}
					query.Page.After = &Position{CreatedAt: last.CreatedAt, ID: last.ID}
				}
				if !reflect.DeepEqual(ids, test.ids) {
					t.Fatalf("ids=%v want=%v", ids, test.ids)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWorkerInventoryReadsOpaquePropertiesWithoutPostgresJSONConversion(t *testing.T) {
	database := readerStore(t)
	project := readerProject(t, database, 1)
	owner, workerID := readerID(2), readerID(3)
	for number := 10; number < 14; number++ {
		readerTask(t, database, project.ID, number, model.TaskInProgress)
		claim := &model.WorkerClaim{ClaimID: readerID(number + 100), State: model.WorkerActive, UserID: owner, WorkerID: workerID,
			Machine: model.WorkerMachine{ID: readerID(4), Name: "Machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: readerID(number + 200), Phase: model.WorkerPreparing, ClaimedAt: time.Now().UTC()}
		if number < 12 {
			claim.UserID = readerID(5)
		}
		properties := readerTaskProperties(t, claim)
		readerPutProperty(t, database, readerID(number), "worker", properties["worker"])
		readerPutProperty(t, database, readerID(number), "pullRequests", []byte(`[{"url":"\u0000","title":"\ud800"}]`))
	}
	query := TaskQuery{Page: Page{Limit: 1}, Worker: &WorkerQuery{UserID: owner, WorkerID: workerID}}
	for _, number := range []int{12, 13} {
		var page TaskPage
		err := database.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
			var err error
			page, err = snapshot.TaskDAO().Tasks(context.Background(), project.ID, query)
			return err
		})
		if err != nil || len(page.Items) != 1 || page.Items[0].ID != readerID(number) || page.HasMore != (number == 12) {
			t.Fatalf("opaque ownership page %d: %#v, %v", number, page, err)
		}
		prs := readerPullRequests(t, page.Items[0].Properties)
		if len(prs) != 1 || prs[0].URL != "\x00" || prs[0].Title != "\ufffd" {
			t.Fatalf("opaque PR string semantics changed: %#v", prs)
		}
		var stored string
		if err := database.Pool.QueryRow(context.Background(), `SELECT value FROM task_properties WHERE task_id=$1 AND name='pullRequests'`, readerID(number)).Scan(&stored); err != nil || !strings.Contains(stored, `"title":"\ud800"`) {
			t.Fatalf("read changed unpaired Unicode bytes: %q %v", stored, err)
		}
		query.Page.After = &Position{CreatedAt: page.Items[0].CreatedAt, ID: page.Items[0].ID}
	}
}

func TestTaskPriorityListFiltersBeforeLimitAndFence(t *testing.T) {
	db := readerStore(t)
	ctx := context.Background()
	project := readerProject(t, db, 1)
	done := readerTask(t, db, project.ID, 10, model.TaskDone)
	ready := readerTask(t, db, project.ID, 12, model.TaskTodo)
	blocked := readerTask(t, db, project.ID, 11, model.TaskTodo, ready.ID)
	active := readerTask(t, db, project.ID, 13, model.TaskInProgress)
	deleted := readerTask(t, db, project.ID, 14, model.TaskDone)
	readerExec(t, db, `UPDATE tasks SET title=$2 WHERE id=$1`, blocked.ID, strings.Repeat("界", 600))
	readerExec(t, db, `UPDATE tasks SET deleted_at=now(),version=version+1 WHERE id=$1`, deleted.ID)
	read := func(q TaskPriorityQuery) (TaskPriorityPage, TaskListFence) {
		t.Helper()
		var page TaskPriorityPage
		var fence TaskListFence
		err := db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			var err error
			fence, err = snapshot.TaskDAO().TaskListFence(ctx, project.ID)
			if err != nil {
				return err
			}
			page, err = snapshot.TaskDAO().TaskPriorityList(ctx, project.ID, q)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return page, fence
	}
	first, fence := read(TaskPriorityQuery{Limit: 2})
	if fence.Count != "5" || fence.VersionSum != "6" {
		t.Fatalf("fence did not include deleted row: %+v", fence)
	}
	ids := func(page TaskPriorityPage) []string {
		out := []string{}
		for _, task := range page.Items {
			out = append(out, task.Task.ID)
		}
		return out
	}
	if !first.HasMore || !reflect.DeepEqual(ids(first), []string{active.ID, ready.ID}) {
		t.Fatalf("first page: %+v", first)
	}
	last := first.Items[1]
	second, _ := read(TaskPriorityQuery{Limit: 2, After: &TaskPriorityPosition{Group: 1, CreatedAt: last.Task.CreatedAt, ID: last.Task.ID}})
	if second.HasMore || !reflect.DeepEqual(ids(second), []string{blocked.ID, done.ID}) {
		t.Fatalf("second page: %+v", second)
	}
	summary := second.Items[0]
	if !summary.TitleTruncated || summary.BlockedByCount != 1 || len([]rune(summary.Task.Title)) != 513 || summary.Task.Description != "" || len(summary.Task.BlockedBy) != 0 || len(summary.Task.Properties) != 0 {
		t.Fatalf("summary was not bounded or lost metadata: %+v", summary)
	}
	readyOnly := true
	filtered, _ := read(TaskPriorityQuery{Limit: 1, Ready: &readyOnly})
	if filtered.HasMore || !reflect.DeepEqual(ids(filtered), []string{ready.ID}) {
		t.Fatalf("filtered page: %+v", filtered)
	}
	withoutDone, _ := read(TaskPriorityQuery{Limit: 10, ExcludeTerminal: true})
	if !reflect.DeepEqual(ids(withoutDone), []string{active.ID, ready.ID, blocked.ID}) {
		t.Fatalf("exclude done: %+v", withoutDone)
	}
	actor := readerID(25)
	readerExec(t, db, `UPDATE tasks SET assigned_to=$2,allow_agents=true,required_platform='linux' WHERE id=$1`, ready.ID, actor)
	readerExec(t, db, `UPDATE tasks SET created_at='2026-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])`, []string{ready.ID, blocked.ID})
	todo := model.TaskTodo
	linux := model.PlatformLinux
	yes := true
	assigned, _ := read(TaskPriorityQuery{Limit: 1, Status: &todo, Ready: &yes, AllowAgents: &yes, CompatiblePlatform: &linux, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: actor}})
	if assigned.HasMore || !reflect.DeepEqual(ids(assigned), []string{ready.ID}) {
		t.Fatalf("combined filters: %+v", assigned)
	}
	unassigned, _ := read(TaskPriorityQuery{Limit: 10, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned}})
	if !reflect.DeepEqual(ids(unassigned), []string{active.ID, blocked.ID, done.ID}) {
		t.Fatalf("unassigned: %+v", unassigned)
	}
	other := model.PlatformWindows
	incompatible, _ := read(TaskPriorityQuery{Limit: 10, CompatiblePlatform: &other})
	if !reflect.DeepEqual(ids(incompatible), []string{active.ID, blocked.ID, done.ID}) {
		t.Fatalf("platform: %+v", incompatible)
	}
	updated := readFence(t, db, project.ID)
	if updated != fence {
		t.Fatalf("unexpected fence change: %+v", updated)
	}
	readerExec(t, db, `UPDATE tasks SET version=version+1 WHERE id=$1`, deleted.ID)
	if readFence(t, db, project.ID) == fence {
		t.Fatal("deleted task version did not change fence")
	}
	ready2 := readerTask(t, db, project.ID, 15, model.TaskTodo)
	readerExec(t, db, `UPDATE tasks SET created_at='2026-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])`, []string{ready.ID, ready2.ID})
	tied, _ := read(TaskPriorityQuery{Limit: 1, Ready: &readyOnly})
	if !tied.HasMore || !reflect.DeepEqual(ids(tied), []string{ready.ID}) {
		t.Fatalf("UUID tie order: %+v", tied)
	}
	tieLast := tied.Items[0].Task
	tieNext, _ := read(TaskPriorityQuery{Limit: 1, Ready: &readyOnly, After: &TaskPriorityPosition{Group: 1, CreatedAt: tieLast.CreatedAt, ID: tieLast.ID}})
	if tieNext.HasMore || !reflect.DeepEqual(ids(tieNext), []string{ready2.ID}) {
		t.Fatalf("UUID tie continuation: %+v", tieNext)
	}
}

func readFence(t *testing.T, db *postgres.Store, project string) TaskListFence {
	t.Helper()
	var fence TaskListFence
	err := db.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
		var err error
		fence, err = snapshot.TaskDAO().TaskListFence(context.Background(), project)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return fence
}

func TestTaskPriorityListRejectsInvalidDAOInputs(t *testing.T) {
	db := readerStore(t)
	ctx := context.Background()
	project := readerProject(t, db, 1)
	queries := []TaskPriorityQuery{
		{Limit: 0}, {Limit: 101},
		{Limit: 1, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll, UserID: readerID(9)}},
		{Limit: 1, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned, UserID: readerID(9)}},
		{Limit: 1, AssignedTo: model.TaskAssignmentFilter{Mode: "invalid"}},
	}
	err := db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		for _, q := range queries {
			page, err := snapshot.TaskDAO().TaskPriorityList(ctx, project.ID, q)
			if err == nil || len(page.Items) != 0 {
				t.Fatalf("accepted invalid query %+v: %+v %v", q, page, err)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTaskPriorityListStorageFailures(t *testing.T) {
	for _, test := range []struct {
		name, ddl string
		fence     bool
	}{
		{"fence query", `DROP TABLE tasks`, true},
		{"list query", `DROP TABLE task_dependencies`, false},
		{"decode", `ALTER TABLE tasks RENAME TO task_source; CREATE VIEW tasks AS SELECT id,project_id,title,status,'bad version'::text AS version,created_at,allow_agents,required_platform,assigned_to,deleted_at FROM task_source`, false},
		{"iteration", `CREATE FUNCTION fail_priority_title() RETURNS text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1003', MESSAGE='private list failure'; END $$;
			ALTER TABLE tasks RENAME TO task_source; CREATE VIEW tasks AS SELECT id,project_id,fail_priority_title() AS title,status,version,created_at,allow_agents,required_platform,assigned_to,deleted_at FROM task_source`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := readerStore(t)
			ctx := context.Background()
			project := readerProject(t, db, 1)
			readerTask(t, db, project.ID, 11, model.TaskTodo)
			readerExec(t, db, test.ddl)
			err := db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
				if test.fence {
					_, err := snapshot.TaskDAO().TaskListFence(ctx, project.ID)
					return err
				}
				_, err := snapshot.TaskDAO().TaskPriorityList(ctx, project.ID, TaskPriorityQuery{Limit: 1})
				return err
			})
			if err == nil || errors.Is(err, model.ErrNotFound) || strings.Contains(err.Error(), "private list failure") {
				t.Fatalf("query failure was lost or leaked: %v", err)
			}
		})
	}
}

func TestTaskSyncPropertyFailuresReturnNoPartialRows(t *testing.T) {
	database := readerStore(t)
	project := readerProject(t, database, 1)
	readerTask(t, database, project.ID, 10, model.TaskTodo)
	readerExec(t, database, `DROP TABLE task_properties`)
	err := database.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
		actual, err := snapshot.TaskDAO().TaskSyncTasks(context.Background(), project.ID, nil, 160)
		if actual != nil {
			t.Fatalf("property query failure returned tasks: %#v", actual)
		}
		return err
	})
	var invalid *taskproperties.ValidationError
	if err == nil || errors.As(err, &invalid) {
		t.Fatalf("database failure became a property refusal: %v", err)
	}
}

func TestTaskSyncPropertyBatchReadHonorsCancellation(t *testing.T) {
	database := readerStore(t)
	project := readerProject(t, database, 1)
	item := readerTask(t, database, project.ID, 10, model.TaskTodo)
	readerExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, item.ID, `[{"url":"https://example.com/pr/1","title":"Change"}]`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracer := &readerCancelPropertyTracer{cancel: cancel}
	config := database.Pool.Config()
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	traced := &postgres.Store{Pool: pool}
	var result []model.TaskViewRecord
	err = traced.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var e error
		result, e = snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		return e
	})
	if !errors.Is(err, context.Canceled) || len(result) != 0 || tracer.queries != 1 {
		t.Fatalf("result=%d queries=%d error=%v", len(result), tracer.queries, err)
	}
}

type readerCancelPropertyTracer struct {
	cancel  context.CancelFunc
	queries int
}

func (tracer *readerCancelPropertyTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "FROM task_properties") {
		tracer.queries++
		tracer.cancel()
	}
	return ctx
}

func (*readerCancelPropertyTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestTaskSyncProjectionAndExactLowerBound(t *testing.T) {
	s := readerStore(t)
	ctx := context.Background()
	project, other := readerProject(t, s, 1), readerProject(t, s, 2)
	readerTask(t, s, other.ID, 19, model.TaskTodo)
	a := readerTask(t, s, project.ID, 10, model.TaskDone)
	b := readerTask(t, s, project.ID, 11, model.TaskInProgress, a.ID)
	c := readerTask(t, s, project.ID, 12, model.TaskTodo, a.ID, b.ID)
	stamp := time.Date(2026, 10, 24, 1, 2, 3, 123456000, time.UTC)
	readerExec(t, s, `UPDATE tasks SET created_at=$1, updated_at=$1, version=9007199254740993,
		title=repeat('😀',161) WHERE project_id=$2`, stamp, project.ID)
	readerExec(t, s, "UPDATE tasks SET updated_at=$1, required_platform='linux', allow_agents=true WHERE id=$2", stamp.Add(time.Microsecond), c.ID)
	readerExec(t, s, "UPDATE task_dependencies SET external=true WHERE task_id=$1 AND depends_on_task_id=$2", c.ID, b.ID)
	// Failing detail expressions prove that the summary reader never selects bodies.
	readerExec(t, s, `CREATE FUNCTION reject_sync_detail() RETURNS text LANGUAGE plpgsql STABLE AS $$
		BEGIN RAISE EXCEPTION 'private details selected'; END $$;
		ALTER TABLE tasks RENAME TO task_source;
		CREATE VIEW tasks AS SELECT id, project_id, title, reject_sync_detail() AS description,
		status, version, created_at, updated_at, started_at, completed_at, cancelled_at, allow_agents, required_platform, assigned_to, deleted_at FROM task_source`)
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		all, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil || len(all) != 3 || all[0].Version != 9007199254740993 || all[0].TitlePreview != strings.Repeat("😀", 160) || !all[0].TitleTruncated ||
			all[0].RequiredPlatform != nil || all[2].RequiredPlatform == nil || *all[2].RequiredPlatform != model.TaskPlatform("linux") || !all[2].AllowAgents ||
			!slices.Equal(all[2].DependsOn, []string{a.ID, b.ID}) || !slices.Equal(all[2].ExternalDependsOn, []string{b.ID}) {
			t.Fatalf("intrinsic projection: %#v, %v", all, err)
		}
		for _, test := range []struct {
			lower time.Time
			count int
		}{
			{stamp, 3}, {stamp.Add(time.Nanosecond), 1}, {stamp.Add(999 * time.Nanosecond), 1},
			{stamp.Add(time.Microsecond), 1}, {stamp.Add(time.Microsecond + time.Nanosecond), 0},
		} {
			got, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, &test.lower, 160)
			if err != nil || got == nil || len(got) != test.count {
				t.Fatalf("lower %s: %#v, %v", test.lower.Format(time.RFC3339Nano), got, err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	readerExec(t, s, "UPDATE task_source SET version=version+1 WHERE id=$1", b.ID)
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		tasks, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, &stamp, 160)
		if err != nil || len(tasks) != 3 || tasks[1].Version != 9007199254740994 || tasks[1].UpdatedAt != stamp {
			t.Fatalf("same-timestamp higher version disappeared: %#v, %v", tasks, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var future time.Time
	if err := s.Pool.QueryRow(ctx, "SELECT clock_timestamp()+interval '1 hour'").Scan(&future); err != nil {
		t.Fatal(err)
	}
	readerExec(t, s, "UPDATE task_source SET updated_at=$2 WHERE id=$1", b.ID, future)
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		tasks, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, &future, 160)
		if err != nil {
			return err
		}
		observedAt, err := snapshot.ObservedAt(ctx)
		if err != nil || len(tasks) != 1 || tasks[0].ID != b.ID || !tasks[0].UpdatedAt.After(observedAt) {
			t.Fatalf("snapshot clock became a query upper bound: %#v, observed %v, %v", tasks, observedAt, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskSyncStoreFailuresPreserveCauses(t *testing.T) {
	for _, test := range []struct{ name, ddl string }{
		{"query", "DROP TABLE tasks"},
		{"decode", `ALTER TABLE tasks RENAME TO task_source; CREATE VIEW tasks AS SELECT id,project_id,title,status,version,1::bigint AS created_at,updated_at,started_at,completed_at,cancelled_at,allow_agents,required_platform,assigned_to,deleted_at FROM task_source`},
		{"iteration", `CREATE FUNCTION fail_sync_stamp() RETURNS timestamptz LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1003', MESSAGE='private sync failure'; END $$; ALTER TABLE tasks RENAME TO task_source; CREATE VIEW tasks AS SELECT id,project_id,title,status,version,created_at,fail_sync_stamp() AS updated_at,started_at,completed_at,cancelled_at,allow_agents,required_platform,assigned_to,deleted_at FROM task_source`},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := readerStore(t)
			project := readerProject(t, s, 1)
			readerTask(t, s, project.ID, 11, model.TaskTodo)
			readerExec(t, s, test.ddl)
			err := s.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
				_, err := snapshot.TaskDAO().TaskSyncTasks(context.Background(), project.ID, nil, 160)
				return err
			})
			if err == nil || errors.Is(err, model.ErrNotFound) || strings.Contains(err.Error(), "private") {
				t.Fatalf("sync failure hidden or leaked: %v", err)
			}
			if test.name == "iteration" {
				var pgErr *pgconn.PgError
				if !errors.As(err, &pgErr) || pgErr.Code != "P1003" {
					t.Fatalf("driver cause lost: %v", err)
				}
			}
		})
	}
}

func TestTaskSyncPropertiesBatchQueriesAndEmptyWindow(t *testing.T) {
	database := readerStore(t)
	ctx := context.Background()
	project := readerProject(t, database, 1)
	other := readerProject(t, database, 2)
	task := readerTask(t, database, project.ID, 10, model.TaskTodo)
	empty := readerTask(t, database, project.ID, 11, model.TaskTodo)
	foreign := readerTask(t, database, other.ID, 12, model.TaskTodo)
	before, err := taskproperties.Normalize(model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"opaque\u0000","title":"Repeated 中文"},{"url":"opaque\u0000","title":"Repeated 中文"}]`)})
	if err != nil {
		t.Fatal(err)
	}
	readerExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2),($3,'unknown','null')`, task.ID, string(before["pullRequests"]), foreign.ID)
	tracer := &readerPropertiesTracer{}
	config := database.Pool.Config()
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	traced := &postgres.Store{Pool: pool}
	if err := traced.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		actual, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil {
			return err
		}
		if len(actual) != 2 || actual[0].ID != task.ID || actual[0].Version != task.Version || !reflect.DeepEqual(actual[0].Properties, before) ||
			actual[1].ID != empty.ID || actual[1].Properties == nil || len(actual[1].Properties) != 0 {
			t.Fatalf("task and property snapshots diverged: %#v", actual)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if tracer.taskQueries != 1 || tracer.propertyQueries != 1 {
		t.Fatalf("properties were not loaded in one batch: task=%d properties=%d", tracer.taskQueries, tracer.propertyQueries)
	}
	future := task.UpdatedAt.AddDate(100, 0, 0)
	if err := traced.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		actual, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, &future, 160)
		if err != nil || actual == nil || len(actual) != 0 {
			t.Fatalf("empty window changed: %#v %v", actual, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if tracer.taskQueries != 2 || tracer.propertyQueries != 1 {
		t.Fatalf("empty window queried properties: task=%d properties=%d", tracer.taskQueries, tracer.propertyQueries)
	}
}

type readerPropertiesQueryKey struct{}

type readerPropertiesTracer struct {
	taskQueries     int
	propertyQueries int
	afterTasks      func()
}

func (tracer *readerPropertiesTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "left(t.title, $2)") {
		tracer.taskQueries++
		return context.WithValue(ctx, readerPropertiesQueryKey{}, true)
	}
	if strings.Contains(data.SQL, "FROM task_properties") {
		tracer.propertyQueries++
	}
	return ctx
}

func (tracer *readerPropertiesTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if matched, _ := ctx.Value(readerPropertiesQueryKey{}).(bool); matched && tracer.afterTasks != nil {
		action := tracer.afterTasks
		tracer.afterTasks = nil
		action()
	}
}
