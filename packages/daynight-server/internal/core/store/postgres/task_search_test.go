package postgres

import (
	"context"
	"crypto/rand"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func searchTestStore(t *testing.T) *Store {
	t.Helper()
	ctx := context.Background()
	raw := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if raw == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	admin, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	schema := "test_search_" + strings.ToLower(rand.Text())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	values := u.Query()
	values.Set("search_path", schema)
	u.RawQuery = values.Encode()
	db, err := Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return db
}

func TestTaskSearchSnapshotAndFilters(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
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
	reader := NewTaskSearch(db.Pool)
	var before store.TaskSearchFence
	err = reader.ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
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
		if _, err := db.Pool.Exec(ctx, `UPDATE tasks SET version=version+1,title='changed' WHERE id=$1`, ids[2]); err != nil {
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
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = reader.ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		after, err := s.Fence(ctx, project)
		if err != nil {
			return err
		}
		if after == before || after.VersionSum != "4" {
			t.Errorf("committed fence: %+v", after)
		}
		page, err := s.Matches(ctx, project, store.TaskSearchQuery{Expression: root, Limit: 10})
		if err != nil {
			return err
		}
		if page.Total != 2 {
			t.Errorf("new snapshot count: %d", page.Total)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
