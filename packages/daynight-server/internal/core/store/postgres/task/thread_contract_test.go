package task_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	projectdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	taskpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func writerThreadWrite(t *testing.T, database *postgres.Store, ctx context.Context, operation func(pgx.Tx, *taskpg.ThreadAccess) error) error {
	t.Helper()
	return writerTransactionContext(t, database, ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(tx pgx.Tx) error {
		return operation(tx, taskpg.NewThreadDAO(tx))
	})
}

func writerThreadRead(t *testing.T, database *postgres.Store, ctx context.Context, operation func(pgx.Tx, store.TaskReader) error) error {
	t.Helper()
	return writerTransactionContext(t, database, ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		return operation(tx, taskpg.NewReader(tx))
	})
}

func writerAppendThread(t *testing.T, database *postgres.Store, taskID, userID, body string) model.ThreadMessage {
	t.Helper()
	var message model.ThreadMessage
	if err := writerThreadWrite(t, database, t.Context(), func(_ pgx.Tx, dao *taskpg.ThreadAccess) error {
		head, err := dao.LockHead(t.Context(), taskID)
		if err != nil {
			return err
		}
		message, err = dao.InsertMessage(t.Context(), model.ThreadMessage{TaskID: taskID, Author: model.ThreadAuthor{UserID: userID}, Body: body})
		if err != nil {
			return err
		}
		if err := dao.PrepareTimestamp(t.Context(), &message, head); err != nil {
			return err
		}
		return dao.AdvanceHead(t.Context(), taskID, message.Position())
	}); err != nil {
		t.Fatal(err)
	}
	return message
}

func TestThreadTimestampWaitRetainsSingleDatabaseGeneratedUUID(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	testutil.MustExec(t, database.Pool, `CREATE SEQUENCE thread_uuid_calls;
 CREATE FUNCTION thread_test_uuid() RETURNS uuid LANGUAGE SQL VOLATILE AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid FROM nextval('thread_uuid_calls') $$;
 ALTER TABLE task_thread_messages ALTER COLUMN message_id SET DEFAULT thread_test_uuid()`)
	var message model.ThreadMessage
	if err := writerThreadWrite(t, database, ctx, func(rawTx pgx.Tx, tx *taskpg.ThreadAccess) error {
		if _, err := tx.LockHead(ctx, testutil.QueryID(1)); err != nil {
			return err
		}
		var stamp time.Time
		if err := rawTx.QueryRow(ctx, `SELECT date_trunc('milliseconds',clock_timestamp())+interval '30 milliseconds'`).Scan(&stamp); err != nil {
			return err
		}
		head := &model.ThreadPosition{CreatedAt: stamp.UTC(), ID: "ffffffff-ffff-4fff-8fff-ffffffffffff"}
		if err := tx.AdvanceHead(ctx, testutil.QueryID(1), *head); err != nil {
			return err
		}
		var err error
		message, err = tx.InsertMessage(ctx, model.ThreadMessage{TaskID: testutil.QueryID(1), Author: model.ThreadAuthor{UserID: testutil.QueryID(9)}, Body: "one UUID"})
		if err != nil {
			return err
		}
		id := message.ID
		if err := tx.PrepareTimestamp(ctx, &message, head); err != nil {
			return err
		}
		if message.ID != id || !message.CreatedAt.After(head.CreatedAt) {
			t.Fatalf("UUID regenerated or timestamp fabricated: %#v head=%#v", message, head)
		}
		return tx.AdvanceHead(ctx, testutil.QueryID(1), message.Position())
	}); err != nil {
		t.Fatal(err)
	}
	var calls int
	if err := database.Pool.QueryRow(ctx, `SELECT last_value FROM thread_uuid_calls`).Scan(&calls); err != nil || calls != 1 || message.ID != testutil.QueryID(1) {
		t.Fatalf("UUID generation count=%d id=%s %v", calls, message.ID, err)
	}
	if err := writerThreadWrite(t, database, ctx, func(rawTx pgx.Tx, tx *taskpg.ThreadAccess) error {
		return tx.AdvanceHead(ctx, testutil.QueryID(1), message.Position())
	}); err == nil {
		t.Fatal("head accepted non-forward update")
	}
}

func TestThreadFirstHeadConcurrencyPublishesStrictPositions(t *testing.T) {
	database := writerStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const total = 24
	messages := make(chan model.ThreadMessage, total)
	failures := make(chan error, total)
	var group sync.WaitGroup
	for index := range total {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			var message model.ThreadMessage
			err := writerThreadWrite(t, database, ctx, func(rawTx pgx.Tx, tx *taskpg.ThreadAccess) error {
				head, err := tx.LockHead(ctx, testutil.QueryID(1))
				if err != nil {
					return err
				}
				message, err = tx.InsertMessage(ctx, model.ThreadMessage{TaskID: testutil.QueryID(1), Author: model.ThreadAuthor{UserID: testutil.QueryID(9)}, Body: fmt.Sprint(index)})
				if err != nil {
					return err
				}
				if err := tx.PrepareTimestamp(ctx, &message, head); err != nil {
					return err
				}
				return tx.AdvanceHead(ctx, testutil.QueryID(1), message.Position())
			})
			if err != nil {
				failures <- err
				return
			}
			messages <- message
		}(index)
	}
	group.Wait()
	close(failures)
	close(messages)
	for err := range failures {
		t.Fatal(err)
	}
	items := make([]model.ThreadMessage, 0, total)
	for message := range messages {
		items = append(items, message)
	}
	if len(items) != total {
		t.Fatalf("concurrent first appends: %d", len(items))
	}
	slices.SortFunc(items, func(a, b model.ThreadMessage) int {
		if testutil.ThreadPositionAfter(a.Position(), b.Position()) {
			return 1
		}
		return -1
	})
	for index := 1; index < len(items); index++ {
		if !testutil.ThreadPositionAfter(items[index].Position(), items[index-1].Position()) {
			t.Fatal("concurrent positions are not strictly ordered")
		}
	}
	if err := writerThreadWrite(t, database, ctx, func(rawTx pgx.Tx, tx *taskpg.ThreadAccess) error {
		head, err := tx.LockHead(ctx, testutil.QueryID(1))
		if err != nil || head == nil || *head != items[len(items)-1].Position() {
			t.Fatalf("committed head: %#v %v", head, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestThreadSamplesDatabaseClockAfterHeadLockWait(t *testing.T) {
	database := writerStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	testutil.MustExec(t, database.Pool, `INSERT INTO task_threads(task_id) VALUES($1)`, testutil.QueryID(1))
	locker, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Rollback(context.Background())
	if _, err := locker.Exec(ctx, `SELECT task_id FROM task_threads WHERE task_id=$1 FOR UPDATE`, testutil.QueryID(1)); err != nil {
		t.Fatal(err)
	}
	started := make(chan uint32, 1)
	completed := make(chan error, 1)
	var message model.ThreadMessage
	go func() {
		completed <- writerThreadWrite(t, database, ctx, func(rawTx pgx.Tx, tx *taskpg.ThreadAccess) error {
			started <- rawTx.Conn().PgConn().PID()
			head, err := tx.LockHead(ctx, testutil.QueryID(1))
			if err != nil {
				return err
			}
			message, err = tx.InsertMessage(ctx, model.ThreadMessage{TaskID: testutil.QueryID(1), Author: model.ThreadAuthor{UserID: testutil.QueryID(9)}, Body: "after lock"})
			if err != nil {
				return err
			}
			if err := tx.PrepareTimestamp(ctx, &message, head); err != nil {
				return err
			}
			return tx.AdvanceHead(ctx, testutil.QueryID(1), message.Position())
		})
	}()
	testutil.WaitThreadBackendLock(t, database.Pool, <-started)
	var released time.Time
	if err := locker.QueryRow(ctx, `SELECT date_trunc('milliseconds',clock_timestamp())`).Scan(&released); err != nil {
		t.Fatal(err)
	}
	if err := locker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-completed; err != nil || message.CreatedAt.Before(released) {
		t.Fatalf("pre-lock clock used: message=%s released=%s %v", message.CreatedAt, released, err)
	}
}

func TestThreadRoundTripAuthorizationAndTaskInvariants(t *testing.T) {
	database := writerStore(t)
	principal, _, project := testutil.ProjectMembershipFixture(t, database)
	ctx := context.Background()
	task := writerTask(t, database, project.ID, 10, model.TaskDone)
	before := testutil.SnapshotTask(t, database, project.ID, task.ID)
	var epoch string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	var first, reply model.ThreadMessage
	if err := writerThreadWrite(t, database, ctx, func(rawTx pgx.Tx, tx *taskpg.ThreadAccess) error {
		presence, err := tx.LockTaskPresence(ctx, project.ID, task.ID)
		if err != nil || !presence.Found || presence.DeletedAt != nil {
			t.Fatalf("presence: %#v %v", presence, err)
		}
		credential, err := tx.Credential(ctx, principal)
		if err != nil {
			return err
		}
		access, err := projectdao.NewThreadDAO(rawTx).LockProjectAuthorization(ctx, principal, project.ID)
		if err != nil || access.ProjectID != project.ID || access.UserID != principal.UserID || access.Role != model.ProjectAdmin ||
			access.DirectGrant == nil || access.DirectGrant.ProjectID != project.ID || access.DirectGrant.UserID != principal.UserID ||
			access.DirectGrant.Role != access.Role || access.DirectGrant.Version <= 0 {
			t.Fatalf("locked authorization: %#v %v", access, err)
		}
		name, err := tx.AuthorName(ctx, principal.UserID)
		if err != nil || name != nil {
			t.Fatalf("nullable author: %#v %v", name, err)
		}
		source, err := tx.SourceTask(ctx, project.ID, task.ID)
		if err != nil || source.Status != model.TaskDone || len(source.Properties) != 0 {
			t.Fatalf("minimal source: %#v %v", source, err)
		}
		head, err := tx.LockHead(ctx, task.ID)
		if err != nil || head != nil {
			t.Fatalf("empty head: %#v %v", head, err)
		}
		first, err = tx.InsertMessage(ctx, model.ThreadMessage{TaskID: task.ID, Author: model.ThreadAuthor{UserID: principal.UserID}, Body: "  immutable\n<>& 中文 😀\t  "})
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
	name := "Alice"
	testutil.MustExec(t, database.Pool, `UPDATE users SET name=$2 WHERE id=$1`, principal.UserID, name)
	if err := writerThreadWrite(t, database, ctx, func(rawTx pgx.Tx, tx *taskpg.ThreadAccess) error {
		head, err := tx.LockHead(ctx, task.ID)
		if err != nil || head == nil || *head != first.Position() {
			t.Fatalf("existing head: %#v %v", head, err)
		}
		if _, err := tx.ThreadMessage(ctx, task.ID, first.ID); err != nil {
			return err
		}
		named, err := tx.AuthorName(ctx, principal.UserID)
		if err != nil || named == nil || *named != name {
			t.Fatalf("current author name: %#v %v", named, err)
		}
		reply, err = tx.InsertMessage(ctx, model.ThreadMessage{TaskID: task.ID, Author: model.ThreadAuthor{UserID: principal.UserID, DisplayName: named, Agent: true,
			Execution: &model.ThreadExecution{ClaimID: testutil.QueryID(900), WorkerID: testutil.QueryID(901), Provider: "codex"}}, Body: "reply", ReplyTo: &first.ID})
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
	testutil.MustExec(t, database.Pool, `UPDATE users SET name=$2 WHERE id=$1`, principal.UserID, strings.Repeat("later-name", 10000))
	if err := writerThreadRead(t, database, ctx, func(rawTx pgx.Tx, snapshot store.TaskReader) error {
		if _, err := pg.ThreadCredential(ctx, rawTx, principal, ""); err != nil {
			return err
		}
		presence, err := snapshot.TaskPresence(ctx, project.ID, task.ID)
		if err != nil || !presence.Found {
			t.Fatalf("snapshot presence: %#v %v", presence, err)
		}
		missing, err := snapshot.TaskPresence(ctx, project.ID, testutil.QueryID(999))
		if err != nil || missing.Found {
			t.Fatalf("missing presence: %#v %v", missing, err)
		}
		read, err := snapshot.ThreadMessage(ctx, task.ID, first.ID)
		if err != nil || !reflect.DeepEqual(read, first) || read.Author.DisplayName != nil {
			t.Fatalf("immutable original: %#v %v", read, err)
		}
		read, err = snapshot.ThreadMessage(ctx, task.ID, reply.ID)
		if err != nil || !reflect.DeepEqual(read, reply) || read.Author.DisplayName == nil || *read.Author.DisplayName != name {
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
	if after := testutil.SnapshotTask(t, database, project.ID, task.ID); !reflect.DeepEqual(before, after) {
		t.Fatalf("Thread changed Task: before=%#v after=%#v", before, after)
	}
	var afterEpoch string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&afterEpoch); err != nil || afterEpoch != epoch {
		t.Fatalf("Thread changed cache epoch: %s %s %v", epoch, afterEpoch, err)
	}
}

func TestThreadCredentialKindsAndExpiry(t *testing.T) {
	database := writerStore(t)
	_, principal, session := testutil.AuthRecords(t, database)
	ctx := context.Background()
	pat := model.PersonalAccessToken{ID: testutil.QueryID(1), TokenHash: []byte(strings.Repeat("x", 32)), Name: "thread PAT", CreatedAt: time.Now().UTC()}
	pat.UserID = principal.UserID
	if _, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, pat) }); err != nil {
		t.Fatal(err)
	}
	patPrincipal := model.Principal{Kind: model.PATCredential, UserID: principal.UserID, CredentialID: pat.ID}
	if err := writerThreadWrite(t, database, ctx, func(rawTx pgx.Tx, tx *taskpg.ThreadAccess) error {
		credential, err := tx.Credential(ctx, patPrincipal)
		if err != nil || credential.ExpiresAt != nil {
			t.Fatalf("non-expiring PAT: %#v %v", credential, err)
		}
		valid, err := tx.CredentialValid(ctx, credential)
		if err != nil || !valid {
			t.Fatalf("PAT final admission: %v %v", valid, err)
		}
		expired := time.Now().Add(-time.Hour)
		valid, err = tx.CredentialValid(ctx, store.ThreadCredential{ExpiresAt: &expired})
		if err != nil || valid {
			t.Fatalf("expired final admission: %v %v", valid, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, database.Pool, `UPDATE sessions SET expires_at=$2 WHERE id=$1`, session.ID, session.CreatedAt.Add(time.Microsecond))
	for _, principal := range []model.Principal{principal, {Kind: "invalid", UserID: principal.UserID, CredentialID: principal.CredentialID}, {Kind: model.PATCredential, UserID: testutil.QueryID(999), CredentialID: pat.ID}} {
		err := writerThreadRead(t, database, ctx, func(rawTx pgx.Tx, snapshot store.TaskReader) error {
			_, err := pg.ThreadCredential(ctx, rawTx, principal, "")
			return err
		})
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("invalid credential accepted: %#v %v", principal, err)
		}
	}
}

func TestThreadSourceReadsOnlyWorkerAttribution(t *testing.T) {
	database := writerStore(t)
	principal, _, project := testutil.ProjectMembershipFixture(t, database)
	ctx := context.Background()
	ordinary := writerTask(t, database, project.ID, 10, model.TaskTodo)
	reference := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 11, principal.UserID, testutil.QueryID(900))
	testutil.PutTaskProperty(t, database.Pool, reference.TaskID, "paused", []byte(`false`))
	if err := writerThreadWrite(t, database, ctx, func(rawTx pgx.Tx, tx *taskpg.ThreadAccess) error {
		if _, err := tx.LockTaskPresence(ctx, project.ID, reference.TaskID); err != nil {
			return err
		}
		source, err := tx.SourceTask(ctx, project.ID, reference.TaskID)
		if err != nil {
			return err
		}
		worker := testutil.Worker(t, source.Properties)
		if source.Status != model.TaskInProgress || len(source.Properties) != 1 || worker == nil || worker.ClaimID != reference.ClaimID || worker.WorkerID != testutil.QueryID(900) || worker.UserID != principal.UserID || worker.Agent != model.AgentClaude {
			t.Fatalf("worker source: %#v worker=%#v", source, worker)
		}
		if _, err := tx.LockTaskPresence(ctx, project.ID, ordinary.ID); err != nil {
			return err
		}
		source, err = tx.SourceTask(ctx, project.ID, ordinary.ID)
		if err != nil || source.Status != model.TaskTodo || len(source.Properties) != 0 {
			t.Fatalf("absent worker source: %#v %v", source, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestThreadIDPaginationTraversesSameMillisecondInBothDirections(t *testing.T) {
	database := writerStore(t)
	principal, _, project := testutil.ProjectMembershipFixture(t, database)
	task := writerTask(t, database, project.ID, 10, model.TaskTodo)
	other := writerTask(t, database, project.ID, 11, model.TaskTodo)
	createdAt := time.Date(2026, 11, 3, 0, 0, 0, 123000000, time.UTC)
	want := make([]string, 137)
	for index := range want {
		want[index] = fmt.Sprintf("00000000-0000-4000-8000-%012x", index+1)
	}
	testutil.MustExec(t, database.Pool, `INSERT INTO task_thread_messages(task_id,message_id,created_at,author_user_id,author_agent,body)
 SELECT $1,id,$2,$3,false,'same millisecond' FROM unnest($4::uuid[]) AS id`, task.ID, createdAt, principal.UserID, want)
	testutil.MustExec(t, database.Pool, `INSERT INTO task_thread_messages(task_id,message_id,created_at,author_user_id,author_agent,body)
 VALUES($1,$2,$3,$4,false,'other body')`, other.ID, want[0], createdAt.Add(time.Second), principal.UserID)
	if err := writerThreadRead(t, database, t.Context(), func(rawTx pgx.Tx, scope store.TaskReader) error {
		for _, reverse := range []bool{false, true} {
			var ids []string
			var anchor *model.ThreadPosition
			for {
				messages, err := scope.ThreadCandidates(t.Context(), task.ID, anchor, reverse, 17)
				if err != nil {
					return err
				}
				if len(messages) == 0 {
					break
				}
				if reverse {
					slices.Reverse(messages)
				}
				batch := make([]string, len(messages))
				for index, message := range messages {
					batch[index] = message.ID
					if message.Body != "same millisecond" || !message.CreatedAt.Equal(createdAt) {
						t.Fatalf("stored body/time changed: %#v", message)
					}
				}
				if reverse {
					ids = append(batch, ids...)
					position := messages[0].Position()
					anchor = &position
				} else {
					ids = append(ids, batch...)
					position := messages[len(messages)-1].Position()
					anchor = &position
				}
			}
			if !slices.Equal(ids, want) {
				t.Fatalf("reverse=%t lost or duplicated scoped IDs: %v", reverse, ids)
			}
		}
		message, err := scope.ThreadMessage(t.Context(), other.ID, want[0])
		if err != nil || message.Body != "other body" {
			t.Fatalf("same UUID in other Task crossed scope: %#v %v", message, err)
		}
		before, after, err := scope.ThreadSides(t.Context(), task.ID, model.ThreadPosition{ID: want[87], CreatedAt: createdAt}, model.ThreadPosition{ID: want[136], CreatedAt: createdAt})
		if err != nil || !before || after {
			t.Fatalf("tail sides: %v %v %v", before, after, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestThreadDAOReadDatabaseFailuresRemainVisible(t *testing.T) {
	database := writerStore(t)
	principal, _, project := testutil.ProjectMembershipFixture(t, database)
	row := writerTask(t, database, project.ID, 10, model.TaskTodo)
	testutil.MustExec(t, database.Pool, `DROP TABLE task_thread_messages`)
	for _, post := range []bool{false, true} {
		var err error
		if post {
			err = writerThreadWrite(t, database, t.Context(), func(_ pgx.Tx, dao *taskpg.ThreadAccess) error {
				if _, err := dao.LockHead(t.Context(), row.ID); err != nil {
					return err
				}
				_, err := dao.InsertMessage(t.Context(), model.ThreadMessage{TaskID: row.ID, Author: model.ThreadAuthor{UserID: principal.UserID}, Body: "no table"})
				return err
			})
		} else {
			err = writerThreadRead(t, database, t.Context(), func(_ pgx.Tx, reader store.TaskReader) error {
				_, err := reader.ThreadCandidates(t.Context(), row.ID, nil, false, 50)
				return err
			})
		}
		var driver *pgconn.PgError
		if !errors.As(err, &driver) || driver.Code != "42P01" || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing-table SQL error hidden: post=%t error=%v", post, err)
		}
	}
}
