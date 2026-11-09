package service

import (
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"

	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSnapshotCommitFailureDominatesReadResults(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Snapshot completion")
	missing := uuid.NewString()
	projectSecret := secretutil.Random("dninvite_")
	teamSecret := secretutil.Random("dnteam_")
	page := model.PageRequest{Limit: 10}
	for _, test := range []struct {
		name    string
		refusal bool
		read    func(context.Context, *postgres.Store) (any, error)
	}{
		{"project missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return projectservice.NewProjects(db).Get(ctx, principal, missing)
		}},
		{"project access missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return projectservice.NewProjects(db).Access(ctx, principal, missing)
		}},
		{"scoped projects missing team", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return projectservice.NewProjects(db).ListScoped(ctx, principal, coreproject.ProjectListRequest{Page: page, TeamID: &missing})
		}},
		{"project transfer missing team", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return projectservice.NewProjects(db).TransferPreview(ctx, principal, project.ID, missing)
		}},
		{"team missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return teamservice.NewTeams(db).Get(ctx, principal, missing)
		}},
		{"team members missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return teamservice.NewTeams(db).Members(ctx, principal, missing)
		}},
		{"team invitation missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return teamservice.NewTeams(db).InspectInvitation(ctx, principal, teamSecret)
		}},
		{"membership missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return projectservice.NewMemberships(db).List(ctx, principal, missing)
		}},
		{"project invitation missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return projectservice.NewMemberships(db).InspectInvitation(ctx, principal, projectSecret)
		}},
		{"task missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return taskservice.NewTasks(db).Get(ctx, principal, project.ID, missing)
		}},
		{"task list project missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return taskservice.NewTasks(db).List(ctx, principal, missing, taskservice.TaskListRequest{PageRequest: page})
		}},
		{"graph project missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return taskservice.NewTasks(db).Graph(ctx, principal, missing, task.ID)
		}},
		{"sync project missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return taskservice.NewTaskSync(db, sessioncore.NewEngine(nil), 10*time.Second).Get(ctx, principal, missing, taskservice.TaskSyncRequest{})
		}},
		{"assignees project missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return taskservice.NewTasks(db).Assignees(ctx, principal, missing, taskservice.TaskAssigneesRequest{})
		}},
		{"attachment task missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return attachmentservice.NewAttachments(db, nil, nil).List(ctx, principal, project.ID, missing, page)
		}},
		{"worker missing", true, func(ctx context.Context, db *postgres.Store) (any, error) {
			return workerservice.NewWorkers(db).Get(ctx, principal, missing)
		}},
		{"project success", false, func(ctx context.Context, db *postgres.Store) (any, error) {
			return projectservice.NewProjects(db).Get(ctx, principal, project.ID)
		}},
		{"bot list success", false, func(ctx context.Context, db *postgres.Store) (any, error) {
			return botservice.New(db).List(ctx, principal, page)
		}},
		{"thread success", false, func(ctx context.Context, db *postgres.Store) (any, error) {
			return taskservice.NewTaskThreads(db).List(ctx, principal, project.ID, task.ID, taskservice.ThreadListRequest{})
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, baseline := test.read(context.Background(), database)
			var fault *model.Fault
			if test.refusal {
				if !errors.As(baseline, &fault) {
					t.Fatalf("expected a staged refusal, got %v", baseline)
				}
			} else if baseline != nil {
				t.Fatalf("baseline read failed: %v", baseline)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			attempted := false
			traced := tracedTasks(t, databaseURL, taskQueryAction{
				match: func(sql string) bool { return strings.EqualFold(strings.TrimSpace(sql), "commit") },
				start: func() { attempted = true; cancel() },
			})
			result, err := test.read(ctx, traced.store)
			var completion *store.TransactionError
			if !attempted || !errors.Is(err, context.Canceled) || !errors.As(err, &completion) || !completion.CommitAttempted || completion.Outcome != store.TransactionUnknown {
				t.Fatalf("commit failure lost: attempted=%t completion=%+v err=%v", attempted, completion, err)
			}
			if errors.As(err, &fault) || !reflect.DeepEqual(result, reflect.Zero(reflect.TypeOf(result)).Interface()) {
				t.Fatalf("commit failure returned a refusal or partial result: %#v %v", result, err)
			}
		})
	}
}

type cancelAfterProjectQuery struct{ cancel context.CancelFunc }

func (t cancelAfterProjectQuery) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, queryContextKey{}, strings.Contains(data.SQL, "FROM project_grants"))
}

type queryContextKey struct{}

func (t cancelAfterProjectQuery) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if ctx.Value(queryContextKey{}) == true {
		t.cancel()
	}
}

func TestSnapshotCompletionFailureDominatesMissingProject(t *testing.T) {
	_, _, databaseURL, principal := projectService(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = cancelAfterProjectQuery{cancel: cancel}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = projectservice.NewProjects(&postgres.Store{Pool: pool}).Get(ctx, principal, "00000000-0000-0000-0000-000000000001")
	var fault *model.Fault
	if err == nil || errors.As(err, &fault) || !errors.Is(err, context.Canceled) {
		t.Fatalf("failed snapshot completion must not become not_found: %#v", err)
	}
}

func TestProjectAccessValidationAndCompletionFailures(t *testing.T) {
	ctx := context.Background()
	_, err := projectservice.NewProjects(nil).Access(ctx, model.Principal{}, uuid.NewString())
	requireFault(t, err, "unauthenticated")
	principal := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	_, err = projectservice.NewProjects(nil).Access(ctx, principal, "invalid")
	requireFault(t, err, "invalid_input")
	projects, database, databaseURL, admin := projectService(t)
	project, err := projects.Create(ctx, admin, coreproject.CreateProject{ExpectedUserID: admin.UserID, Name: "Completion precedence", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	outsider := servicePrincipal(t, database)
	for _, actor := range []model.Principal{admin, outsider} {
		canceled, cancel := context.WithCancel(ctx)
		traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "FROM project_grants") }, end: cancel})
		access, err := projectservice.NewProjects(traced.store).Access(canceled, actor, project.ID)
		cancel()
		assertOperational(t, err)
		if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(access, model.ProjectAccess{}) {
			t.Fatalf("completion failure masked by actor result: %#v %v", access, err)
		}
	}
	database.Close()
	_, err = projects.Access(ctx, admin, project.ID)
	assertOperational(t, err)
}

func TestTaskGraphOperationalFailuresAndCompletionPrecedence(t *testing.T) {
	for _, test := range []struct {
		name, fragment       string
		missing, cancelAfter bool
	}{
		{name: "project query", fragment: "SELECT p.id::text, p.name, p.repo_url"},
		{name: "projection query", fragment: "left(t.title, $7)"},
		{name: "clock query", fragment: "SELECT statement_timestamp()"},
		{name: "clock completion", fragment: "SELECT statement_timestamp()", cancelAfter: true},
		{name: "missing project completion", fragment: "FROM project_grants", missing: true, cancelAfter: true},
		{name: "projection completion", fragment: "left(t.title, $7)", cancelAfter: true},
		{name: "commit failure", fragment: "commit"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, database, project, databaseURL, principal := taskService(t)
			rootID := createTask(t, taskservice.NewTasks(database), principal, project.ID, "Snapshot root").ID
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			action := taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, test.fragment) }}
			if test.cancelAfter {
				action.end = cancel
			} else {
				action.start = cancel
			}
			traced := tracedTasks(t, databaseURL, action)
			id := project.ID
			if test.missing {
				id = "00000000-0000-0000-0000-000000000000"
			}
			graph, err := traced.Graph(ctx, principal, id, rootID)
			assertOperational(t, err)
			if test.fragment == "commit" {
				var completion *store.TransactionError
				if !errors.As(err, &completion) || !completion.CommitAttempted || completion.Outcome != store.TransactionUnknown {
					t.Fatalf("commit completion facts lost: %+v %v", completion, err)
				}
			}
			if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(graph, model.TaskGraph{}) {
				t.Fatalf("cancellation cause or partial result: %#v, %v", graph, err)
			}
		})
	}
	for _, table := range []string{"projects", "tasks", "task_dependencies"} {
		t.Run("missing "+table, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			root := createTask(t, tasks, principal, project.ID, "Failure root")
			if _, err := database.Pool.Exec(context.Background(), "DROP TABLE "+table); err != nil {
				t.Fatal(err)
			}
			_, err := tasks.Graph(context.Background(), principal, project.ID, root.ID)
			assertOperational(t, err)
		})
	}
	tasks, database, project, _, principal := taskService(t)
	root := createTask(t, tasks, principal, project.ID, "Closed store root")
	database.Close()
	_, err := tasks.Graph(context.Background(), principal, project.ID, root.ID)
	assertOperational(t, err)
}

func TestTaskSyncOperationalFailuresAndCompletionPrecedence(t *testing.T) {
	for _, test := range []struct {
		name, fragment    string
		missing, complete bool
	}{
		{name: "project", fragment: "SELECT p.id::text, p.name, p.repo_url"},
		{name: "epoch", fragment: "SELECT task_cache_epoch::text"},
		{name: "rows", fragment: "left(t.title, $2)"},
		{name: "properties", fragment: "SELECT task_id::text,name,value FROM task_properties"},
		{name: "properties completion", fragment: "SELECT task_id::text,name,value FROM task_properties", complete: true},
		{name: "people", fragment: "FROM candidate_ids candidate"},
		{name: "clock", fragment: "SELECT statement_timestamp()"},
		{name: "missing completion", fragment: "FROM project_grants", missing: true, complete: true},
		{name: "clock completion", fragment: "SELECT statement_timestamp()", complete: true},
		{name: "commit failure", fragment: "commit"},
	} {
		t.Run(test.name, func(t *testing.T) {
			tasks, database, project, url, principal := taskService(t)
			if strings.HasPrefix(test.name, "properties") {
				target := createTask(t, tasks, principal, project.ID, "Property read")
				if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests','[]')`, target.ID); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			action := taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, test.fragment) }}
			if test.complete {
				action.end = cancel
			} else {
				action.start = cancel
			}
			traced := tracedTasks(t, url, action)
			id := project.ID
			if test.missing {
				id = "00000000-0000-4000-8000-000000000099"
			}
			result, err := taskservice.NewTaskSync(traced.store, sessioncore.NewEngine(nil), 10*time.Second).Get(ctx, principal, id, taskservice.TaskSyncRequest{})
			assertOperational(t, err)
			if test.fragment == "commit" {
				var completion *store.TransactionError
				if !errors.As(err, &completion) || !completion.CommitAttempted || completion.Outcome != store.TransactionUnknown {
					t.Fatalf("commit completion facts lost: %+v %v", completion, err)
				}
			}
			if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(result, model.TaskSync{}) {
				t.Fatalf("completion precedence: %#v %v", result, err)
			}
		})
	}
	_, database, project, _, principal := taskService(t)
	database.Close()
	_, err := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), 10*time.Second).Get(context.Background(), principal, project.ID, taskservice.TaskSyncRequest{})
	assertOperational(t, err)
}

func TestTaskTransactionCompletionFailureDominatesDomainFault(t *testing.T) {
	tasks, _, project, databaseURL, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Target")
	missing := "00000000-0000-0000-0000-000000000000"
	for _, test := range []struct {
		name      string
		fragment  string
		operation func(context.Context, *taskservice.Tasks) error
	}{
		{"missing task read", "FROM tasks t", func(ctx context.Context, s *taskservice.Tasks) error {
			_, err := s.Get(ctx, principal, project.ID, missing)
			return err
		}},
		{"missing task update", "FROM tasks t", func(ctx context.Context, s *taskservice.Tasks) error {
			_, err := s.Update(ctx, principal, project.ID, missing, taskcore.UpdateTask{Version: 1, Title: pointer("Rejected")})
			return err
		}},
		{"stale version update", "FROM tasks t", func(ctx context.Context, s *taskservice.Tasks) error {
			_, err := s.Update(ctx, principal, project.ID, target.ID, taskcore.UpdateTask{Version: 2, Title: pointer("Rejected")})
			return err
		}},
		{"missing task status", "FROM tasks t", func(ctx context.Context, s *taskservice.Tasks) error {
			_, err := s.SetStatus(ctx, principal, project.ID, missing, taskcore.SetTaskStatus{Version: 1, Status: model.TaskInProgress})
			return err
		}},
		{"stale version status", "FROM tasks t", func(ctx context.Context, s *taskservice.Tasks) error {
			_, err := s.SetStatus(ctx, principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version + 1, Status: model.TaskTodo})
			return err
		}},
		{"same-state status", "FROM tasks t", func(ctx context.Context, s *taskservice.Tasks) error {
			_, err := s.SetStatus(ctx, principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskTodo})
			return err
		}},
		{"invalid dependency create", "t.id = ANY($2::uuid[])", func(ctx context.Context, s *taskservice.Tasks) error {
			_, err := s.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "Rejected", DependsOn: []string{missing}})
			return err
		}},
		{"missing project read", "FROM project_grants", func(ctx context.Context, s *taskservice.Tasks) error {
			_, err := s.Get(ctx, principal, missing, target.ID)
			return err
		}},
		{"missing project list", "FROM project_grants", func(ctx context.Context, s *taskservice.Tasks) error {
			_, err := s.List(ctx, principal, missing, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10}})
			return err
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, test.fragment) }, end: cancel})
			err := test.operation(ctx, traced.Tasks)
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("completion failure lost cause: %v", err)
			}
			assertTaskUnchanged(t, tasks, principal, target)
		})
	}
}

func TestTaskAssigneesSnapshotCompletionFailure(t *testing.T) {
	tasks, database, project, databaseURL, _ := taskService(t)
	outsider := servicePrincipal(t, database)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "FROM project_grants") }, end: cancel})
	result, err := traced.Assignees(ctx, outsider, project.ID, taskservice.TaskAssigneesRequest{})
	assertOperational(t, err)
	if !errors.Is(err, context.Canceled) || len(result.Items) != 0 || len(result.UnresolvedUserIDs) != 0 {
		t.Fatal("transaction completion failure was hidden by project refusal", err)
	}
	_, err = tasks.Assignees(context.Background(), outsider, project.ID, taskservice.TaskAssigneesRequest{})
	requireFault(t, err, "not_found")
}
