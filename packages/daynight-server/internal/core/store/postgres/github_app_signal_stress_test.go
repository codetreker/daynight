//go:build stress

package postgres

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// Concurrent deliveries contend on the same connection and PR numbers. Every
// confirmed transaction advances the connection revision, while duplicate PR
// hints coalesce to one row per number in the current generation.
func TestAppWebhookConcurrentHintStress(t *testing.T) {
	const workers, perWorker, numbers = 32, 25, 4
	f := newAppSignalScopeFixture(t)
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
				now := time.Now().UTC()
				completion, err := f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(w store.GitHubAppSignalWriter) error {
					matched, e := w.SignalPullRequest(ctx, store.GitHubAppPRSignal{InstallationID: 20, RepositoryID: 30, Number: int64((worker+i)%numbers + 1), RequestID: uuid.NewString(), DeliveryID: fmt.Sprintf("%d-%d", worker, i), ReceivedAt: now, NextAttemptAt: now})
					if e == nil && matched != 1 {
						return fmt.Errorf("matched %d connections", matched)
					}
					return e
				})
				if err != nil || completion.Outcome != store.TransactionCommitted {
					failures <- fmt.Errorf("worker %d delivery %d: outcome %s: %w", worker, i, completion.Outcome, err)
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
