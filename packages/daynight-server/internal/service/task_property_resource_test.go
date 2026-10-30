package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskPropertySetRemovePresenceAndVersion(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	target := createTask(t, tasks, principal, project.ID, "Property resource")
	if target.Properties == nil || len(target.Properties) != 0 {
		t.Fatalf("new task has synthesized properties: %#v", target.Properties)
	}
	value := `[{"url":"opaque\u0000","title":"Evidence"}]`
	changed, err := tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", value, target.Version)
	if err != nil {
		t.Fatal(err)
	}
	if changed.Version != target.Version+1 || !changed.UpdatedAt.After(target.UpdatedAt) || changed.Title != target.Title || !reflect.DeepEqual(testPRs(t, changed.Properties), []core.PullRequestProperty{{URL: "opaque\x00", Title: "Evidence"}}) {
		t.Fatalf("set result: %#v", changed)
	}
	same, err := tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", ` [ { "title":"Evidence", "url":"opaque\u0000" } ] `, changed.Version)
	if err != nil || !reflect.DeepEqual(same, changed) {
		t.Fatalf("equivalent set changed task: %#v, %v", same, err)
	}
	_, err = tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", value, target.Version)
	requireFault(t, err, "version_conflict")
	removed, err := tasks.RemoveProperty(ctx, principal, project.ID, target.ID, "pullRequests", changed.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := removed.Properties["pullRequests"]; exists || removed.Version != changed.Version+1 || removed.Properties == nil {
		t.Fatalf("remove did not omit property: %#v", removed)
	}
	repeated, err := tasks.RemoveProperty(ctx, principal, project.ID, target.ID, "pullRequests", removed.Version)
	if err != nil || !reflect.DeepEqual(repeated, removed) {
		t.Fatalf("repeated removal changed task: %#v, %v", repeated, err)
	}
	_, err = tasks.RemoveProperty(ctx, principal, project.ID, target.ID, "pullRequests", changed.Version)
	requireFault(t, err, "version_conflict")
	empty, err := tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", `[]`, removed.Version)
	if err != nil {
		t.Fatal(err)
	}
	if raw, exists := empty.Properties["pullRequests"]; !exists || string(raw) != "[]" || empty.Version != removed.Version+1 {
		t.Fatalf("empty array lost presence: %#v", empty)
	}
	for _, input := range []struct{ name, value string }{{"unknown", "[]"}, {"worker", "{}"}, {"pullRequests", "null"}, {"pullRequests", `[{"url":"u","title":"t","title":"again"}]`}, {"pullRequests", `[] []`}, {"pullRequests", `{"private":"not-an-array"}`}} {
		_, err := tasks.SetProperty(ctx, principal, project.ID, target.ID, input.name, input.value, empty.Version)
		requireFault(t, err, "invalid_input")
		assertTaskUnchanged(t, tasks, principal, empty)
	}
	for _, name := range []string{"unknown", "worker"} {
		_, err := tasks.RemoveProperty(ctx, principal, project.ID, target.ID, name, empty.Version)
		requireFault(t, err, "invalid_input")
		assertTaskUnchanged(t, tasks, principal, empty)
	}
}

func TestTaskPropertyWritesPreserveWorkerAndRollback(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	target := claimWorkerTask(t, tasks, principal, claimableTask(t, tasks, principal, project.ID), workerDescriptor())
	changed, err := tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", `[]`, target.Version)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(testWorker(t, changed.Properties), testWorker(t, target.Properties)) || changed.Status != target.Status || !reflect.DeepEqual(changed.StartedAt, target.StartedAt) {
		t.Fatalf("property set changed execution: %#v", changed)
	}
	if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION reject_property_value_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private property write diagnostic'; END $$;
 CREATE TRIGGER reject_property_value_write BEFORE INSERT OR UPDATE OR DELETE ON task_properties FOR EACH ROW EXECUTE FUNCTION reject_property_value_write()`); err != nil {
		t.Fatal(err)
	}
	_, err = tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", `[{"url":"new","title":"new"}]`, changed.Version)
	assertOperational(t, err)
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		t.Fatalf("property write lost database cause: %v", err)
	}
	assertTaskUnchanged(t, tasks, principal, changed)
	_, err = tasks.RemoveProperty(ctx, principal, project.ID, target.ID, "pullRequests", changed.Version)
	assertOperational(t, err)
	assertTaskUnchanged(t, tasks, principal, changed)
}

func TestIllegalStoredPropertiesRemainInputErrorsAndPreserveTask(t *testing.T) {
	for _, value := range []struct{ name, raw string }{{"pullRequests", "{"}, {"pullRequests", `["private-stored-value"]`}, {"pullRequests", "null"}, {"worker", "null"}, {"unknown", "[]"}} {
		t.Run(value.name+"/"+value.raw, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			ctx := context.Background()
			target := createTask(t, tasks, principal, project.ID, "Unchanged")
			if _, err := database.Pool.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,$2,$3)`, target.ID, value.name, value.raw); err != nil {
				t.Fatal(err)
			}
			actions := []func() error{
				func() error { _, err := tasks.Get(ctx, principal, project.ID, target.ID); return err },
				func() error {
					_, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 10}})
					return err
				},
				func() error {
					_, err := tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version, Title: pointer("Changed")})
					return err
				},
				func() error {
					_, err := tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", `[]`, target.Version)
					return err
				},
				func() error {
					_, err := tasks.RemoveProperty(ctx, principal, project.ID, target.ID, "pullRequests", target.Version)
					return err
				},
			}
			for _, action := range actions {
				fault := requireFault(t, action(), "invalid_input")
				if strings.Contains(fault.Message, "private-stored-value") {
					t.Fatal("stored value leaked into diagnostic")
				}
			}
			var title string
			var version int64
			var updated time.Time
			var raw string
			if err := database.Pool.QueryRow(ctx, `SELECT title,version,updated_at FROM tasks WHERE id=$1`, target.ID).Scan(&title, &version, &updated); err != nil {
				t.Fatal(err)
			}
			if err := database.Pool.QueryRow(ctx, `SELECT value FROM task_properties WHERE task_id=$1 AND name=$2`, target.ID, value.name).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			if title != target.Title || version != target.Version || !updated.Equal(target.UpdatedAt) || raw != value.raw {
				t.Fatal("validation failure partially mutated task")
			}
		})
	}
}
