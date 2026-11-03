package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskthreadjson"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type threadCancelAfterCheck struct {
	context.Context
	cancel context.CancelFunc
	once   sync.Once
}

func (ctx *threadCancelAfterCheck) Err() error {
	err := ctx.Context.Err()
	ctx.once.Do(ctx.cancel)
	return err
}

func TestThreadAdmissionObservesCancellationAfterInitialCheck(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Cancel immediately after observing the successful admission check. This
	// fixes the interleaving without relying on encoding time or a goroutine race.
	ctx := &threadCancelAfterCheck{Context: parent, cancel: cancel}
	message := core.ThreadMessage{
		ID: uuid.NewString(), CreatedAt: time.Now().UTC(), Body: strings.Repeat("<>&\u2028中文🌛", 1000),
		Author: core.ThreadAuthor{UserID: uuid.NewString()},
	}
	encoded, err := admitThreadMessage(ctx, message)
	if encoded != nil || !errors.Is(err, context.Canceled) || !errors.Is(parent.Err(), context.Canceled) {
		t.Fatalf("admission returned encoded bytes after cancellation: %d bytes, %v", len(encoded), err)
	}
}

func tracedThreads(t *testing.T, databaseURL string, action taskQueryAction) *TaskThreads {
	t.Helper()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = action
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return NewTaskThreads(&store.Store{Pool: pool})
}

func threadWait(t *testing.T, ctx context.Context, condition func() (bool, error)) {
	t.Helper()
	for {
		ok, err := condition()
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestThreadCredentialExpiresWhileWaitingForHead(t *testing.T) {
	for _, kind := range []core.CredentialKind{core.SessionCredential, core.PATCredential} {
		t.Run(string(kind), func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			threads := NewTaskThreads(database)
			task := createTask(t, tasks, principal, project.ID, "Expiry during head wait")
			postThread(t, threads, principal, task, CreateThreadMessage{Body: "before"})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			caller, table := principal, "sessions"
			if kind == core.PATCredential {
				credential := core.PersonalAccessToken{ID: uuid.NewString(), UserID: principal.UserID, TokenHash: secretHash(randomSecret("dnpat_")), Name: "Never expires", CreatedAt: time.Now().UTC()}
				if err := database.CreatePAT(ctx, principal, credential); err != nil {
					t.Fatal(err)
				}
				caller = core.Principal{Kind: core.PATCredential, CredentialID: credential.ID, UserID: principal.UserID}
				table = "personal_access_tokens"
				postThread(t, threads, caller, task, CreateThreadMessage{Body: "nullable PAT expiry is valid"})
			}
			before := threadStoredState(t, database, task.ID)
			blocker, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(context.Background())
			if _, err := blocker.Exec(ctx, `SELECT task_id FROM task_threads WHERE task_id=$1 FOR UPDATE`, task.ID); err != nil {
				t.Fatal(err)
			}
			var expiry time.Time
			if err := database.Pool.QueryRow(ctx, `UPDATE `+table+` SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1 RETURNING expires_at`, caller.CredentialID).Scan(&expiry); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				document, err := threads.Post(ctx, caller, project.ID, task.ID, CreateThreadMessage{Body: "must roll back after expiry"})
				if err == nil || document.JSON != nil {
					result <- fmt.Errorf("expired call returned a resource: %#v", document)
					return
				}
				result <- err
			}()
			threadWait(t, ctx, func() (bool, error) {
				var waiting bool
				err := database.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE '%SELECT last_created_at,last_message_id::text FROM task_threads%')`).Scan(&waiting)
				return waiting, err
			})
			threadWait(t, ctx, func() (bool, error) {
				var expired bool
				err := database.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expiry).Scan(&expired)
				return expired, err
			})
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				requireThreadFault(t, err, "unauthenticated")
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if after := threadStoredState(t, database, task.ID); before != after {
				t.Fatal("expiry rejection committed a message or changed head")
			}
			// The observation uses SQL and a separate valid principal, rather than
			// mistaking an expired caller's read refusal for an empty database.
			valid := workerMember(t, database, project.ID)
			page := listThread(t, threads, valid, task, ThreadListRequest{})
			want := 1
			if kind == core.PATCredential {
				want = 2
			}
			if len(page.Page.Items) != want {
				t.Fatal("expiry rejection changed retained history")
			}
			_, err = threads.List(ctx, caller, project.ID, task.ID, ThreadListRequest{})
			requireThreadFault(t, err, "unauthenticated")
		})
	}
}

func TestThreadCancellationBeforeCommitRollsBackEveryWriteStage(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Cancellation")
	threads := NewTaskThreads(database)
	first := postThread(t, threads, principal, task, CreateThreadMessage{Body: "first"})
	before := threadStoredState(t, database, task.ID)
	for _, fragment := range []string{
		"SELECT deleted_at FROM tasks", "SELECT expires_at FROM sessions", "FOR SHARE OF m", "SELECT name FROM users",
		"INSERT INTO task_threads", "SELECT last_created_at,last_message_id", "FROM task_thread_messages WHERE task_id=$1 AND message_id=$2",
		"INSERT INTO task_thread_messages", "SELECT $1::timestamptz IS NULL", "UPDATE task_threads SET",
	} {
		for _, after := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/after=%t", fragment, after), func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				action := taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }}
				if after {
					action.end = cancel
				} else {
					action.start = cancel
				}
				traced := tracedThreads(t, databaseURL, action)
				document, err := traced.Post(ctx, principal, project.ID, task.ID, CreateThreadMessage{Body: "rejected", ReplyTo: &first.Message.ID})
				if err == nil || !errors.Is(err, context.Canceled) || document.JSON != nil {
					t.Fatalf("cancellation lost or returned resource: %#v %v", document, err)
				}
				var stage *store.ThreadTransactionError
				if errors.As(err, &stage) && (stage.CommitAttempted || stage.OutcomeUnknown) {
					t.Fatalf("precommit cancellation classified as attempted commit: %#v", stage)
				}
				if afterState := threadStoredState(t, database, task.ID); before != afterState {
					t.Fatal("canceled operation changed head/messages")
				}
			})
		}
	}
	assertTaskUnchanged(t, tasks, principal, task)
}

func TestThreadReadCancellationAndServiceDeadlineAreBounded(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Read cancellation")
	threads := NewTaskThreads(database)
	first := postThread(t, threads, principal, task, CreateThreadMessage{Body: "first"})
	for _, fragment := range []string{"SELECT expires_at FROM sessions", "FROM project_members", "SELECT deleted_at FROM tasks", "FROM task_thread_messages WHERE task_id=$1 AND message_id=$2", "ORDER BY created_at", "EXISTS(SELECT 1 FROM task_thread_messages"} {
		t.Run(fragment, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			traced := tracedThreads(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }, end: cancel})
			document, err := traced.List(ctx, principal, project.ID, task.ID, ThreadListRequest{BeforeID: &first.Message.ID})
			// Page sides require a nonempty page, so use the tail when testing it.
			if strings.Contains(fragment, "EXISTS(") {
				ctx2, cancel2 := context.WithCancel(context.Background())
				defer cancel2()
				traced = tracedThreads(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }, end: cancel2})
				document, err = traced.List(ctx2, principal, project.ID, task.ID, ThreadListRequest{})
			}
			if err == nil || !errors.Is(err, context.Canceled) || document.JSON != nil {
				t.Fatalf("read cancellation lost: %#v %v", document, err)
			}
		})
	}
	if threadOperationTimeout != 10*time.Second {
		t.Fatal("service default changed")
	}
	for _, post := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		blocker, err := database.Pool.Begin(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		// A relation lock blocks both reads and writes after pool acquisition.
		if _, err := blocker.Exec(context.Background(), `LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE`); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		if post {
			_, err = threads.Post(ctx, principal, project.ID, task.ID, CreateThreadMessage{Body: "short parent"})
		} else {
			_, err = threads.List(ctx, principal, project.ID, task.ID, ThreadListRequest{})
		}
		cancel()
		if err == nil || !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
			t.Fatalf("parent deadline ignored: %v", err)
		}
		if err := blocker.Rollback(context.Background()); err != nil {
			t.Fatal(err)
		}
		listThread(t, threads, principal, task, ThreadListRequest{})
	}
}

func TestThreadReadDatabaseFailureAndOversizeInvariantAreVisible(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	threads := NewTaskThreads(database)
	task := createTask(t, tasks, principal, project.ID, "Stored invariant")
	oversize := core.ThreadMessage{ID: uuid.NewString(), Body: strings.Repeat("x", taskthreadjson.PageLimit+1)}
	_, err := selectThreadPage(context.Background(), []core.ThreadMessage{oversize}, 1, false, false)
	if err == nil {
		t.Fatal("oversize stored message silently skipped")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := admitThreadMessage(ctx, core.ThreadMessage{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("admission cancellation lost: %v", err)
	}
	if _, err := selectThreadPage(ctx, []core.ThreadMessage{{ID: "id"}}, 1, false, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("selection cancellation lost: %v", err)
	}
	if _, err := database.Pool.Exec(context.Background(), `DROP TABLE task_thread_messages`); err != nil {
		t.Fatal(err)
	}
	_, err = threads.List(context.Background(), principal, project.ID, task.ID, ThreadListRequest{})
	assertOperational(t, err)
	_, err = threads.Post(context.Background(), principal, project.ID, task.ID, CreateThreadMessage{Body: "no table"})
	assertOperational(t, err)
	database.Close()
	_, err = threads.Post(context.Background(), principal, project.ID, task.ID, CreateThreadMessage{Body: "closed pool"})
	assertOperational(t, err)
	_, err = threads.List(context.Background(), principal, project.ID, task.ID, ThreadListRequest{})
	assertOperational(t, err)
}

func TestThreadPreCommitFailureExposesOnlyAvailableCandidateAttribution(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	threads := NewTaskThreads(database)
	task := createTask(t, tasks, principal, project.ID, "Rejected candidate")
	if _, err := database.Pool.Exec(context.Background(), `CREATE FUNCTION refuse_thread_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private head diagnostic'; END $$; CREATE TRIGGER refuse_thread_head BEFORE UPDATE ON task_threads FOR EACH ROW EXECUTE FUNCTION refuse_thread_head()`); err != nil {
		t.Fatal(err)
	}
	document, err := threads.Post(context.Background(), principal, project.ID, task.ID, CreateThreadMessage{Body: "private body"})
	var attribution *ThreadMessageError
	if err == nil || document.JSON != nil || !errors.As(err, &attribution) || attribution.MessageID == "" || attribution.Execution != nil || strings.Contains(err.Error(), "private") {
		t.Fatalf("failed attribution: %#v %v", attribution, err)
	}
	if _, parseErr := uuid.Parse(attribution.MessageID); parseErr != nil {
		t.Fatal(parseErr)
	}
	var count int
	if err := database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM task_thread_messages WHERE task_id=$1`, task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed head left message: %d %v", count, err)
	}
	var pgErr interface{ SQLState() string }
	if !errors.As(err, &pgErr) || pgErr.SQLState() != "P0001" {
		t.Fatal("failure lost database error chain")
	}
}

func TestThreadReadSnapshotKeepsAuthorizationMessagesAndSidesConsistent(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	other := workerMember(t, database, project.ID)
	threads := NewTaskThreads(database)
	task := createTask(t, tasks, principal, project.ID, "Snapshot consistency")
	first := postThread(t, threads, principal, task, CreateThreadMessage{Body: "in the authorized snapshot"})
	interleaved := false
	traced := tracedThreads(t, databaseURL, taskQueryAction{
		match: func(sql string) bool { return strings.Contains(sql, "SELECT deleted_at FROM tasks") },
		end: func() {
			if interleaved {
				return
			}
			interleaved = true
			postThread(t, threads, principal, task, CreateThreadMessage{Body: "committed after the snapshot"})
			if err := tasks.Delete(context.Background(), principal, project.ID, task.ID, DeleteTask{Version: task.Version}); err != nil {
				t.Fatal(err)
			}
			if _, err := database.Pool.Exec(context.Background(), `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID); err != nil {
				t.Fatal(err)
			}
		},
	})
	page, err := traced.List(context.Background(), principal, project.ID, task.ID, ThreadListRequest{})
	if err != nil || !interleaved || len(page.Page.Items) != 1 || page.Page.Items[0].ID != first.Message.ID || page.Page.HasMoreBefore || page.Page.HasMoreAfter {
		t.Fatalf("read mixed authorization/data/side snapshots: %#v %v", page.Page, err)
	}
	_, err = threads.List(context.Background(), principal, project.ID, task.ID, ThreadListRequest{})
	requireThreadFault(t, err, "forbidden")
	_, err = threads.List(context.Background(), other, project.ID, task.ID, ThreadListRequest{})
	requireThreadFault(t, err, "task_deleted")
}
