package postgres

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestGoalRelationsHTTPVersionAndRollback(t *testing.T) {
	f := emptyGoalRelationFixture(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if kind != model.PATCredential || token != "test" {
			return model.Principal{}, authhttp.Failure()
		}
		return f.principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	taskhttp.GoalDependencyRoutes(mux, taskservice.NewTasks(f.db), auth, logger)
	path := fmt.Sprintf("/api/v1/projects/%s/tasks/%s/goal-dependencies", f.downProject.ID, f.down)
	patch := func(body string, status int, expected string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPatch, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer test")
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, req)
		if response.Code != status || !strings.Contains(response.Body.String(), expected) {
			t.Fatalf("PATCH %s: %d %s", body, response.Code, response.Body)
		}
	}
	add := func(revision string) string {
		return fmt.Sprintf(`{"ifRevision":%q,"mode":"edit","add":[{"projectId":%q,"goalId":%q}]}`, revision, f.upProject.ID, f.up)
	}
	clear := func(revision string) string {
		return fmt.Sprintf(`{"ifRevision":%q,"mode":"replace","prerequisites":[]}`, revision)
	}
	before := snapshotTask(t, f.db, f.downProject.ID, f.down)
	patch(add("1"), 200, `"revision":"2","changed":true`)
	added := snapshotTask(t, f.db, f.downProject.ID, f.down)
	if added.Version != before.Version+1 || added.UpdatedAt.Before(before.UpdatedAt) {
		t.Fatalf("add did not advance Goal: %+v", added)
	}
	patch(add("2"), 200, `"revision":"2","changed":false`)
	patch(clear("1"), 409, `"code":"goal_dependency_revision_conflict"`)
	if current := snapshotTask(t, f.db, f.downProject.ID, f.down); !reflect.DeepEqual(current, added) {
		t.Fatal("noop or stale request changed Goal")
	}
	patch(clear("2"), 200, `"revision":"3","changed":true`)
	cleared := snapshotTask(t, f.db, f.downProject.ID, f.down)
	if cleared.Version != added.Version+1 || cleared.UpdatedAt.Before(added.UpdatedAt) {
		t.Fatalf("clear did not advance Goal: %+v", cleared)
	}
	assertGoalRelationState(t, f.db, f.down, 0, 3)
	mustQueryExec(t, f.db, `UPDATE tasks SET version=$1 WHERE id=$2`, int64(math.MaxInt64), f.down)
	exhausted := snapshotTask(t, f.db, f.downProject.ID, f.down)
	patch(add("3"), 409, `"code":"version_exhausted"`)
	assertGoalRelationState(t, f.db, f.down, 0, 3)
	if current := snapshotTask(t, f.db, f.downProject.ID, f.down); !reflect.DeepEqual(current, exhausted) {
		t.Fatal("exhaustion changed Goal")
	}
	mustQueryExec(t, f.db, `UPDATE tasks SET version=$1 WHERE id=$2`, cleared.Version, f.down)
	mustQueryExec(t, f.db, `CREATE FUNCTION refuse_http_goal_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'touch refused'; END $$;
      CREATE TRIGGER refuse_http_goal_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_http_goal_touch()`)
	defer mustQueryExec(t, f.db, `DROP TRIGGER refuse_http_goal_touch ON tasks; DROP FUNCTION refuse_http_goal_touch()`)
	patch(add("3"), 500, `"code":`)
	assertGoalRelationState(t, f.db, f.down, 0, 3)
	if current := snapshotTask(t, f.db, f.downProject.ID, f.down); !reflect.DeepEqual(current, cleared) {
		t.Fatal("failed touch changed Goal")
	}
}
