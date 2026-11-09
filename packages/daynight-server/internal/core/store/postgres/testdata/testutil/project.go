package testutil

import (
	"context"
	"crypto/sha256"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ProjectFixtureWriter interface {
	store.IdentityWriter
	store.ProjectCreationWriter
}

func QueryID(number int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", number) }

// Historical fixtures must write the source schema before a migration can run.
func CreateProject(ctx context.Context, pool *pgxpool.Pool, writer ProjectFixtureWriter, id, name, repoURL string) (model.Project, error) {
	var current bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=32)`).Scan(&current); err != nil {
		return model.Project{}, err
	}
	if current {
		now := time.Now().UTC()
		hash := sha256.Sum256([]byte(uuid.NewString()))
		user, err := SeedIdentitySession(ctx, writer, model.User{ID: uuid.NewString(), UniAuthID: "fixture:" + uuid.NewString()},
			model.Session{ID: uuid.NewString(), TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
		if err != nil {
			return model.Project{}, err
		}
		return CreatePrivateProject(ctx, writer, model.Principal{UserID: user.ID}, id, name, repoURL)
	}
	var project model.Project
	err := pool.QueryRow(ctx, `INSERT INTO projects(id,name,repo_url) VALUES ($1,$2,$3)
		RETURNING id::text,name,repo_url,created_at,updated_at,settings_version,execution_warning_minutes`, id, name, repoURL).
		Scan(&project.ID, &project.Name, &project.RepoURL, &project.CreatedAt, &project.UpdatedAt, &project.Settings.Version, &project.Settings.ExecutionWarningMinutes)
	if err != nil {
		return model.Project{}, pg.QueryError("create historical fixture project", err)
	}
	if err := SeedHistoricalProjectAdmin(ctx, pool, id); err != nil {
		return model.Project{}, err
	}
	return project, nil
}

func SeedHistoricalProjectAdmin(ctx context.Context, pool *pgxpool.Pool, projectID string) error {
	userID := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, userID, "historical:"+userID); err != nil {
		return err
	}
	_, err := pool.Exec(ctx, `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')`, projectID, userID)
	return err
}

func CreatePrivateProject(ctx context.Context, writer store.ProjectCreationWriter, principal model.Principal, id, name, repoURL string) (model.Project, error) {
	project, _, err := CreateProjectInTeam(ctx, writer, principal, id, name, repoURL, nil)
	return project, err
}

func CreateProjectInTeam(ctx context.Context, writer store.ProjectCreationWriter, principal model.Principal, id, name, repoURL string, teamID *string) (model.Project, model.ProjectAccess, error) {
	var project model.Project
	var access model.ProjectAccess
	_, err := writer.WriteProjectCreation(ctx, principal.UserID, func(dao store.ProjectCreationDAO) error {
		var err error
		project, access, err = projectcore.Create(ctx, dao, principal.UserID, id, projectcore.CreateProject{Name: name, RepoURL: repoURL, TeamID: teamID})
		return err
	})
	return project, access, err
}

func QueryProject(t *testing.T, pool *pgxpool.Pool, writer ProjectFixtureWriter, number int) model.Project {
	t.Helper()
	project, err := CreateProject(context.Background(), pool, writer, QueryID(number), "Project", "https://example.com/owner/repo.git")
	if err != nil {
		t.Fatal(err)
	}
	return project
}

func WriteProject(ctx context.Context, writer store.ProjectWriter, id string, operation func(store.ProjectWriteScope) error) error {
	_, err := writer.WriteProject(ctx, id, operation)
	return err
}

func QueryTask(t *testing.T, writer store.ProjectWriter, projectID string, number int, status model.TaskStatus, dependencies ...string) model.Task {
	t.Helper()
	var task model.Task
	err := WriteProject(context.Background(), writer, projectID, func(scope store.ProjectWriteScope) error {
		var err error
		task, err = scope.TaskDAO().CreateTask(context.Background(), QueryID(number), store.TaskWrite{
			Title: "Task", Description: "Description", Status: status, DependsOn: dependencies,
		})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func SnapshotTask(t *testing.T, reader store.SnapshotReader, projectID, id string) model.Task {
	t.Helper()
	var task model.Task
	err := reader.ReadSnapshot(context.Background(), func(scope store.SnapshotScope) error {
		var err error
		task, err = scope.TaskDAO().Task(context.Background(), projectID, id)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func TaskWrite(task model.Task) store.TaskWrite {
	return store.TaskWrite{
		AssignedTo: task.AssignedTo, RequiredPlatform: task.RequiredPlatform,
		AllowAgents: task.AllowAgents, Title: task.Title, Description: task.Description,
		Properties: task.Properties, Status: task.Status,
		DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn,
	}
}
