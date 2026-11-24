package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
	"github.com/google/uuid"
)

func TestTaskSearchSnapshotAndFilters(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx := t.Context()
	project, owner := uuid.NewString(), uuid.NewString()
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,status,assigned_to,allow_agents,required_platform)
 VALUES($1,$4,'word','done',$5,true,'linux'),($2,$4,'word','todo',NULL,false,NULL),($3,$4,'word','todo',$5,true,'macos')`, ids[0], ids[1], ids[2], project, owner); err != nil {
		t.Fatal(err)
	}
	root, err := query.Parse("word")
	if err != nil {
		t.Fatal(err)
	}
	goal := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','goal title','todo')`, goal, project); err != nil {
		t.Fatal(err)
	}
	checkGoalTitle := func(s store.TaskSearchSnapshot, want string) error {
		titles, err := s.Titles(ctx, project, []string{goal})
		if err == nil && titles[goal] != want {
			t.Errorf("goal title = %q, want %q", titles[goal], want)
		}
		return err
	}
	calls := 0
	var before store.TaskSearchFence
	err = db.ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		calls++
		var err error
		before, err = s.Fence(ctx, project)
		if err != nil {
			return err
		}
		status, ready, agents, platform := model.TaskTodo, true, true, model.PlatformMacOS
		page, err := s.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 10, Status: &status, Ready: &ready, AllowAgents: &agents, CompatiblePlatform: &platform, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: owner}})
		if err != nil {
			return err
		}
		if page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != ids[2] {
			t.Errorf("filtered page: %+v", page)
		}
		if err := checkGoalTitle(s, "goal title"); err != nil {
			return err
		}
		if _, err := db.Pool.Exec(ctx, `UPDATE tasks SET version=version+1,title='changed' WHERE id=ANY($1::uuid[])`, []string{ids[2], goal}); err != nil {
			return err
		}
		after, err := s.Fence(ctx, project)
		if err != nil {
			return err
		}
		if after != before {
			t.Errorf("snapshot changed: %+v %+v", before, after)
		}
		page, err = s.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 10})
		if err != nil {
			return err
		}
		if page.Total != 3 {
			t.Errorf("snapshot match count: %d", page.Total)
		}
		return checkGoalTitle(s, "goal title")
	})
	if err != nil || calls != 1 {
		t.Fatalf("search callback calls=%d, error=%v", calls, err)
	}
	err = db.ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		after, err := s.Fence(ctx, project)
		if err != nil {
			return err
		}
		if after == before || after.VersionSum != "6" {
			t.Errorf("committed fence: %+v", after)
		}
		page, err := s.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 10})
		if err != nil {
			return err
		}
		if page.Total != 2 {
			t.Errorf("new snapshot count: %d", page.Total)
		}
		return checkGoalTitle(s, "changed")
	})
	if err != nil {
		t.Fatal(err)
	}
	cause := errors.New("caller rejected search result")
	if err := db.ReadTaskSearch(ctx, func(store.TaskSearchSnapshot) error { return cause }); !errors.Is(err, cause) {
		t.Fatalf("callback cause=%v", err)
	}
}

func TestTaskSearchProjectAccessUsesSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
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

func searchMutationFence(t *testing.T, database *Store, projectID string) store.TaskSearchFence {
	t.Helper()
	var fence store.TaskSearchFence
	if err := NewTaskSearch(database.Pool).ReadTaskSearch(t.Context(), func(snapshot store.TaskSearchSnapshot) error {
		var err error
		fence, err = snapshot.Fence(t.Context(), projectID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return fence
}
func TestTaskSearchRollbackRetainsFenceAndPersistentTask(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 11, model.TaskTodo)
	ctx := t.Context()
	t.Run("read-only and rollback retain fence", func(t *testing.T) {
		before := searchMutationFence(t, database, project.ID)
		read := snapshotTask(t, database, project.ID, target.ID)
		if !reflect.DeepEqual(read, target) || searchMutationFence(t, database, project.ID) != before {
			t.Fatal("read-only snapshot changed the fence")
		}
		refusal := errors.New("rollback sentinel")
		completion, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
			values := taskMutationValues(target)
			values.Title = "Must roll back"
			if _, err := scope.TaskDAO().UpdateTask(ctx, target.ID, values); err != nil {
				return err
			}
			return refusal
		})
		if !errors.Is(err, refusal) || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("rollback outcome: %+v %v", completion, err)
		}
		if searchMutationFence(t, database, project.ID) != before || !reflect.DeepEqual(snapshotTask(t, database, project.ID, target.ID), target) {
			t.Fatal("rolled-back update changed persistent task or fence")
		}
	})
}
