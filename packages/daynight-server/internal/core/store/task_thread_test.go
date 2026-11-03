package store

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func appendStoredThread(t *testing.T, database *Store, taskID, userID, body string) core.ThreadMessage {
	t.Helper()
	ctx := context.Background()
	var message core.ThreadMessage
	err := database.WriteThread(ctx, func(tx *ThreadTx) error {
		head, err := tx.LockHead(ctx, taskID)
		if err != nil {
			return err
		}
		message, err = tx.InsertMessage(ctx, core.ThreadMessage{TaskID: taskID, Author: core.ThreadAuthor{UserID: userID}, Body: body})
		if err != nil {
			return err
		}
		if err := tx.PrepareTimestamp(ctx, &message, head); err != nil {
			return err
		}
		return tx.AdvanceHead(ctx, taskID, message.Position())
	})
	if err != nil {
		t.Fatal(err)
	}
	return message
}

func TestThreadMigrationDefaultsCompositeIdentityAndRestart(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:28]); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	var defaultValue, primary, order string
	var unique, foreignKeys bool
	if err := pool.QueryRow(ctx, `SELECT column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='task_thread_messages' AND column_name='message_id'`).Scan(&defaultValue); err != nil || defaultValue != "gen_random_uuid()" {
		t.Fatalf("UUID default: %q %v", defaultValue, err)
	}
	if err := pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='task_thread_messages'::regclass AND contype='p'`).Scan(&primary); err != nil || primary != "PRIMARY KEY (task_id, message_id)" {
		t.Fatalf("composite primary key: %q %v", primary, err)
	}
	if err := pool.QueryRow(ctx, `SELECT indisunique,pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid='task_thread_messages_order'::regclass`).Scan(&unique, &order); err != nil || unique || !strings.Contains(order, "(task_id, created_at, message_id)") {
		t.Fatalf("ordinary order index: %v %q %v", unique, order, err)
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid IN('task_threads'::regclass,'task_thread_messages'::regclass) AND contype='f')`).Scan(&foreignKeys); err != nil || foreignKeys {
		t.Fatalf("unexpected foreign keys: %v %v", foreignKeys, err)
	}
	first := appendStoredThread(t, database, queryID(1), queryID(9), "database UUID")
	if len(first.ID) != 36 || first.CreatedAt.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("database identity or precision: %#v", first)
	}
	for _, taskID := range []string{queryID(2), queryID(3)} {
		mustQueryExec(t, database, `INSERT INTO task_thread_messages(task_id,message_id,created_at,author_user_id,author_agent,body) VALUES($1,$2,'2026-01-02T03:04:05.123Z',$3,false,$4)`, taskID, queryID(99), queryID(9), taskID)
	}
	_, err := pool.Exec(ctx, `INSERT INTO task_thread_messages(task_id,message_id,created_at,author_user_id,author_agent,body) VALUES($1,$2,clock_timestamp(),$3,false,'duplicate')`, queryID(2), queryID(99), queryID(9))
	var postgres *pgconn.PgError
	if !errors.As(err, &postgres) || postgres.Code != "23505" {
		t.Fatalf("same-task duplicate accepted: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		for _, taskID := range []string{queryID(2), queryID(3)} {
			message, err := snapshot.ThreadMessage(ctx, taskID, queryID(99))
			if err != nil || message.Body != taskID {
				t.Fatalf("cross-task identity: %#v %v", message, err)
			}
		}
		_, err := snapshot.ThreadMessage(ctx, queryID(1), queryID(99))
		if !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("foreign task message resolved: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{
		`INSERT INTO task_threads(task_id,last_created_at) VALUES('00000000-0000-4000-8000-000000000010',now())`,
		`INSERT INTO task_thread_messages(task_id,created_at,author_user_id,author_agent,body) VALUES(gen_random_uuid(),now(),gen_random_uuid(),true,'missing execution')`,
		`INSERT INTO task_thread_messages(task_id,created_at,author_user_id,author_agent,author_provider,body) VALUES(gen_random_uuid(),now(),gen_random_uuid(),false,'codex','unexpected execution')`,
	} {
		_, err := pool.Exec(ctx, sql)
		if !errors.As(err, &postgres) || postgres.Code != "23514" {
			t.Fatalf("thread consistency constraint accepted: %v", err)
		}
	}
}

func TestThreadRoundTripAuthorizationAndTaskInvariants(t *testing.T) {
	database, principal, _, project := membershipFixture(t)
	ctx := context.Background()
	task := queryTask(t, database, project.ID, 10, core.TaskDone)
	before := snapshotTask(t, database, project.ID, task.ID)
	var epoch string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	var first, reply core.ThreadMessage
	if err := database.WriteThread(ctx, func(tx *ThreadTx) error {
		presence, err := tx.LockTaskPresence(ctx, project.ID, task.ID)
		if err != nil || !presence.Found || presence.DeletedAt != nil {
			t.Fatalf("presence: %#v %v", presence, err)
		}
		credential, err := tx.Credential(ctx, principal)
		if err != nil {
			return err
		}
		member, err := tx.ProjectMember(ctx, principal, project.ID)
		if err != nil || member.UserID != principal.UserID {
			t.Fatalf("locked member: %#v %v", member, err)
		}
		name, err := tx.AuthorName(ctx, principal.UserID)
		if err != nil || name != nil {
			t.Fatalf("nullable author: %#v %v", name, err)
		}
		source, err := tx.SourceTask(ctx, project.ID, task.ID)
		if err != nil || source.Status != core.TaskDone || len(source.Properties) != 0 {
			t.Fatalf("minimal source: %#v %v", source, err)
		}
		head, err := tx.LockHead(ctx, task.ID)
		if err != nil || head != nil {
			t.Fatalf("empty head: %#v %v", head, err)
		}
		first, err = tx.InsertMessage(ctx, core.ThreadMessage{TaskID: task.ID, Author: core.ThreadAuthor{UserID: principal.UserID}, Body: "  immutable\n<>& 中文 😀\t  "})
		if err != nil {
			return err
		}
		if err := tx.PrepareTimestamp(ctx, &first, head); err != nil {
			return err
		}
		valid, err := tx.CredentialValid(ctx, credential)
		if err != nil || !valid {
			t.Fatalf("final credential: %v %v", valid, err)
		}
		return tx.AdvanceHead(ctx, task.ID, first.Position())
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.WriteThread(ctx, func(tx *ThreadTx) error {
		head, err := tx.LockHead(ctx, task.ID)
		if err != nil || head == nil || *head != first.Position() {
			t.Fatalf("existing head: %#v %v", head, err)
		}
		if _, err := tx.ThreadMessage(ctx, task.ID, first.ID); err != nil {
			return err
		}
		reply, err = tx.InsertMessage(ctx, core.ThreadMessage{TaskID: task.ID, Author: core.ThreadAuthor{UserID: principal.UserID, Agent: true,
			Execution: &core.ThreadExecution{ClaimID: queryID(900), WorkerID: queryID(901), Provider: "codex"}}, Body: "reply", ReplyTo: &first.ID})
		if err != nil {
			return err
		}
		if err := tx.PrepareTimestamp(ctx, &reply, head); err != nil {
			return err
		}
		return tx.AdvanceHead(ctx, task.ID, reply.Position())
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `UPDATE users SET name='Renamed' WHERE id=$1`, principal.UserID)
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		if _, err := snapshot.Credential(ctx, principal); err != nil {
			return err
		}
		presence, err := snapshot.TaskPresence(ctx, project.ID, task.ID)
		if err != nil || !presence.Found {
			t.Fatalf("snapshot presence: %#v %v", presence, err)
		}
		missing, err := snapshot.TaskPresence(ctx, project.ID, queryID(999))
		if err != nil || missing.Found {
			t.Fatalf("missing presence: %#v %v", missing, err)
		}
		read, err := snapshot.ThreadMessage(ctx, task.ID, first.ID)
		if err != nil || !reflect.DeepEqual(read, first) || read.Author.DisplayName != nil {
			t.Fatalf("immutable original: %#v %v", read, err)
		}
		read, err = snapshot.ThreadMessage(ctx, task.ID, reply.ID)
		if err != nil || !reflect.DeepEqual(read, reply) {
			t.Fatalf("immutable reply/source: %#v %v", read, err)
		}
		for _, before := range []bool{false, true} {
			items, err := snapshot.ThreadCandidates(ctx, task.ID, nil, before, 1)
			want := first
			if before {
				want = reply
			}
			if err != nil || len(items) != 1 || items[0].ID != want.ID {
				t.Fatalf("traversal before=%v: %#v %v", before, items, err)
			}
		}
		anchor := first.Position()
		items, err := snapshot.ThreadCandidates(ctx, task.ID, &anchor, false, 2)
		if err != nil || len(items) != 1 || items[0].ID != reply.ID {
			t.Fatalf("after cursor: %#v %v", items, err)
		}
		before, after, err := snapshot.ThreadSides(ctx, task.ID, first.Position(), first.Position())
		if err != nil || before || !after {
			t.Fatalf("sides: %v %v %v", before, after, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if after := snapshotTask(t, database, project.ID, task.ID); !reflect.DeepEqual(before, after) {
		t.Fatalf("Thread changed Task: before=%#v after=%#v", before, after)
	}
	var afterEpoch string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&afterEpoch); err != nil || afterEpoch != epoch {
		t.Fatalf("Thread changed cache epoch: %s %s %v", epoch, afterEpoch, err)
	}
}

func TestThreadCredentialKindsAndExpiry(t *testing.T) {
	database := isolatedStore(t)
	_, principal, session := testAuthRecords(t, database)
	ctx := context.Background()
	pat := core.PersonalAccessToken{ID: queryID(1), TokenHash: []byte(strings.Repeat("x", 32)), Name: "thread PAT", CreatedAt: time.Now().UTC()}
	if err := database.CreatePAT(ctx, principal, pat); err != nil {
		t.Fatal(err)
	}
	patPrincipal := core.Principal{Kind: core.PATCredential, UserID: principal.UserID, CredentialID: pat.ID}
	if err := database.WriteThread(ctx, func(tx *ThreadTx) error {
		credential, err := tx.Credential(ctx, patPrincipal)
		if err != nil || credential.ExpiresAt != nil {
			t.Fatalf("non-expiring PAT: %#v %v", credential, err)
		}
		valid, err := tx.CredentialValid(ctx, credential)
		if err != nil || !valid {
			t.Fatalf("PAT final admission: %v %v", valid, err)
		}
		expired := time.Now().Add(-time.Hour)
		valid, err = tx.CredentialValid(ctx, ThreadCredential{ExpiresAt: &expired})
		if err != nil || valid {
			t.Fatalf("expired final admission: %v %v", valid, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `UPDATE sessions SET expires_at=$2 WHERE id=$1`, session.ID, session.CreatedAt.Add(time.Microsecond))
	for _, principal := range []core.Principal{principal, {Kind: "invalid", UserID: principal.UserID, CredentialID: principal.CredentialID}, {Kind: core.PATCredential, UserID: queryID(999), CredentialID: pat.ID}} {
		err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error { _, err := snapshot.Credential(ctx, principal); return err })
		if !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("invalid credential accepted: %#v %v", principal, err)
		}
	}
}

func TestThreadRejectedAppendRollsBackCandidateAndLazyHead(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	rejected := errors.New("reject after insertion")
	err := database.WriteThread(ctx, func(tx *ThreadTx) error {
		if _, err := tx.LockHead(ctx, queryID(1)); err != nil {
			return err
		}
		if _, err := tx.InsertMessage(ctx, core.ThreadMessage{TaskID: queryID(1), Author: core.ThreadAuthor{UserID: queryID(9)}, Body: "rejected"}); err != nil {
			return err
		}
		return rejected
	})
	var failure *ThreadTransactionError
	if !errors.As(err, &failure) || !errors.Is(err, rejected) || failure.CommitAttempted || failure.RollbackFailed {
		t.Fatalf("callback classification: %#v %v", failure, err)
	}
	for _, table := range []string{"task_threads", "task_thread_messages"} {
		var count int
		if err := database.Pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("rejected %s persisted: %d %v", table, count, err)
		}
	}
	assertMigrationPoolReusable(t, database.Pool)
}

func TestThreadClosedTransactionsKeepStoreFailures(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	var closed *ThreadTx
	if err := database.WriteThread(ctx, func(tx *ThreadTx) error { closed = tx; return nil }); err != nil {
		t.Fatal(err)
	}
	checks := []func() error{
		func() error { _, err := closed.LockTaskPresence(ctx, queryID(1), queryID(2)); return err },
		func() error {
			_, err := closed.Credential(ctx, core.Principal{Kind: core.PATCredential, UserID: queryID(1), CredentialID: queryID(2)})
			return err
		},
		func() error {
			_, err := closed.ProjectMember(ctx, core.Principal{UserID: queryID(1)}, queryID(2))
			return err
		},
		func() error { _, err := closed.AuthorName(ctx, queryID(1)); return err },
		func() error { _, err := closed.SourceTask(ctx, queryID(1), queryID(2)); return err },
		func() error { _, err := closed.LockHead(ctx, queryID(1)); return err },
		func() error { _, err := closed.ThreadMessage(ctx, queryID(1), queryID(2)); return err },
		func() error { _, err := closed.InsertMessage(ctx, core.ThreadMessage{TaskID: queryID(1)}); return err },
		func() error { _, err := closed.CredentialValid(ctx, ThreadCredential{}); return err },
		func() error {
			return closed.AdvanceHead(ctx, queryID(1), core.ThreadPosition{CreatedAt: time.Now(), ID: queryID(2)})
		},
	}
	for index, check := range checks {
		if err := check(); !errors.Is(err, pgx.ErrTxClosed) || strings.Contains(err.Error(), "SELECT") {
			t.Fatalf("closed method %d cause lost or leaked: %v", index, err)
		}
	}
	var snapshot *Snapshot
	if err := database.ReadSnapshot(ctx, func(tx *Snapshot) error { snapshot = tx; return nil }); err != nil {
		t.Fatal(err)
	}
	for _, check := range []func() error{
		func() error { _, err := snapshot.ThreadCandidates(ctx, queryID(1), nil, false, 2); return err },
		func() error {
			_, _, err := snapshot.ThreadSides(ctx, queryID(1), core.ThreadPosition{}, core.ThreadPosition{})
			return err
		},
	} {
		if err := check(); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("closed read cause lost: %v", err)
		}
	}
}
