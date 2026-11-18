package github_test

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestProjectWebhookReceiptPersistence(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	if _, _, err := f.write(ctx, "connect", 1, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_github SET hook_version=1,hook_repository_id=8,hook_enabled=true,hook_secret='secret'::bytea,sync_enabled=true,access_state='available' WHERE project_id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	var generation, revision int64
	if err := f.db.Pool.QueryRow(ctx, `SELECT generation,revision FROM project_github WHERE project_id=$1`, f.project).Scan(&generation, &revision); err != nil {
		t.Fatal(err)
	}
	write := func(input store.GitHubProjectWebhookReceiptWrite, extra error) (store.Completion, error) {
		return f.db.WriteProject(ctx, f.project, func(scope store.ProjectWriteScope) error {
			dao := scope.(store.GitHubProjectWebhookReceiptScope).GitHubProjectWebhookReceiptDAO()
			facts, err := dao.LockReceipt(ctx)
			if err != nil {
				return err
			}
			if !facts.Exists || !facts.Enabled || !facts.SyncEnabled || !facts.BindingValid || !facts.AccessAvailable || facts.Generation != generation || facts.RepositoryID == nil || *facts.RepositoryID != 8 || facts.CurrentRepositoryID == nil || *facts.CurrentRepositoryID != 8 {
				t.Fatalf("facts: %+v", facts)
			}
			if err := dao.RecordReceipt(ctx, input); err != nil {
				return err
			}
			return extra
		})
	}
	commit := func(c store.Completion, err error) {
		t.Helper()
		if err != nil || c.Outcome != store.TransactionCommitted {
			t.Fatalf("commit %+v: %v", c, err)
		}
	}
	commit(write(store.GitHubProjectWebhookReceiptWrite{}, nil))
	var hook, old *time.Time
	var gotRevision, count int64
	if err := f.db.Pool.QueryRow(ctx, `SELECT hook_last_received_at,last_webhook_received_at,revision,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1) FROM project_github WHERE project_id=$1`, f.project).Scan(&hook, &old, &gotRevision, &count); err != nil || hook == nil || old != nil || gotRevision != revision || count != 0 {
		t.Fatalf("receipt only hook=%v old=%v revision=%d count=%d err=%v", hook, old, gotRevision, count, err)
	}
	first, second := uuid.NewString(), uuid.NewString()
	commit(write(store.GitHubProjectWebhookReceiptWrite{Enqueue: true, Number: 42, RequestID: first, DeliveryID: "one"}, nil))
	commit(write(store.GitHubProjectWebhookReceiptWrite{Enqueue: true, Number: 42, RequestID: second, DeliveryID: "two"}, nil))
	var request, delivery string
	var queuedGeneration int64
	var received, next time.Time
	if err := f.db.Pool.QueryRow(ctx, `SELECT request_id::text,delivery_id,generation,received_at,next_attempt_at FROM project_github_pending_prs WHERE project_id=$1 AND number=42`, f.project).Scan(&request, &delivery, &queuedGeneration, &received, &next); err != nil || request != second || delivery != "two" || queuedGeneration != generation || !received.Equal(next) {
		t.Fatalf("queue request=%s delivery=%s generation=%d time=%v/%v err=%v", request, delivery, queuedGeneration, received, next, err)
	}
	if err := f.db.Pool.QueryRow(ctx, `SELECT hook_last_received_at,last_webhook_received_at,revision FROM project_github WHERE project_id=$1`, f.project).Scan(&hook, &old, &gotRevision); err != nil || hook == nil || old == nil || !hook.Equal(received) || !old.Equal(received) || gotRevision != revision+2 {
		t.Fatalf("queued receipt %v/%v revision=%d err=%v", hook, old, gotRevision, err)
	}
	// A stale request ID cannot delete a replacement, even with a valid lease.
	token := uuid.NewString()
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_github SET claim_token=$2,claim_until=now()+interval '1 hour',claim_kind='poll' WHERE project_id=$1`, f.project, token); err != nil {
		t.Fatal(err)
	}
	tx := begin(t, f.db, pgx.TxOptions{})
	worker, err := github.NewAppWorkWriter(ctx, tx, f.project, nil)
	if err != nil {
		t.Fatal(err)
	}
	acked, err := worker.AckPending(ctx, store.GitHubLease{Generation: generation, Token: token}, 42, first)
	if err != nil || acked {
		t.Fatalf("stale ack=%t err=%v", acked, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// An actual failed queue insert and an explicit later failure each roll back receipt and revision.
	for _, tc := range []struct {
		request string
		extra   error
	}{{"not-a-uuid", nil}, {uuid.NewString(), errors.New("abort")}} {
		c, err := write(store.GitHubProjectWebhookReceiptWrite{Enqueue: true, Number: 43, RequestID: tc.request, DeliveryID: "failure"}, tc.extra)
		if err == nil || c.Outcome != store.TransactionNotCommitted {
			t.Fatalf("failure completion=%+v err=%v", c, err)
		}
		var count int64
		var current time.Time
		if err := f.db.Pool.QueryRow(ctx, `SELECT hook_last_received_at,revision,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1 AND number=43) FROM project_github WHERE project_id=$1`, f.project).Scan(&current, &gotRevision, &count); err != nil || !current.Equal(received) || gotRevision != revision+2 || count != 0 {
			t.Fatalf("rollback time=%v revision=%d count=%d err=%v", current, gotRevision, count, err)
		}
	}
	if _, err := f.db.Pool.Exec(ctx, `ALTER TABLE project_github_pending_prs RENAME COLUMN delivery_id TO unavailable_delivery_id`); err != nil {
		t.Fatal(err)
	}
	c, err := write(store.GitHubProjectWebhookReceiptWrite{Enqueue: true, Number: 43, RequestID: uuid.NewString(), DeliveryID: "failure"}, nil)
	databaseFailure, code := store.DatabaseErrorFacts(err)
	if !databaseFailure || code != "42703" || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("SQL failure outcome=%+v code=%s err=%v", c, code, err)
	}
	if _, err := f.db.Pool.Exec(ctx, `ALTER TABLE project_github_pending_prs RENAME COLUMN unavailable_delivery_id TO delivery_id`); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Pool.QueryRow(ctx, `SELECT hook_last_received_at,last_webhook_received_at,revision,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1 AND number=43) FROM project_github WHERE project_id=$1`, f.project).Scan(&hook, &old, &gotRevision, &count); err != nil || hook == nil || old == nil || !hook.Equal(received) || !old.Equal(received) || gotRevision != revision+2 || count != 0 {
		t.Fatalf("SQL rollback time=%v/%v revision=%d count=%d err=%v", hook, old, gotRevision, count, err)
	}
}

func TestProjectWebhookReceiptRequiresLock(t *testing.T) {
	f := newProjectAppFixture(t)
	tx := begin(t, f.db, pgx.TxOptions{})
	if err := github.NewProjectWebhookReceipt(tx, f.project).RecordReceipt(context.Background(), store.GitHubProjectWebhookReceiptWrite{}); err == nil {
		t.Fatal("unlocked write accepted")
	}
}

func TestProjectWebhookReceiptIsProjectScoped(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	if _, _, err := f.write(ctx, "connect", 1, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_github SET hook_version=1,hook_repository_id=8,hook_enabled=true,hook_secret='secret'::bytea,sync_enabled=true,access_state='available' WHERE project_id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	other := uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Other','https://github.com/o/r')`, []any{other}},
		{`INSERT INTO project_ownership(project_id,team_id) SELECT $1,team_id FROM project_ownership WHERE project_id=$2`, []any{other, f.project}},
		{`INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,app_id,installation_id,repository_id,app_resource_id,team_grant_id,credential_version,access_state,hook_version,hook_repository_id,hook_enabled,hook_secret) SELECT $1,version,generation,revision,enabled,sync_enabled,app_id,installation_id,repository_id,app_resource_id,team_grant_id,credential_version,access_state,hook_version,hook_repository_id,hook_enabled,hook_secret FROM project_github WHERE project_id=$2`, []any{other, f.project}},
	} {
		if _, err := f.db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	receive := func(project string, repository int64) core.ProjectWebhookReceiptResult {
		t.Helper()
		var result core.ProjectWebhookReceiptResult
		c, err := f.db.WriteProject(ctx, project, func(scope store.ProjectWriteScope) error {
			var e error
			result, e = core.RecordProjectWebhook(ctx, scope.(store.GitHubProjectWebhookReceiptScope).GitHubProjectWebhookReceiptDAO(), core.ProjectWebhookIdentity{ProjectID: project, Version: 1, RepositoryID: 8}, core.WebhookEvent{Kind: "pull_request", RepositoryID: repository, Number: 42, DeliveryID: "delivery"}, uuid.NewString())
			return e
		})
		if err != nil || c.Outcome != store.TransactionCommitted {
			t.Fatalf("receipt %+v %v", c, err)
		}
		return result
	}
	if got := receive(f.project, 9); got != core.ProjectWebhookRejected {
		t.Fatalf("mismatch: %s", got)
	}
	if got := receive(f.project, 8); got != core.ProjectWebhookEnqueued {
		t.Fatalf("first project: %s", got)
	}
	var first, second, queuedFirst, queuedSecond int
	if err := f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_github WHERE project_id=$1 AND hook_last_received_at IS NOT NULL), (SELECT count(*) FROM project_github WHERE project_id=$2 AND hook_last_received_at IS NOT NULL), (SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1), (SELECT count(*) FROM project_github_pending_prs WHERE project_id=$2)`, f.project, other).Scan(&first, &second, &queuedFirst, &queuedSecond); err != nil || first != 1 || second != 0 || queuedFirst != 1 || queuedSecond != 0 {
		t.Fatalf("independent receipts %d %d queues %d %d: %v", first, second, queuedFirst, queuedSecond, err)
	}
	if got := receive(other, 8); got != core.ProjectWebhookEnqueued {
		t.Fatalf("second project: %s", got)
	}
	if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_pending_prs WHERE project_id IN ($1,$2) AND number=42`, f.project, other).Scan(&queuedFirst); err != nil || queuedFirst != 2 {
		t.Fatalf("two independent hints %d: %v", queuedFirst, err)
	}
}

func TestProjectWebhookReceiptWithoutActiveSync(t *testing.T) {
	for _, tc := range []struct{ name, change string }{
		{"sync disabled", `UPDATE project_github SET sync_enabled=false WHERE project_id=$1`},
		{"disconnected", `UPDATE project_github SET enabled=false WHERE project_id=$1`},
		{"unavailable", `UPDATE project_github SET access_state='unknown' WHERE project_id=$1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newProjectAppFixture(t)
			ctx := t.Context()
			if _, _, err := f.write(ctx, "connect", 1, nil); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Pool.Exec(ctx, `UPDATE project_github SET hook_version=1,hook_repository_id=8,hook_enabled=true,hook_secret='secret'::bytea,sync_enabled=true,access_state='available' WHERE project_id=$1`, f.project); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Pool.Exec(ctx, tc.change, f.project); err != nil {
				t.Fatal(err)
			}
			var before int64
			if err := f.db.Pool.QueryRow(ctx, `SELECT revision FROM project_github WHERE project_id=$1`, f.project).Scan(&before); err != nil {
				t.Fatal(err)
			}
			var got core.ProjectWebhookReceiptResult
			c, err := f.db.WriteProject(ctx, f.project, func(s store.ProjectWriteScope) error {
				var e error
				got, e = core.RecordProjectWebhook(ctx, s.(store.GitHubProjectWebhookReceiptScope).GitHubProjectWebhookReceiptDAO(), core.ProjectWebhookIdentity{ProjectID: f.project, Version: 1, RepositoryID: 8}, core.WebhookEvent{Kind: "pull_request", RepositoryID: 8, Number: 42, DeliveryID: "delivery"}, uuid.NewString())
				return e
			})
			if err != nil || c.Outcome != store.TransactionCommitted || got != core.ProjectWebhookReceived {
				t.Fatalf("receipt %s %+v %v", got, c, err)
			}
			var recorded bool
			var revision, count int64
			if err := f.db.Pool.QueryRow(ctx, `SELECT hook_last_received_at IS NOT NULL AND last_webhook_received_at IS NULL,revision,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1) FROM project_github WHERE project_id=$1`, f.project).Scan(&recorded, &revision, &count); err != nil || !recorded || revision != before || count != 0 {
				t.Fatalf("state recorded=%t revision=%d count=%d err=%v", recorded, revision, count, err)
			}
		})
	}
}

func TestProjectWebhookPingReceipt(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	if _, _, err := f.write(ctx, "connect", 1, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_github SET hook_version=1,hook_repository_id=8,hook_enabled=true,hook_secret='secret'::bytea,sync_enabled=true,access_state='available' WHERE project_id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	var before int64
	if err := f.db.Pool.QueryRow(ctx, `SELECT revision FROM project_github WHERE project_id=$1`, f.project).Scan(&before); err != nil {
		t.Fatal(err)
	}
	var result core.ProjectWebhookReceiptResult
	c, err := f.db.WriteProject(ctx, f.project, func(scope store.ProjectWriteScope) error {
		var e error
		result, e = core.RecordProjectWebhook(ctx, scope.(store.GitHubProjectWebhookReceiptScope).GitHubProjectWebhookReceiptDAO(), core.ProjectWebhookIdentity{ProjectID: f.project, Version: 1, RepositoryID: 8}, core.WebhookEvent{Kind: "ping", RepositoryID: 8, DeliveryID: "ping-delivery"}, uuid.NewString())
		return e
	})
	if err != nil || c.Outcome != store.TransactionCommitted || result != core.ProjectWebhookReceived {
		t.Fatalf("ping receipt=%s completion=%+v err=%v", result, c, err)
	}
	var received bool
	var revision, count int64
	if err := f.db.Pool.QueryRow(ctx, `SELECT hook_last_received_at IS NOT NULL AND last_webhook_received_at IS NULL,revision,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1) FROM project_github WHERE project_id=$1`, f.project).Scan(&received, &revision, &count); err != nil || !received || revision != before || count != 0 {
		t.Fatalf("ping state received=%t revision=%d count=%d err=%v", received, revision, count, err)
	}
}
