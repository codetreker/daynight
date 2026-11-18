//go:build stress

package postgres

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// Concurrent deliveries contend on the same connection and PR numbers. Every
// confirmed transaction advances the connection revision, while duplicate PR
// hints coalesce to one row per number in the current generation.
func TestProjectWebhookConcurrentHintStress(t *testing.T) {
	const workers, perWorker, numbers = 32, 25, 4
	f := newAppSignalScopeFixture(t)
	b2EnableHook(t, f.db, f.project)
	mustQueryExec(t, f.db, `UPDATE project_github SET access_state='available' WHERE project_id=$1`, f.project)
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	var before int64
	if err := f.db.Pool.QueryRow(ctx, `SELECT revision FROM project_github WHERE project_id=$1`, f.project).Scan(&before); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	failures := make(chan error, workers)
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			select {
			case <-start:
			case <-ctx.Done():
				failures <- ctx.Err()
				return
			}
			for i := 0; i < perWorker; i++ {
				result, completion, err := b2Receive(ctx, f.db, f.project, b2Hint{Number: int64((worker+i)%numbers + 1), RequestID: uuid.NewString(), DeliveryID: fmt.Sprintf("%d-%d", worker, i)})
				if err != nil || completion.Outcome != store.TransactionCommitted || result != coregithub.ProjectWebhookEnqueued {
					failures <- fmt.Errorf("worker %d delivery %d: result %s outcome %s: %w", worker, i, result, completion.Outcome, err)
					return
				}
			}
		}(worker)
	}
	close(start)
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if t.Failed() {
		return
	}
	var revision, count, valid int64
	err := f.db.Pool.QueryRow(ctx, `SELECT revision,
 (SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1),
 (SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1 AND generation=4 AND number BETWEEN 1 AND 4 AND request_id IS NOT NULL AND delivery_id IS NOT NULL)
 FROM project_github WHERE project_id=$1`, f.project).Scan(&revision, &count, &valid)
	if err != nil || revision != before+workers*perWorker || count != numbers || valid != numbers {
		t.Fatalf("revision=%d want=%d pending=%d valid=%d err=%v", revision, before+workers*perWorker, count, valid, err)
	}
}
