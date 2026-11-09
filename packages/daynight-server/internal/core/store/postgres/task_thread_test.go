package postgres

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func appendStoredThread(t *testing.T, database *Store, taskID, userID, body string) model.ThreadMessage {
	t.Helper()
	ctx := context.Background()
	var message model.ThreadMessage
	err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		head, err := tx.ThreadDAO().LockHead(ctx, taskID)
		if err != nil {
			return err
		}
		message, err = tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: taskID, Author: model.ThreadAuthor{UserID: userID}, Body: body})
		if err != nil {
			return err
		}
		if err := tx.ThreadDAO().PrepareTimestamp(ctx, &message, head); err != nil {
			return err
		}
		return tx.ThreadDAO().AdvanceHead(ctx, taskID, message.Position())
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
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		for _, taskID := range []string{queryID(2), queryID(3)} {
			message, err := snapshot.TaskDAO().ThreadMessage(ctx, taskID, queryID(99))
			if err != nil || message.Body != taskID {
				t.Fatalf("cross-task identity: %#v %v", message, err)
			}
		}
		_, err := snapshot.TaskDAO().ThreadMessage(ctx, queryID(1), queryID(99))
		if !errors.Is(err, model.ErrNotFound) {
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
	task := queryTask(t, database, project.ID, 10, model.TaskDone)
	before := snapshotTask(t, database, project.ID, task.ID)
	var epoch string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	var first, reply model.ThreadMessage
	if err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		presence, err := tx.TaskDAO().LockTaskPresence(ctx, project.ID, task.ID)
		if err != nil || !presence.Found || presence.DeletedAt != nil {
			t.Fatalf("presence: %#v %v", presence, err)
		}
		credential, err := tx.CredentialDAO().Credential(ctx, principal)
		if err != nil {
			return err
		}
		access, err := tx.ProjectDAO().LockProjectAuthorization(ctx, principal, project.ID)
		if err != nil || access.ProjectID != project.ID || access.UserID != principal.UserID || access.Role != model.ProjectAdmin ||
			access.DirectGrant == nil || access.DirectGrant.ProjectID != project.ID || access.DirectGrant.UserID != principal.UserID ||
			access.DirectGrant.Role != access.Role || access.DirectGrant.Version <= 0 {
			t.Fatalf("locked authorization: %#v %v", access, err)
		}
		name, err := tx.CredentialDAO().AuthorName(ctx, principal.UserID)
		if err != nil || name != nil {
			t.Fatalf("nullable author: %#v %v", name, err)
		}
		source, err := tx.TaskDAO().SourceTask(ctx, project.ID, task.ID)
		if err != nil || source.Status != model.TaskDone || len(source.Properties) != 0 {
			t.Fatalf("minimal source: %#v %v", source, err)
		}
		head, err := tx.ThreadDAO().LockHead(ctx, task.ID)
		if err != nil || head != nil {
			t.Fatalf("empty head: %#v %v", head, err)
		}
		first, err = tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: task.ID, Author: model.ThreadAuthor{UserID: principal.UserID}, Body: "  immutable\n<>& 中文 😀\t  "})
		if err != nil {
			return err
		}
		if err := tx.ThreadDAO().PrepareTimestamp(ctx, &first, head); err != nil {
			return err
		}
		valid, err := tx.CredentialDAO().CredentialValid(ctx, credential)
		if err != nil || !valid {
			t.Fatalf("final credential: %v %v", valid, err)
		}
		return tx.ThreadDAO().AdvanceHead(ctx, task.ID, first.Position())
	}); err != nil {
		t.Fatal(err)
	}
	name := "Alice"
	mustQueryExec(t, database, `UPDATE users SET name=$2 WHERE id=$1`, principal.UserID, name)
	if err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		head, err := tx.ThreadDAO().LockHead(ctx, task.ID)
		if err != nil || head == nil || *head != first.Position() {
			t.Fatalf("existing head: %#v %v", head, err)
		}
		if _, err := tx.ThreadDAO().ThreadMessage(ctx, task.ID, first.ID); err != nil {
			return err
		}
		named, err := tx.CredentialDAO().AuthorName(ctx, principal.UserID)
		if err != nil || named == nil || *named != name {
			t.Fatalf("current author name: %#v %v", named, err)
		}
		reply, err = tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: task.ID, Author: model.ThreadAuthor{UserID: principal.UserID, DisplayName: named, Agent: true,
			Execution: &model.ThreadExecution{ClaimID: queryID(900), WorkerID: queryID(901), Provider: "codex"}}, Body: "reply", ReplyTo: &first.ID})
		if err != nil {
			return err
		}
		if err := tx.ThreadDAO().PrepareTimestamp(ctx, &reply, head); err != nil {
			return err
		}
		return tx.ThreadDAO().AdvanceHead(ctx, task.ID, reply.Position())
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `UPDATE users SET name=$2 WHERE id=$1`, principal.UserID, strings.Repeat("later-name", 10000))
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		if _, err := snapshot.CredentialDAO().Credential(ctx, principal); err != nil {
			return err
		}
		presence, err := snapshot.TaskDAO().TaskPresence(ctx, project.ID, task.ID)
		if err != nil || !presence.Found {
			t.Fatalf("snapshot presence: %#v %v", presence, err)
		}
		missing, err := snapshot.TaskDAO().TaskPresence(ctx, project.ID, queryID(999))
		if err != nil || missing.Found {
			t.Fatalf("missing presence: %#v %v", missing, err)
		}
		read, err := snapshot.TaskDAO().ThreadMessage(ctx, task.ID, first.ID)
		if err != nil || !reflect.DeepEqual(read, first) || read.Author.DisplayName != nil {
			t.Fatalf("immutable original: %#v %v", read, err)
		}
		read, err = snapshot.TaskDAO().ThreadMessage(ctx, task.ID, reply.ID)
		if err != nil || !reflect.DeepEqual(read, reply) || read.Author.DisplayName == nil || *read.Author.DisplayName != name {
			t.Fatalf("immutable reply/source: %#v %v", read, err)
		}
		for _, before := range []bool{false, true} {
			items, err := snapshot.TaskDAO().ThreadCandidates(ctx, task.ID, nil, before, 1)
			want := first
			if before {
				want = reply
			}
			if err != nil || len(items) != 1 || items[0].ID != want.ID {
				t.Fatalf("traversal before=%v: %#v %v", before, items, err)
			}
		}
		anchor := first.Position()
		items, err := snapshot.TaskDAO().ThreadCandidates(ctx, task.ID, &anchor, false, 2)
		if err != nil || len(items) != 1 || items[0].ID != reply.ID {
			t.Fatalf("after cursor: %#v %v", items, err)
		}
		before, after, err := snapshot.TaskDAO().ThreadSides(ctx, task.ID, first.Position(), first.Position())
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
	pat := model.PersonalAccessToken{ID: queryID(1), TokenHash: []byte(strings.Repeat("x", 32)), Name: "thread PAT", CreatedAt: time.Now().UTC()}
	pat.UserID = principal.UserID
	if _, err := database.WriteIdentity(ctx, func(scope IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, pat) }); err != nil {
		t.Fatal(err)
	}
	patPrincipal := model.Principal{Kind: model.PATCredential, UserID: principal.UserID, CredentialID: pat.ID}
	if err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		credential, err := tx.CredentialDAO().Credential(ctx, patPrincipal)
		if err != nil || credential.ExpiresAt != nil {
			t.Fatalf("non-expiring PAT: %#v %v", credential, err)
		}
		valid, err := tx.CredentialDAO().CredentialValid(ctx, credential)
		if err != nil || !valid {
			t.Fatalf("PAT final admission: %v %v", valid, err)
		}
		expired := time.Now().Add(-time.Hour)
		valid, err = tx.CredentialDAO().CredentialValid(ctx, ThreadCredential{ExpiresAt: &expired})
		if err != nil || valid {
			t.Fatalf("expired final admission: %v %v", valid, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `UPDATE sessions SET expires_at=$2 WHERE id=$1`, session.ID, session.CreatedAt.Add(time.Microsecond))
	for _, principal := range []model.Principal{principal, {Kind: "invalid", UserID: principal.UserID, CredentialID: principal.CredentialID}, {Kind: model.PATCredential, UserID: queryID(999), CredentialID: pat.ID}} {
		err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			_, err := snapshot.CredentialDAO().Credential(ctx, principal)
			return err
		})
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("invalid credential accepted: %#v %v", principal, err)
		}
	}
}

func TestThreadRejectedAppendRollsBackCandidateAndLazyHead(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	rejected := errors.New("reject after insertion")
	err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		if _, err := tx.ThreadDAO().LockHead(ctx, queryID(1)); err != nil {
			return err
		}
		if _, err := tx.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "rejected"}); err != nil {
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
	var closed ThreadScope
	if err := threadTestWrite(database, ctx, func(tx ThreadScope) error { closed = tx; return nil }); err != nil {
		t.Fatal(err)
	}
	checks := []func() error{
		func() error { _, err := closed.TaskDAO().LockTaskPresence(ctx, queryID(1), queryID(2)); return err },
		func() error {
			_, err := closed.CredentialDAO().Credential(ctx, model.Principal{Kind: model.PATCredential, UserID: queryID(1), CredentialID: queryID(2)})
			return err
		},
		func() error {
			_, err := closed.ProjectDAO().LockProjectAuthorization(ctx, model.Principal{UserID: queryID(1)}, queryID(2))
			return err
		},
		func() error { _, err := closed.CredentialDAO().AuthorName(ctx, queryID(1)); return err },
		func() error { _, err := closed.TaskDAO().SourceTask(ctx, queryID(1), queryID(2)); return err },
		func() error { _, err := closed.ThreadDAO().LockHead(ctx, queryID(1)); return err },
		func() error { _, err := closed.ThreadDAO().ThreadMessage(ctx, queryID(1), queryID(2)); return err },
		func() error {
			_, err := closed.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1)})
			return err
		},
		func() error { _, err := closed.CredentialDAO().CredentialValid(ctx, ThreadCredential{}); return err },
		func() error {
			return closed.ThreadDAO().AdvanceHead(ctx, queryID(1), model.ThreadPosition{CreatedAt: time.Now(), ID: queryID(2)})
		},
	}
	for index, check := range checks {
		if err := check(); !errors.Is(err, pgx.ErrTxClosed) || strings.Contains(err.Error(), "SELECT") {
			t.Fatalf("closed method %d cause lost or leaked: %v", index, err)
		}
	}
	var snapshot SnapshotScope
	if err := database.ReadSnapshot(ctx, func(tx SnapshotScope) error { snapshot = tx; return nil }); err != nil {
		t.Fatal(err)
	}
	for _, check := range []func() error{
		func() error {
			_, err := snapshot.TaskDAO().ThreadCandidates(ctx, queryID(1), nil, false, 2)
			return err
		},
		func() error {
			_, _, err := snapshot.TaskDAO().ThreadSides(ctx, queryID(1), model.ThreadPosition{}, model.ThreadPosition{})
			return err
		},
	} {
		if err := check(); !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("closed read cause lost: %v", err)
		}
	}
}

func TestThreadSourceReadsOnlyValidatedWorkerAttribution(t *testing.T) {
	database, principal, _, project := membershipFixture(t)
	ctx := context.Background()
	ordinary := queryTask(t, database, project.ID, 10, model.TaskTodo)
	reference := setSnapshotTaskClaim(t, database, project.ID, 11, principal.UserID, queryID(900))
	// Unrelated properties are not source attribution inputs. Reading a worker
	// must not parse them or make ordinary posting depend on their structure.
	putTaskPropertyFixture(t, database, reference.TaskID, "unrelated", []byte(`not valid JSON`))
	if err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		if _, err := tx.TaskDAO().LockTaskPresence(ctx, project.ID, reference.TaskID); err != nil {
			return err
		}
		source, err := tx.TaskDAO().SourceTask(ctx, project.ID, reference.TaskID)
		if err != nil {
			return err
		}
		worker := fixtureWorker(t, source.Properties)
		if source.Status != model.TaskInProgress || len(source.Properties) != 1 || worker == nil || worker.ClaimID != reference.ClaimID || worker.WorkerID != queryID(900) || worker.UserID != principal.UserID || worker.Agent != model.AgentClaude {
			t.Fatalf("validated worker source: %#v worker=%#v", source, worker)
		}
		if _, err := tx.TaskDAO().LockTaskPresence(ctx, project.ID, ordinary.ID); err != nil {
			return err
		}
		source, err = tx.TaskDAO().SourceTask(ctx, project.ID, ordinary.ID)
		if err != nil || source.Status != model.TaskTodo || len(source.Properties) != 0 {
			t.Fatalf("absent worker source: %#v %v", source, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	putTaskPropertyFixture(t, database, reference.TaskID, "worker", []byte(`{"claimId":"untrusted private attribution"}`))
	err := threadTestWrite(database, ctx, func(tx ThreadScope) error {
		if _, err := tx.TaskDAO().LockTaskPresence(ctx, project.ID, reference.TaskID); err != nil {
			return err
		}
		_, err := tx.TaskDAO().SourceTask(ctx, project.ID, reference.TaskID)
		return err
	})
	var transaction *ThreadTransactionError
	var failure *Error
	if !errors.As(err, &transaction) || transaction.CommitAttempted || !errors.As(err, &failure) || failure.Phase != "decode thread source" || strings.Contains(err.Error(), "untrusted") || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("malformed source was hidden or exposed: %v", err)
	}
	assertMigrationPoolReusable(t, database.Pool)
}
