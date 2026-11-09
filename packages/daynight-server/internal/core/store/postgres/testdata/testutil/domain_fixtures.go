package testutil

import (
	"context"
	"crypto/sha256"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func ProjectMembershipFixture(t *testing.T, writer ProjectFixtureWriter) (model.Principal, model.Principal, model.Project) {
	t.Helper()
	_, admin, _ := AuthRecords(t, writer)
	_, member, _ := AuthRecords(t, writer)
	project, err := CreatePrivateProject(t.Context(), writer, admin, uuid.NewString(), "Private project", "https://example.com/private")
	if err != nil {
		t.Fatal(err)
	}
	return admin, member, project
}

type TeamFixtureWriter interface {
	store.IdentityWriter
	store.TeamWriter
}

func TeamFixture(t *testing.T, writer TeamFixtureWriter) (model.Principal, model.Team) {
	t.Helper()
	_, actor, _ := AuthRecords(t, writer)
	team, err := CreateTeam(t.Context(), writer, actor.UserID, uuid.NewString(), "Ordinary")
	if err != nil {
		t.Fatal(err)
	}
	return actor, team
}

func ProjectInvitation(project model.Project, creator model.Principal, label string) model.ProjectInvitation {
	hash := sha256.Sum256([]byte(label))
	now := time.Now().UTC()
	return model.ProjectInvitation{ID: uuid.NewString(), ProjectID: project.ID, CreatedBy: creator.UserID, TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}
}

func TeamInvitation(team model.Team, creator model.Principal, label string) model.TeamInvitation {
	hash := sha256.Sum256([]byte(label))
	now := time.Now().UTC()
	return model.TeamInvitation{ID: uuid.NewString(), TeamID: team.ID, CreatedBy: creator.UserID, TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}
}

func OrdinaryProjectTeam(t *testing.T, pool *pgxpool.Pool, projectID string) string {
	t.Helper()
	id := uuid.NewString()
	MustExec(t, pool, `INSERT INTO teams(id,name) VALUES($1,'Owner team')`, id)
	MustExec(t, pool, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1`, projectID, id)
	return id
}

func AssertPoolReusable(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for pool.Stat().AcquiredConns() != 0 {
		if err := WaitThreadClock(ctx); err != nil {
			t.Fatalf("database connection was not returned: %v", err)
		}
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	application := pool.Config().ConnConfig.RuntimeParams["application_name"]
	for {
		var unlocked bool
		if err := conn.QueryRow(ctx, `SELECT NOT EXISTS (
 SELECT FROM pg_locks locks JOIN pg_stat_activity activity USING (pid)
 WHERE locks.locktype='advisory' AND locks.granted AND activity.application_name=$1
 )`, application).Scan(&unlocked); err != nil {
			t.Fatal(err)
		}
		if unlocked {
			return
		}
		if err := WaitThreadClock(ctx); err != nil {
			t.Fatalf("database advisory lock was not released: %v", err)
		}
	}
}
