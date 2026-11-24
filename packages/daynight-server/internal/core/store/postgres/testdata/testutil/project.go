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
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ProjectFixtureWriter interface {
	store.IdentityWriter
	store.ProjectCreationWriter
}

func QueryID(number int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", number) }

func CreateProject(ctx context.Context, pool *pgxpool.Pool, writer ProjectFixtureWriter, id, name, repoURL string) (model.Project, error) {
	var currentIdentity bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=120)`).Scan(&currentIdentity); err != nil {
		return model.Project{}, err
	}
	now := time.Now().UTC()
	hash := sha256.Sum256([]byte(uuid.NewString()))
	identity := model.User{ID: uuid.NewString(), UniAuthID: "fixture:" + uuid.NewString()}
	session := model.Session{ID: uuid.NewString(), TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	var user model.User
	var err error
	if currentIdentity {
		user, err = SeedIdentitySession(ctx, writer, identity, session)
	} else {
		user, err = seedProjectIdentity(ctx, pool, identity, session)
	}
	if err != nil {
		return model.Project{}, err
	}
	return CreatePrivateProject(ctx, writer, model.Principal{UserID: user.ID}, id, name, repoURL)
}

// The identity DAO writes the browser Session columns added in migration 120.
func seedProjectIdentity(ctx context.Context, pool *pgxpool.Pool, user model.User, session model.Session) (model.User, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return model.User{}, err
	}
	defer tx.Rollback(ctx)
	teamID := uuid.NewString()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,$3,$3)`, []any{user.ID, user.UniAuthID, session.CreatedAt}},
		{`INSERT INTO teams(id,personal_user_id,created_at,updated_at) VALUES($1,$2,$3,$3)`, []any{teamID, user.ID, session.CreatedAt}},
		{`INSERT INTO team_members(team_id,user_id,role,created_at,updated_at) VALUES($1,$2,'admin',$3,$3)`, []any{teamID, user.ID, session.CreatedAt}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)`, []any{session.ID, user.ID, session.TokenHash, session.CreatedAt, session.ExpiresAt}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			return model.User{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return model.User{}, err
	}
	user.PersonalTeam = model.TeamRef{ID: teamID, Kind: "personal"}
	return user, nil
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
