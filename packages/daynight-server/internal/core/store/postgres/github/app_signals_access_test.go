package github_test

import (
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestInstallationSignalPreservesPRDiagnosticsAndAccessRateLimit(t *testing.T) {
	f := newAppWorkFixture(t)
	ctx := t.Context()
	readConnection := func() githubpr.Connection {
		t.Helper()
		tx := begin(t, f.db, pgx.TxOptions{AccessMode: pgx.ReadOnly})
		connection, err := github.NewReader(tx).Connection(ctx, f.project)
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		return connection
	}
	old := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_github SET
 last_webhook_received_at=$2,last_webhook_attempt_at=$2,last_webhook_success_at=$2,
 webhook_error_code='prior-webhook',webhook_error_message='Prior webhook error',webhook_error_at=$2,
 last_poll_attempt_at=$2,last_full_success_at=$2,last_full_generation=generation,
 poll_error_code='prior-poll',poll_error_message='Prior poll error',poll_error_at=$2 WHERE project_id=$1`, f.project, old); err != nil {
		t.Fatal(err)
	}
	tx := begin(t, f.db, pgx.TxOptions{})
	w, lease, now := f.claimed(t, tx)
	connection, err := w.Connection(ctx)
	if err != nil {
		t.Fatal(err)
	}
	retry := now.Add(2 * time.Minute)
	runtime := core.Runtime(connection)
	core.AccessRetry(&runtime, now, core.Failure{Code: "github_rate_limited", RetryAt: retry})
	runtime.ReleaseClaim = true
	if ok, err := w.SaveRuntime(ctx, lease, runtime); err != nil || !ok {
		t.Fatalf("access rate limit: %t %v", ok, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	before := readConnection()
	if before.NotBefore == nil || !before.NotBefore.Equal(retry) || before.NextAccessCheckAt == nil || !before.NextAccessCheckAt.Equal(retry) {
		t.Fatalf("persisted access deadlines: %+v", before)
	}
	hint, delivery := uuid.NewString(), "new-installation-delivery"
	received := now.Add(time.Second)
	completion, err := f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(signals store.GitHubAppSignalWriter) error {
		count, err := signals.SignalAccess(ctx, store.GitHubAppAccessSignal{InstallationID: 20, HintID: hint, DeliveryID: delivery, ReceivedAt: received})
		if err == nil && count != 1 {
			t.Fatalf("installation signal changed %d projects", count)
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("installation signal: %+v %v", completion, err)
	}
	after := readConnection()
	want := before
	want.AccessHintID, want.AccessDeliveryID, want.NextAccessCheckAt = &hint, &delivery, &received
	want.Revision++
	want.UpdatedAt = after.UpdatedAt
	if !reflect.DeepEqual(after, want) {
		t.Fatalf("installation signal changed independent facts: got %+v want %+v", after, want)
	}
	for _, instant := range []time.Time{received, retry.Add(-time.Microsecond), retry} {
		projects, err := f.db.DueGitHubAppProjects(ctx, instant, 32)
		if err != nil {
			t.Fatal(err)
		}
		if instant.Before(retry) && len(projects) != 0 || !instant.Before(retry) && !reflect.DeepEqual(projects, []string{f.project}) {
			t.Fatalf("work at %s: %v", instant, projects)
		}
	}
	tx = begin(t, f.db, pgx.TxOptions{})
	w, err = github.NewAppWorkWriter(ctx, tx, f.project, &f.identity)
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := w.Claim(ctx, store.GitHubClaim{AppID: 91, Generation: 1, Token: uuid.NewString(), Kind: core.WorkAccess, Until: retry.Add(time.Minute)}); err != nil || ok {
		t.Fatalf("installation signal bypassed rate-limited claim: %t %v", ok, err)
	}
}
