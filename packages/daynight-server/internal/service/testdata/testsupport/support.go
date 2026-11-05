package testsupport

import (
	"context"
	"crypto/rand"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func ServiceDatabaseURL(t *testing.T) string {
	t.Helper()
	databaseURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "service_" + strings.ToLower(rand.Text())
	if _, err := pool.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pool.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		pool.Close()
	})
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	query.Set("timezone", "UTC")
	query.Set("application_name", schema)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func ProjectService(t *testing.T) (*projectservice.Projects, *store.Store, string, model.Principal) {
	t.Helper()
	databaseURL := ServiceDatabaseURL(t)
	database, err := store.Open(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	return projectservice.NewProjects(database), database, databaseURL, ServicePrincipal(t, database)
}

func ServicePrincipal(t *testing.T, database *store.Store) model.Principal {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Microsecond)
	secret := secretutil.Random("dnst_")
	credential := model.Session{ID: uuid.NewString(), TokenHash: secretutil.Hash(secret), CreatedAt: now, ExpiresAt: now.Add(identitycore.SessionLifetime)}
	principal := FixtureIdentitySession(t, database, model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}, credential)

	return principal
}

func FixtureIdentitySession(t *testing.T, database *store.Store, user model.User, session model.Session) model.Principal {
	t.Helper()
	ctx := context.Background()
	var principal model.Principal
	_, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		var err error
		user, err = scope.IdentityDAO().UpsertUser(ctx, user, session.CreatedAt)
		if err != nil {
			return err
		}
		if _, err = team.BootstrapPersonalTeam(ctx, scope.PersonalTeamDAO(), user.ID, session.CreatedAt); err != nil {
			return err
		}
		session.UserID = user.ID
		if err = scope.IdentityDAO().InsertSession(ctx, session); err != nil {
			return err
		}
		principal, err = scope.IdentityDAO().Authenticate(ctx, model.SessionCredential, session.TokenHash, session.CreatedAt)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

func TaskService(t *testing.T) (*taskservice.Tasks, *store.Store, model.Project, string, model.Principal) {
	t.Helper()
	projects, database, databaseURL, principal := ProjectService(t)
	project, err := projects.Create(context.Background(), principal, coreproject.CreateProject{ExpectedUserID: principal.UserID, Name: "Tasks", RepoURL: "git@host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	return taskservice.NewTasks(database), database, project, databaseURL, principal
}

func CreateTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, projectID, title string, dependencies ...string) model.Task {
	t.Helper()
	task, err := tasks.Create(context.Background(), principal, projectID, taskcore.CreateTask{Title: title, DependsOn: dependencies})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func UpdateTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task, input taskcore.UpdateTask) model.Task {
	t.Helper()
	input.Version = task.Version
	updated, err := tasks.Update(context.Background(), principal, task.ProjectID, task.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	return updated
}

func SetStatusTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task, status model.TaskStatus) model.Task {
	t.Helper()
	result, err := tasks.SetStatus(context.Background(), principal, task.ProjectID, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: status})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func StartTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task) model.Task {
	t.Helper()
	return SetStatusTask(t, tasks, principal, task, model.TaskInProgress)
}

func FinishTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task) model.Task {
	t.Helper()
	return SetStatusTask(t, tasks, principal, task, model.TaskDone)
}

func AssertTaskUnchanged(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, before model.Task) {
	t.Helper()
	after, err := tasks.Get(context.Background(), principal, before.ProjectID, before.ID)
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatalf("refused operation changed task: before %#v, after %#v, err %v", before, after, err)
	}
}
