package session_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
)

func TestSessionProjectAccessUsesCallerTransaction(t *testing.T) {
	db, _, principal, project := membershipFixture(t)
	ctx := context.Background()
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, principal.UserID)
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID); err != nil {
		t.Fatal(err)
	}
	dao := pgsession.New(tx)
	access, err := dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if err != nil || access.Role != model.ProjectMemberRole {
		t.Fatal("admission ignored the caller's uncommitted role", access, err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID); err != nil {
		t.Fatal(err)
	}
	_, err = dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("uncommitted revocation remained authorized", err)
	}
}

func TestSessionProjectAccessDoesNotHoldGrantUntilCommit(t *testing.T) {
	db, _, principal, project := membershipFixture(t)
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, principal.UserID)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao := pgsession.New(tx)
	access, err := dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if err != nil || access.Role != model.ProjectAdmin {
		t.Fatal("initial admission failed", access, err)
	}
	if _, err = db.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID); err != nil {
		t.Fatal("Session admission blocked grant revocation", err)
	}
	_, err = dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("committed revocation remained authorized", err)
	}
}

func TestInheritedSessionAccessDoesNotHoldOwnershipOrTeamSources(t *testing.T) {
	db, principal, _, project := membershipFixture(t)
	mustQueryExec(t, db, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID)
	teamID := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO teams(id,name) VALUES($1,'Other owner')`, teamID)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao := pgsession.New(tx)
	access, err := dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if err != nil || access.Role != model.ProjectAdmin {
		t.Fatal("inherited-only Session admission", access, err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE project_ownership SET team_id=$2,version=version+1,updated_at=statement_timestamp() WHERE project_id=$1`, project.ID, teamID); err != nil {
		t.Fatal("ordinary Session admission held an ownership fence", err)
	}
	_, err = dao.ProjectAccess(ctx, principal.UserID, project.ID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal("ownership revocation remained authorized", err)
	}
}
