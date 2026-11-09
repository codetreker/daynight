package webhook

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func expectedHistoryDisclosure(identities ...string) string {
	sort.Strings(identities)
	sum := sha256.Sum256([]byte(strings.Join(identities, "")))
	return hex.EncodeToString(sum[:])
}

func freshHistoryDisclosure(t *testing.T, ctx context.Context, source *pgx.Conn, owner wm.Owner, endpoint, actor string, before time.Time) string {
	t.Helper()
	reader, err := pgx.Connect(ctx, source.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close(context.Background())
	tx, err := reader.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	fingerprint, err := New(tx).HistoryDisclosure(ctx, owner, endpoint, actor, before)
	if err != nil {
		t.Fatal(err)
	}
	return fingerprint
}

func TestHistoryDisclosureTracksCommittedSourceChangesWithoutSubscriptions(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	owner := wm.Owner{Kind: "personal", ID: f.user}
	unrelated := uuid.NewString()
	if _, err := f.conn.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'uncaptured source task')`, unrelated, f.project); err != nil {
		t.Fatal(err)
	}
	var before time.Time
	if err := f.conn.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	baseline := freshHistoryDisclosure(t, ctx, f.conn, owner, f.endpoint, f.user, before)
	wantBaseline := expectedHistoryDisclosure("project:" + f.project + "\n")
	if baseline != wantBaseline {
		t.Fatalf("baseline source identity fingerprint=%s want=%s", baseline, wantBaseline)
	}
	if _, err := f.conn.Exec(ctx, `DELETE FROM webhook_subscriptions WHERE endpoint_id=$1`, f.endpoint); err != nil {
		t.Fatal(err)
	}
	var subscriptions, matches int
	if err := f.conn.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_subscriptions WHERE endpoint_id=$1),(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$2)`, f.endpoint, f.delivery).Scan(&subscriptions, &matches); err != nil || subscriptions != 0 || matches != 1 {
		t.Fatalf("retained-source fixture: subscriptions=%d matches=%d error=%v", subscriptions, matches, err)
	}
	if got := freshHistoryDisclosure(t, ctx, f.conn, owner, f.endpoint, f.user, before); got != baseline {
		t.Fatalf("subscription cleanup changed source fingerprint: %s want=%s", got, baseline)
	}
	// This Task has no captured notification, but its committed tombstone still
	// changes disclosure for the fixed project-access baseline.
	if _, err := f.conn.Exec(ctx, `UPDATE tasks SET deleted_at=statement_timestamp(),version=version+1 WHERE id=$1`, unrelated); err != nil {
		t.Fatal(err)
	}
	afterDelete := freshHistoryDisclosure(t, ctx, f.conn, owner, f.endpoint, f.user, before)
	wantDeleted := expectedHistoryDisclosure("project:"+f.project+"\n", "task:"+unrelated+"\n")
	if afterDelete == baseline || afterDelete != wantDeleted {
		t.Fatalf("committed source deletion did not bind disclosure: got=%s baseline=%s want=%s", afterDelete, baseline, wantDeleted)
	}
	lateProject, lateTask := uuid.NewString(), uuid.NewString()
	if _, err := f.conn.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'post-cutoff project','https://example.test/late')`, lateProject); err != nil {
		t.Fatal(err)
	}
	if _, err := f.conn.Exec(ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, lateProject, f.team); err != nil {
		t.Fatal(err)
	}
	if _, err := f.conn.Exec(ctx, `INSERT INTO tasks(id,project_id,title,deleted_at) VALUES($1,$2,'post-cutoff tombstone',statement_timestamp())`, lateTask, f.project); err != nil {
		t.Fatal(err)
	}
	var lateOnly bool
	if err := f.conn.QueryRow(ctx, `SELECT (SELECT created_at>$1 FROM projects WHERE id=$2) AND (SELECT created_at>$1 FROM tasks WHERE id=$3)`, before, lateProject, lateTask).Scan(&lateOnly); err != nil || !lateOnly {
		t.Fatalf("post-cutoff inputs were not actually newer: %v %v", lateOnly, err)
	}
	if got := freshHistoryDisclosure(t, ctx, f.conn, owner, f.endpoint, f.user, before); got != afterDelete {
		t.Fatalf("post-cutoff sources changed baseline disclosure: %s want=%s", got, afterDelete)
	}
	newTeam := uuid.NewString()
	if _, err := f.conn.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'inaccessible new owner')`, newTeam); err != nil {
		t.Fatal(err)
	}
	if _, err := f.conn.Exec(ctx, `UPDATE project_ownership SET team_id=$1 WHERE project_id=$2`, newTeam, f.project); err != nil {
		t.Fatal(err)
	}
	afterAccessLoss := freshHistoryDisclosure(t, ctx, f.conn, owner, f.endpoint, f.user, before)
	if afterAccessLoss == afterDelete || afterAccessLoss != expectedHistoryDisclosure() {
		t.Fatalf("committed access loss kept old project/task identities: %s", afterAccessLoss)
	}
	if _, err := f.conn.Exec(ctx, `UPDATE project_ownership SET team_id=$1 WHERE project_id=$2`, f.team, f.project); err != nil {
		t.Fatal(err)
	}
	if got := freshHistoryDisclosure(t, ctx, f.conn, owner, f.endpoint, f.user, before); got != afterDelete {
		t.Fatalf("restored access did not restore exact source baseline: %s want=%s", got, afterDelete)
	}
}

func TestHistoryDisclosureIgnoresRetentionAndPostCutoffRecords(t *testing.T) {
	f := newRetentionStorageFixture(t, 1, 1, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	id := f.deliveries[0]
	var actor, project, endpoint, team string
	if err := f.conn.QueryRow(ctx, `SELECT d.owner_id::text,d.project_id::text,d.endpoint_id::text,o.team_id::text FROM webhook_deliveries d JOIN project_ownership o ON o.project_id=d.project_id WHERE d.id=$1`, id).Scan(&actor, &project, &endpoint, &team); err != nil {
		t.Fatal(err)
	}
	owner := wm.Owner{Kind: "personal", ID: actor}
	if _, err := f.conn.Exec(ctx, `DELETE FROM webhook_subscriptions WHERE endpoint_id=$1`, endpoint); err != nil {
		t.Fatal(err)
	}
	var expiry, before time.Time
	if err := f.conn.QueryRow(ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,metadata_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING metadata_expires_at`, id).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	if err := f.conn.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	baseline := freshHistoryDisclosure(t, ctx, f.conn, owner, endpoint, actor, before)
	if baseline != expectedHistoryDisclosure("project:"+project+"\n") {
		t.Fatalf("retention source baseline=%s", baseline)
	}
	assertStable := func(stage string) {
		t.Helper()
		if got := freshHistoryDisclosure(t, ctx, f.conn, owner, endpoint, actor, before); got != baseline {
			t.Fatalf("%s changed source disclosure: got=%s want=%s", stage, got, baseline)
		}
	}
	lateProject, lateTask := uuid.NewString(), uuid.NewString()
	if _, err := f.conn.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'later accessible project','https://example.test/later')`, lateProject); err != nil {
		t.Fatal(err)
	}
	if _, err := f.conn.Exec(ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, lateProject, team); err != nil {
		t.Fatal(err)
	}
	if _, err := f.conn.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'later retained delivery')`, lateTask, project); err != nil {
		t.Fatal(err)
	}
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	event, prepared := captureBoundaryRecords(t, ctx, tx, id, 2)
	event.ID, event.TaskID, event.Subject = uuid.NewString(), lateTask, "tasks/"+lateTask
	if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&event.OccurredAt); err != nil {
		t.Fatal(err)
	}
	event.RecordedAt = event.OccurredAt
	for i := range prepared.AutomaticScheduleAt {
		prepared.AutomaticScheduleAt[i] = event.OccurredAt.Add(time.Duration(i) * time.Minute)
	}
	prepared.AutomaticExpiresAt, prepared.PayloadExpiresAt = event.OccurredAt.Add(72*time.Hour), event.OccurredAt.Add(168*time.Hour)
	prepared.LastActivityAt, prepared.MetadataExpiresAt = event.OccurredAt, event.OccurredAt.Add(30*24*time.Hour)
	if err = New(tx).SaveCapture(ctx, event, []store.WebhookCapturedDelivery{prepared}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	assertStable("post-cutoff project and Delivery insertion")
	for {
		var expired bool
		if err = f.conn.QueryRow(ctx, `SELECT clock_timestamp()>=$1`, expiry).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	assertStable("natural metadata expiry")
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if n, err := New(tx).CloseRetention(ctx, id, time.Now()); err != nil || n != 2 {
		t.Fatalf("purge marker: %d %v", n, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	assertStable("committed purge marker")
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao := New(tx)
	if n, err := dao.DeleteRetentionChildren(ctx, id, 500); err != nil || n != 2 {
		t.Fatalf("physical proof/attempt cleanup: %d %v", n, err)
	}
	if n, err := dao.DeleteRetainedDelivery(ctx, id); err != nil || n != 1 {
		t.Fatalf("physical Delivery cleanup: %d %v", n, err)
	}
	if eventID, n, err := dao.DeleteUnreferencedEvent(ctx); err != nil || n != 1 || eventID != f.event {
		t.Fatalf("physical Event cleanup: %s %d %v", eventID, n, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var removed int
	if err = f.conn.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE id=$1)+(SELECT count(*) FROM webhook_deliveries WHERE id=$2)+(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$2)+(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$2)`, f.event, id).Scan(&removed); err != nil || removed != 0 {
		t.Fatalf("retention deletion did not commit: %d %v", removed, err)
	}
	assertStable("physical Event/Delivery/match/attempt deletion")
}
