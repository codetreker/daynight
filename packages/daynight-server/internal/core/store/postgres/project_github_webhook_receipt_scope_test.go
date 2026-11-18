package postgres

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProjectWebhookReceiptLostCommitConfirmation(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := lifecycleFixture(t)
	ctx := t.Context()
	mustQueryExec(t, f.db, `UPDATE project_github SET hook_version=1,hook_repository_id=10,hook_enabled=true,hook_secret='secret'::bytea,access_state='available' WHERE project_id=$1`, f.project.ID)
	var armed, lost atomic.Bool
	config := f.db.Pool.Config().Copy()
	config.ConnConfig.TLSConfig = nil
	config.ConnConfig.Fallbacks = nil
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostGrantCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	request := uuid.NewString()
	armed.Store(true)
	c, err := (&Store{Pool: pool}).WriteProject(ctx, f.project.ID, func(scope store.ProjectWriteScope) error {
		_, e := core.RecordProjectWebhook(ctx, scope.(store.GitHubProjectWebhookReceiptScope).GitHubProjectWebhookReceiptDAO(), core.ProjectWebhookIdentity{ProjectID: f.project.ID, Version: 1, RepositoryID: 10}, core.WebhookEvent{Kind: "pull_request", RepositoryID: 10, Number: 42, DeliveryID: "delivery"}, request)
		return e
	})
	var txErr *store.TransactionError
	if !lost.Load() || c.Outcome != store.TransactionUnknown || !errors.As(err, &txErr) || !txErr.CommitAttempted || txErr.Phase != "commit" {
		t.Fatalf("lost confirmation %+v %v", c, err)
	}
	var durable bool
	if err := f.db.Pool.QueryRow(ctx, `SELECT hook_last_received_at IS NOT NULL AND last_webhook_received_at IS NOT NULL AND revision=5 AND EXISTS(SELECT 1 FROM project_github_pending_prs WHERE project_id=$1 AND number=42 AND request_id=$2) FROM project_github WHERE project_id=$1`, f.project.ID, request).Scan(&durable); err != nil || !durable {
		t.Fatalf("durable original: %t %v", durable, err)
	}
}

func TestProjectWebhookReceiptSerializesWithChanges(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, kind := range []string{"rotate", "disable", "binding", "revoke"} {
		for _, receiptFirst := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/receiptFirst=%t", kind, receiptFirst), func(t *testing.T) {
				f := lifecycleFixture(t)
				mustQueryExec(t, f.db, `UPDATE project_github SET hook_version=1,hook_repository_id=10,hook_enabled=true,hook_secret='secret'::bytea,access_state='available' WHERE project_id=$1`, f.project.ID)
				ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
				entered, release := make(chan struct{}), make(chan struct{})
				var once sync.Once
				var workers sync.WaitGroup
				unblock := func() { once.Do(func() { close(release) }) }
				defer func() { cancel(); unblock(); workers.Wait() }()
				hold := func() error {
					close(entered)
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				}
				receive := func(block bool) error {
					var result core.ProjectWebhookReceiptResult
					c, err := f.db.WriteProject(ctx, f.project.ID, func(scope store.ProjectWriteScope) error {
						var e error
						result, e = core.RecordProjectWebhook(ctx, scope.(store.GitHubProjectWebhookReceiptScope).GitHubProjectWebhookReceiptDAO(), core.ProjectWebhookIdentity{ProjectID: f.project.ID, Version: 1, RepositoryID: 10}, core.WebhookEvent{Kind: "pull_request", RepositoryID: 10, Number: 42, DeliveryID: "delivery"}, uuid.NewString())
						if e != nil {
							return e
						}
						if block {
							return hold()
						}
						return nil
					})
					if !receiptFirst && (kind == "rotate" || kind == "disable") {
						if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, core.ErrProjectWebhookSnapshotChanged) {
							return fmt.Errorf("stale receipt %+v %v", c, err)
						}
						return nil
					}
					want := core.ProjectWebhookEnqueued
					if !receiptFirst && kind == "binding" {
						want = core.ProjectWebhookRejected
					}
					if !receiptFirst && kind == "revoke" {
						want = core.ProjectWebhookReceived
					}
					if err != nil || c.Outcome != store.TransactionCommitted || result != want {
						return fmt.Errorf("receipt=%s want=%s completion=%+v err=%v", result, want, c, err)
					}
					return nil
				}
				change := func(block bool) error {
					var c store.Completion
					var err error
					if kind == "revoke" {
						c, err = f.db.WriteGitHubGrant(ctx, f.project.Ownership.TeamID, f.app, f.actor.UserID, func(w store.GitHubGrantWriteDAO) error {
							if e := core.RevokeGrant(ctx, w, f.actor, f.grant, core.RevokeGrantInput{ExpectedUserID: f.actor.UserID, Version: 1, ImpactVersion: 1}); e != nil {
								return e
							}
							if block {
								return hold()
							}
							return nil
						})
					} else {
						c, err = f.db.WriteProject(ctx, f.project.ID, func(scope store.ProjectWriteScope) error {
							if kind == "binding" {
								if _, e := scope.(*ProjectTx).tx.Exec(ctx, `UPDATE project_github SET repository_id=11 WHERE project_id=$1`, f.project.ID); e != nil {
									return e
								}
							} else {
								version := int64(1)
								secret := "rotated"
								in := core.ProjectWebhookInput{ExpectedUserID: f.actor.UserID, Version: &version, Enabled: kind != "disable"}
								if kind == "rotate" {
									in.Secret = &secret
								}
								if _, e := core.ManageProjectWebhook(ctx, scope.(store.GitHubProjectWebhookScope).GitHubProjectWebhookDAO(), f.actor, in); e != nil {
									return e
								}
							}
							if block {
								return hold()
							}
							return nil
						})
					}
					if err != nil || c.Outcome != store.TransactionCommitted {
						return fmt.Errorf("change %+v %v", c, err)
					}
					return nil
				}
				first, second := make(chan error, 1), make(chan error, 1)
				start := func(out chan<- error, op func() error) {
					workers.Add(1)
					go func() { defer workers.Done(); out <- op() }()
				}
				if receiptFirst {
					start(first, func() error { return receive(true) })
				} else {
					start(first, func() error { return change(true) })
				}
				select {
				case <-entered:
				case err := <-first:
					t.Fatalf("first failed: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if receiptFirst {
					start(second, func() error { return change(false) })
				} else {
					start(second, func() error { return receive(false) })
				}
				if kind == "revoke" {
					if receiptFirst {
						waitForQueryLock(t, f.db, "SELECT COALESCE(bool_or(version=")
					} else {
						waitForQueryLock(t, f.db, "SELECT hook_version,hook_repository_id,hook_enabled,hook_last_received_at,")
					}
				} else {
					waitForQueryLock(t, f.db, "SELECT id::text FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE")
				}
				unblock()
				if err := receiveQueryResult(t, ctx, first); err != nil {
					t.Fatal(err)
				}
				if err := receiveQueryResult(t, ctx, second); err != nil {
					t.Fatal(err)
				}
				var count int
				if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1 AND number=42`, f.project.ID).Scan(&count); err != nil {
					t.Fatal(err)
				}
				want := 0
				if receiptFirst && kind != "revoke" {
					want = 1
				}
				if count != want {
					t.Fatalf("queue count=%d want=%d", count, want)
				}
			})
		}
	}
}
