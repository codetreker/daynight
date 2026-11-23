package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

type cascadeFixture struct {
	db        *postgres.Store
	principal model.Principal
	project   string
	ids       []string
}

func newCascadeFixture(t *testing.T, subscribe bool) cascadeFixture {
	t.Helper()
	db := writerStore(t)
	_, principal, _ := testutil.AuthRecords(t, db)
	project := uuid.NewString()
	if _, err := testutil.CreatePrivateProject(t.Context(), db, principal, project, "Cascade", "https://example.test/cascade"); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 7)
	statuses := []string{"in_progress", "proposed", "done", "in_progress", "cancelled", "todo", "todo"}
	for i := range ids {
		ids[i] = testutil.QueryID(700 + i)
		var parent any
		if i > 0 && i < 6 {
			parent = ids[i-1]
		}
		if i == 6 {
			parent = ids[1]
		}
		var deleted any
		if i == 6 {
			deleted = time.Now().UTC()
		}
		testutil.MustExec(t, db.Pool, `INSERT INTO tasks(id,project_id,type,title,status,parent_id,deleted_at,cancelled_at) VALUES($1,$2,'task','cascade',$3,$4,$5,CASE WHEN $3='cancelled' THEN now() END)`, ids[i], project, statuses[i], parent, deleted)
		testutil.MustExec(t, db.Pool, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}','{"lifecycle":"active","lastTimelineSeq":"3","controls":{}}')`, uuid.NewString(), project, ids[i], uuid.NewString(), principal.UserID, uuid.NewString())
	}
	if subscribe {
		name, enabled := "cascade receiver", true
		service := &webhookservice.Service{DB: db, ConfigurationExpansionAvailable: true}
		_, err := service.Mutate(t.Context(), principal, webhookmodel.Owner{Kind: "personal", ID: principal.UserID}, webhookservice.Mutation{
			Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: principal.UserID,
			RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled,
			Destination: &webhookservice.Destination{Kind: "http", AdapterVersion: "1", URL: "https://example.test/hook"}, HasSubscriptions: true,
			Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.status_changed"}}},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return cascadeFixture{db: db, principal: principal, project: project, ids: ids}
}

func (f cascadeFixture) snapshot(t *testing.T) string {
	t.Helper()
	var result string
	err := f.db.Pool.QueryRow(t.Context(), `SELECT jsonb_build_object(
        'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t WHERE project_id=$1),
        'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name) FROM task_properties p JOIN tasks t ON t.id=p.task_id WHERE t.project_id=$1),
        'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE project_id=$1),
        'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM webhook_events e WHERE project_id=$1),
        'deliveries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM webhook_deliveries d WHERE project_id=$1))::text`, f.project).Scan(&result)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f cascadeFixture) cancel(t *testing.T, version int64) (model.Task, error) {
	t.Helper()
	return taskservice.NewTasks(f.db, &webhookservice.Capturer{}).SetStatus(t.Context(), f.principal, f.project, f.ids[0], taskcore.SetTaskStatus{Version: version, Status: model.TaskCancelled, CancelDescendants: true})
}

func TestCascadeCancellationAtomicPersistence(t *testing.T) {
	for _, scenario := range []string{"deep_claim", "stale_version", "late_capture_failure", "success", "no_audience"} {
		t.Run(scenario, func(t *testing.T) {
			f := newCascadeFixture(t, scenario != "no_audience")
			if scenario == "deep_claim" {
				testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET status='in_progress' WHERE id=$1`, f.ids[5])
				raw, err := json.Marshal(map[string]any{"claimId": uuid.NewString(), "state": "active", "userId": f.principal.UserID, "workerId": uuid.NewString(), "machine": map[string]string{"id": uuid.NewString(), "name": "machine"}, "platform": "linux", "agent": "codex", "agentControlMode": "herdr", "worktreeId": uuid.NewString(), "phase": "preparing", "claimedAt": "2026-01-01T00:00:00Z"})
				if err != nil {
					t.Fatal(err)
				}
				testutil.MustExec(t, f.db.Pool, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, f.ids[5], raw)
			}
			if scenario == "late_capture_failure" {
				testutil.MustExec(t, f.db.Pool, `CREATE FUNCTION reject_cascade_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected late capture failure'; END $$`)
				testutil.MustExec(t, f.db.Pool, fmt.Sprintf(`CREATE TRIGGER reject_cascade_event BEFORE INSERT ON webhook_events FOR EACH ROW WHEN (NEW.task_id = '%s'::uuid) EXECUTE FUNCTION reject_cascade_event()`, f.ids[5]))
			}
			before := f.snapshot(t)
			version := int64(1)
			if scenario == "stale_version" {
				version++
			}
			root, err := f.cancel(t, version)
			if scenario == "deep_claim" || scenario == "stale_version" || scenario == "late_capture_failure" {
				if err == nil {
					t.Fatal("expected cancellation refusal or capture failure")
				}
				if scenario == "deep_claim" {
					var fault *model.Fault
					if !errors.As(err, &fault) || !reflect.DeepEqual(fault.TaskIDs, []string{f.ids[5]}) {
						t.Fatalf("missing deep claim ID: %v", err)
					}
				}
				if scenario == "late_capture_failure" {
					var pgErr *pgconn.PgError
					if !errors.As(err, &pgErr) || pgErr.Message != "injected late capture failure" {
						t.Fatalf("wrong capture failure: %v", err)
					}
				}
				if after := f.snapshot(t); after != before {
					t.Fatalf("failed cancellation persisted changes: before=%s after=%s", before, after)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if root.ID != f.ids[0] || root.Status != model.TaskCancelled || root.Version != 2 {
				t.Fatalf("root receipt: %+v", root)
			}
			expected := []string{"cancelled", "cancelled", "done", "cancelled", "cancelled", "cancelled", "todo"}
			changed := map[int]bool{0: true, 1: true, 3: true, 5: true}
			for i, id := range f.ids {
				var status, lifecycle string
				var version int64
				var cancelled bool
				err := f.db.Pool.QueryRow(t.Context(), `SELECT t.status,t.version,t.cancelled_at IS NOT NULL,s.snapshot->>'lifecycle' FROM tasks t JOIN task_sessions s ON s.task_id=t.id WHERE t.id=$1`, id).Scan(&status, &version, &cancelled, &lifecycle)
				if err != nil {
					t.Fatal(err)
				}
				wantVersion := int64(1)
				wantLifecycle := "active"
				if changed[i] {
					wantVersion = 2
					wantLifecycle = "draining"
				}
				if status != expected[i] || version != wantVersion || lifecycle != wantLifecycle || (changed[i] && !cancelled) {
					t.Fatalf("task %d: status=%s version=%d lifecycle=%s cancelled=%v", i, status, version, lifecycle, cancelled)
				}
			}
			var events int
			if err := f.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM webhook_events WHERE project_id=$1`, f.project).Scan(&events); err != nil {
				t.Fatal(err)
			}
			wantEvents := 4
			if scenario == "no_audience" {
				wantEvents = 0
			}
			if events != wantEvents {
				t.Fatalf("events=%d want=%d", events, wantEvents)
			}
			if scenario == "success" {
				rows, err := f.db.Pool.Query(context.Background(), `SELECT task_id::text,task_version,actor_kind,actor_user_id::text FROM webhook_events WHERE project_id=$1 ORDER BY task_id`, f.project)
				if err != nil {
					t.Fatal(err)
				}
				defer rows.Close()
				var got []string
				for rows.Next() {
					var id, kind, user string
					var v int64
					if err := rows.Scan(&id, &v, &kind, &user); err != nil {
						t.Fatal(err)
					}
					if v != 2 || kind != "user" || user != f.principal.UserID {
						t.Fatalf("event actor/version: %s %d %s %s", id, v, kind, user)
					}
					got = append(got, id)
				}
				if rows.Err() != nil {
					t.Fatal(rows.Err())
				}
				if !reflect.DeepEqual(got, []string{f.ids[0], f.ids[1], f.ids[3], f.ids[5]}) {
					t.Fatalf("event tasks: %v", got)
				}
			}
		})
	}
}
