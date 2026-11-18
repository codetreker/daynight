package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	tagcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/tag"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

type claimTagBarrierStore struct {
	*Store
	acquired chan struct{}
	proceed  chan struct{}
}
type claimTagBarrierScope struct {
	store.ProjectWriteScope
	acquired chan struct{}
	proceed  chan struct{}
}
type claimTagBarrierDAO struct {
	store.WorkerClaimAdmissionDAO
	acquired chan struct{}
	proceed  chan struct{}
}

func (s *claimTagBarrierStore) WriteProject(ctx context.Context, project string, operation func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.Store.WriteProject(ctx, project, func(scope store.ProjectWriteScope) error {
		return operation(claimTagBarrierScope{scope, s.acquired, s.proceed})
	})
}
func (s claimTagBarrierScope) WorkerClaimAdmissionDAO() store.WorkerClaimAdmissionDAO {
	return claimTagBarrierDAO{s.ProjectWriteScope.WorkerClaimAdmissionDAO(), s.acquired, s.proceed}
}
func (d claimTagBarrierDAO) ClaimWorkerConfiguration(ctx context.Context, user, worker string) (*model.WorkerDesiredConfiguration, error) {
	value, err := d.WorkerClaimAdmissionDAO.ClaimWorkerConfiguration(ctx, user, worker)
	if err != nil {
		return nil, err
	}
	close(d.acquired)
	select {
	case <-d.proceed:
		return value, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestWorkerClaimTagFilterLinearizesWithConfiguration(t *testing.T) {
	for _, first := range []string{"configuration", "claim"} {
		t.Run(first, func(t *testing.T) {
			s, principal, _, project := membershipFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			workerID := uuid.NewString()
			testutil.PutWorkerSnapshot(t, s, testutil.WorkerSnapshotFixture(principal.UserID, workerID, time.Now().UTC()))
			oldRaw := `{"taskTagFilter":{"names":["backend"],"match":"any"},"other":"future"}`
			newRaw := `{"taskTagFilter":{"names":["urgent"],"match":"any"},"other":"future"}`
			mustQueryExec(t, s, `UPDATE workers SET desired_configuration=$3::jsonb,configuration_revision=1,configuration_updated_at=now() WHERE user_id=$1 AND worker_id=$2`, principal.UserID, workerID, oldRaw)
			current := queryTask(t, s, project.ID, 501, model.TaskTodo)
			tagID := uuid.NewString()
			mustQueryExec(t, s, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$2,'Backend','backend',now(),now())`, tagID, project.ID)
			mustQueryExec(t, s, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES($1,$2,$3)`, project.ID, current.ID, tagID)
			mustQueryExec(t, s, `UPDATE tasks SET assigned_to=$2,allow_agents=true WHERE id=$1`, current.ID, principal.UserID)
			current = snapshotTask(t, s, project.ID, current.ID)
			key, err := tagcore.NameFilterDigest(model.TagNameFilter{Names: []string{"backend"}, Match: "any"})
			if err != nil {
				t.Fatal(err)
			}
			descriptor := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: workerID, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString()}
			claim := func(db interface {
				store.SnapshotReader
				store.ProjectWriter
			}) (model.Task, error) {
				return taskservice.NewTasks(db).ClaimWorker(ctx, principal, project.ID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor, TaskTagFilterKey: &key})
			}
			tx, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if first == "configuration" {
				if _, err = tx.Exec(ctx, `UPDATE workers SET desired_configuration=$3::jsonb,configuration_revision=2,configuration_updated_at=now() WHERE user_id=$1 AND worker_id=$2`, principal.UserID, workerID, newRaw); err != nil {
					t.Fatal(err)
				}
				type result struct {
					task model.Task
					err  error
				}
				done := make(chan result, 1)
				go func() { task, err := claim(s); done <- result{task, err} }()
				// Wait until the claim is blocked by this exact transaction, then commit it.
				for {
					var blocked bool
					err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE '%SELECT configuration_revision,configuration_updated_at,desired_configuration%')`, int32(tx.Conn().PgConn().PID())).Scan(&blocked)
					if err != nil {
						t.Fatal(err)
					}
					if blocked {
						break
					}
					select {
					case <-ctx.Done():
						t.Fatal("claim did not wait for configuration lock")
					case <-time.After(10 * time.Millisecond):
					}
				}
				if err = tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				res := <-done
				var fault *model.Fault
				if !errors.As(res.err, &fault) || fault.Code != "claim_conflict" {
					t.Fatalf("old proof: %+v %v", res.task, res.err)
				}
				if got := snapshotTask(t, s, project.ID, current.ID); got.Status != model.TaskTodo || got.Version != current.Version {
					t.Fatalf("refusal wrote task: %+v", got)
				}
			} else {
				barrier := &claimTagBarrierStore{Store: s, acquired: make(chan struct{}), proceed: make(chan struct{})}
				type result struct {
					task model.Task
					err  error
				}
				done := make(chan result, 1)
				go func() { task, err := claim(barrier); done <- result{task, err} }()
				select {
				case <-barrier.acquired:
				case <-ctx.Done():
					t.Fatal("claim did not acquire Worker lock")
				}
				update := make(chan error, 1)
				go func() {
					_, err := tx.Exec(ctx, `UPDATE workers SET desired_configuration=$3::jsonb,configuration_revision=2,configuration_updated_at=now() WHERE user_id=$1 AND worker_id=$2`, principal.UserID, workerID, newRaw)
					update <- err
				}()
				testutil.WaitThreadBackendLock(t, s.Pool, tx.Conn().PgConn().PID())
				close(barrier.proceed)
				res := <-done
				if res.err != nil || res.task.Status != model.TaskInProgress {
					t.Fatalf("claim before configuration: %+v %v", res.task, res.err)
				}
				if err = <-update; err != nil {
					t.Fatal(err)
				}
				if err = tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				got := snapshotTask(t, s, project.ID, current.ID)
				if got.Status != model.TaskInProgress || got.Version != current.Version+1 {
					t.Fatalf("claim lost after configuration: %+v", got)
				}
				var raw []byte
				if err = s.Pool.QueryRow(ctx, `SELECT desired_configuration FROM workers WHERE user_id=$1 AND worker_id=$2`, principal.UserID, workerID).Scan(&raw); err != nil {
					t.Fatal(err)
				}
				var v map[string]json.RawMessage
				if err = json.Unmarshal(raw, &v); err != nil || string(v["taskTagFilter"]) == "" {
					t.Fatal(fmt.Errorf("target unreadable: %w", err))
				}
			}
		})
	}
}
