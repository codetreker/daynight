package postgres

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestTaskSearchProjectAccessUsesSnapshot(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	project, owner, team, stranger := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, []any{project}},
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,'owner',now(),now())`, []any{owner}},
		{`INSERT INTO teams(id,name) VALUES($1,'owners')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, owner}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err := db.Pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	err := NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		access, err := s.ProjectAccess(ctx, model.Principal{UserID: owner}, project)
		if err != nil {
			return err
		}
		if access.UserID != owner || access.ProjectID != project || access.Role != model.ProjectAdmin {
			t.Fatalf("access %+v", access)
		}
		if _, err := s.ProjectAccess(ctx, model.Principal{UserID: stranger}, project); err == nil {
			t.Fatal("ungranted user was authorized")
		}
		if _, err := db.Pool.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team, owner); err != nil {
			return err
		}
		_, err = s.ProjectAccess(ctx, model.Principal{UserID: owner}, project)
		return err
	})
	if err != nil {
		t.Fatalf("access changed inside snapshot: %v", err)
	}
	err = NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		_, err := s.ProjectAccess(ctx, model.Principal{UserID: owner}, project)
		return err
	})
	if err == nil {
		t.Fatal("revoked user retained access in new snapshot")
	}
}
