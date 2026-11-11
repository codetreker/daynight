package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type threadWitnessQueryAction struct {
	fragment string
	before   func()
	after    func()
}

type threadWitnessQueryKey struct{}

func (action threadWitnessQueryAction) TraceQueryStart(ctx context.Context, _ *pgx.Conn, query pgx.TraceQueryStartData) context.Context {
	matched := strings.Contains(query.SQL, action.fragment)
	if matched && action.before != nil {
		action.before()
	}
	return context.WithValue(ctx, threadWitnessQueryKey{}, matched)
}

func (action threadWitnessQueryAction) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if matched, _ := ctx.Value(threadWitnessQueryKey{}).(bool); matched && action.after != nil {
		action.after()
	}
}

func threadWitnessTracedStore(t *testing.T, database *Store, action threadWitnessQueryAction) *Store {
	t.Helper()
	config := database.Pool.Config().Copy()
	config.ConnConfig.Tracer = action
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &Store{Pool: pool}
}

func threadWitnessState(t *testing.T, database *Store, taskID string) string {
	t.Helper()
	var state string
	err := database.Pool.QueryRow(t.Context(), `SELECT jsonb_build_array(
 (SELECT to_jsonb(h) FROM task_threads h WHERE h.task_id=$1),
 (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.created_at,m.message_id),'[]'::jsonb) FROM task_thread_messages m WHERE m.task_id=$1))::text`, taskID).Scan(&state)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func threadWitnessAppend(ctx context.Context, database *Store, principal model.Principal, projectID, taskID, body string, replyTo *string) (model.ThreadMessage, store.Completion, error) {
	var message model.ThreadMessage
	completion, err := database.WriteThread(ctx, func(scope store.ThreadScope) error {
		presence, err := scope.TaskDAO().LockTaskPresence(ctx, projectID, taskID)
		if err != nil {
			return err
		}
		if !presence.Found || presence.DeletedAt != nil {
			return model.ErrNotFound
		}
		credential, err := scope.CredentialDAO().Credential(ctx, principal)
		if err != nil {
			return err
		}
		if _, err := scope.ProjectDAO().LockProjectAuthorization(ctx, principal, projectID); err != nil {
			return err
		}
		name, err := scope.CredentialDAO().AuthorName(ctx, principal.UserID)
		if err != nil {
			return err
		}
		head, err := scope.ThreadDAO().LockHead(ctx, taskID)
		if err != nil {
			return err
		}
		if replyTo != nil {
			if _, err := scope.ThreadDAO().ThreadMessage(ctx, taskID, *replyTo); err != nil {
				return err
			}
		}
		message, err = scope.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: taskID, Author: model.ThreadAuthor{UserID: principal.UserID, DisplayName: name}, Body: body, ReplyTo: replyTo})
		if err != nil {
			return err
		}
		if err := scope.ThreadDAO().PrepareTimestamp(ctx, &message, head); err != nil {
			return err
		}
		valid, err := scope.CredentialDAO().CredentialValid(ctx, credential)
		if err != nil {
			return err
		}
		if !valid {
			return model.ErrNotFound
		}
		return scope.ThreadDAO().AdvanceHead(ctx, taskID, message.Position())
	})
	return message, completion, err
}

func TestThreadCredentialExpiresWhileWaitingForHead(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential} {
		t.Run(string(kind), func(t *testing.T) {
			database, principal, _, project := membershipFixture(t)
			task := queryTask(t, database, project.ID, 10, model.TaskTodo)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			first, _, err := threadWitnessAppend(ctx, database, principal, project.ID, task.ID, "before", nil)
			if err != nil {
				t.Fatal(err)
			}
			caller, table := principal, "sessions"
			want := 1
			if kind == model.PATCredential {
				credential := model.PersonalAccessToken{ID: uuid.NewString(), UserID: principal.UserID, TokenHash: []byte(strings.Repeat("x", 32)), Name: "Never expires", CreatedAt: time.Now().UTC()}
				if _, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, credential) }); err != nil {
					t.Fatal(err)
				}
				caller = model.Principal{Kind: model.PATCredential, CredentialID: credential.ID, UserID: principal.UserID}
				table = "personal_access_tokens"
				if _, _, err := threadWitnessAppend(ctx, database, caller, project.ID, task.ID, "nullable PAT expiry is valid", &first.ID); err != nil {
					t.Fatal(err)
				}
				want = 2
			}
			before := threadWitnessState(t, database, task.ID)
			blocker, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var workerDone <-chan struct{}
			defer func() {
				cancel()
				cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				defer stop()
				if err := blocker.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
					t.Errorf("release thread head blocker: %v", err)
				}
				if workerDone != nil {
					select {
					case <-workerDone:
					case <-cleanup.Done():
						t.Errorf("thread writer did not drain after cancellation: %v", cleanup.Err())
					}
				}
			}()
			if _, err := blocker.Exec(ctx, `SELECT task_id FROM task_threads WHERE task_id=$1 FOR UPDATE`, task.ID); err != nil {
				t.Fatal(err)
			}
			var expiry time.Time
			if err := database.Pool.QueryRow(ctx, `UPDATE `+table+` SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1 RETURNING expires_at`, caller.CredentialID).Scan(&expiry); err != nil {
				t.Fatal(err)
			}
			started := make(chan uint32, 1)
			completed := make(chan error, 1)
			drained := make(chan struct{})
			workerDone = drained
			go func() {
				defer close(drained)
				_, err := database.WriteThread(ctx, func(scope store.ThreadScope) error {
					started <- scope.(*ThreadTx).tx.Conn().PgConn().PID()
					if _, err := scope.TaskDAO().LockTaskPresence(ctx, project.ID, task.ID); err != nil {
						return err
					}
					credential, err := scope.CredentialDAO().Credential(ctx, caller)
					if err != nil {
						return err
					}
					if _, err := scope.ProjectDAO().LockProjectAuthorization(ctx, caller, project.ID); err != nil {
						return err
					}
					head, err := scope.ThreadDAO().LockHead(ctx, task.ID)
					if err != nil {
						return err
					}
					message, err := scope.ThreadDAO().InsertMessage(ctx, model.ThreadMessage{TaskID: task.ID, Author: model.ThreadAuthor{UserID: caller.UserID}, Body: "must roll back after expiry"})
					if err != nil {
						return err
					}
					if err := scope.ThreadDAO().PrepareTimestamp(ctx, &message, head); err != nil {
						return err
					}
					valid, err := scope.CredentialDAO().CredentialValid(ctx, credential)
					if err != nil {
						return err
					}
					if valid {
						return errors.New("expired credential was valid after actual head wait")
					}
					return model.ErrNotFound
				})
				completed <- err
			}()
			var pid uint32
			select {
			case pid = <-started:
			case err := <-completed:
				t.Fatalf("thread write exited before entering its callback: %v", err)
			case <-ctx.Done():
				t.Fatalf("thread write did not enter its callback: %v", ctx.Err())
			}
			waitThreadBackendLock(t, database, pid)
			for {
				var expired bool
				if err := database.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expiry).Scan(&expired); err != nil {
					t.Fatal(err)
				}
				if expired {
					break
				}
				if err := waitThreadClock(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := receiveQueryResult(t, ctx, completed); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("expiry was not rejected: %v", err)
			}
			if after := threadWitnessState(t, database, task.ID); after != before {
				t.Fatal("expiry rejection changed retained head or messages")
			}
			if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
				messages, err := scope.TaskDAO().ThreadCandidates(ctx, task.ID, nil, false, 10)
				if err != nil || len(messages) != want {
					t.Fatalf("expiry rejection changed history: %#v %v", messages, err)
				}
				_, err = scope.CredentialDAO().Credential(ctx, caller)
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("expired snapshot credential accepted: %v", err)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestThreadCancellationBeforeCommitRollsBackEveryWriteStage(t *testing.T) {
	database, principal, _, project := membershipFixture(t)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	first, _, err := threadWitnessAppend(t.Context(), database, principal, project.ID, task.ID, "first", nil)
	if err != nil {
		t.Fatal(err)
	}
	before := threadWitnessState(t, database, task.ID)
	for _, fragment := range []string{
		"SELECT deleted_at FROM tasks", "SELECT expires_at FROM sessions", "FOR SHARE OF o", "SELECT name,personal_user_id::text FROM teams",
		"SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE", "FROM project_grants WHERE project_id=$1 AND user_id=$2 FOR SHARE", "SELECT name FROM users",
		"INSERT INTO task_threads", "SELECT last_created_at,last_message_id", "FROM task_thread_messages WHERE task_id=$1 AND message_id=$2",
		"INSERT INTO task_thread_messages", "SELECT $1::timestamptz IS NULL", "UPDATE task_threads SET",
	} {
		for _, after := range []bool{false, true} {
			if !t.Run(fmt.Sprintf("%s/after=%t", fragment, after), func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				fired := false
				fire := func() { fired = true; cancel() }
				action := threadWitnessQueryAction{fragment: fragment}
				if after {
					action.after = fire
				} else {
					action.before = fire
				}
				traced := threadWitnessTracedStore(t, database, action)
				_, completion, err := threadWitnessAppend(ctx, traced, principal, project.ID, task.ID, "rejected", &first.ID)
				var failure *store.ThreadTransactionError
				if !fired || !errors.Is(err, context.Canceled) || completion.Outcome == store.TransactionCommitted || !errors.As(err, &failure) || failure.CommitAttempted || failure.OutcomeUnknown {
					t.Fatalf("cancellation stage missing or misclassified: fired=%v completion=%#v failure=%#v error=%v", fired, completion, failure, err)
				}
				if after := threadWitnessState(t, database, task.ID); after != before {
					t.Fatal("canceled stage changed retained head or messages")
				}
				assertMigrationPoolReusable(t, traced.Pool)
			}) {
				t.FailNow()
			}
		}
	}
}

func TestThreadExactMessageBudgetsAndRollback(t *testing.T) {
	for _, agent := range []bool{false, true} {
		t.Run(fmt.Sprintf("agent=%t", agent), func(t *testing.T) {
			database, principal, _, project := membershipFixture(t)
			task := queryTask(t, database, project.ID, 10, model.TaskTodo)
			beforeTask := snapshotTask(t, database, project.ID, task.ID)
			reply := appendStoredThread(t, database, task.ID, principal.UserID, "reply target")
			author := model.ThreadAuthor{UserID: principal.UserID, Agent: agent}
			if agent {
				author.Execution = &model.ThreadExecution{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Provider: "codex"}
			}
			prefix := " <>&\"\\\n\t中文🌛\u2028\u2029 "
			template := model.ThreadMessage{ID: uuid.NewString(), TaskID: task.ID, Author: author, Body: prefix, ReplyTo: &reply.ID, CreatedAt: time.Now().UTC().Truncate(time.Millisecond)}
			base, err := taskcodec.EncodeMessage(template, true)
			if err != nil {
				t.Fatal(err)
			}
			body := prefix + strings.Repeat("x", taskcodec.MessageLimit-len(base))
			var first model.ThreadMessage
			write := func(candidate model.ThreadMessage, refusal error) error {
				return threadTestWrite(database, t.Context(), func(scope store.ThreadScope) error {
					head, err := scope.ThreadDAO().LockHead(t.Context(), task.ID)
					if err != nil {
						return err
					}
					inserted, err := scope.ThreadDAO().InsertMessage(t.Context(), candidate)
					if err != nil {
						return err
					}
					if err := scope.ThreadDAO().PrepareTimestamp(t.Context(), &inserted, head); err != nil {
						return err
					}
					if refusal != nil {
						return refusal
					}
					first = inserted
					return scope.ThreadDAO().AdvanceHead(t.Context(), task.ID, inserted.Position())
				})
			}
			candidate := model.ThreadMessage{TaskID: task.ID, Author: author, Body: body, ReplyTo: &reply.ID}
			if err := write(candidate, nil); err != nil {
				t.Fatal(err)
			}
			encoded, err := taskcodec.EncodeMessage(first, true)
			if err != nil || len(encoded) != taskcodec.MessageLimit {
				t.Fatalf("physical boundary fixture changed: %d %v", len(encoded), err)
			}
			before := threadWitnessState(t, database, task.ID)
			rejected := errors.New("caller rejects candidate after insertion")
			candidate.Body += "x"
			if err := write(candidate, rejected); !errors.Is(err, rejected) {
				t.Fatalf("oversize candidate lost rollback cause: %v", err)
			}
			if after := threadWitnessState(t, database, task.ID); after != before {
				t.Fatal("candidate rejection changed retained messages or head")
			}
			name := strings.Repeat("<", 12000)
			mustQueryExec(t, database, `UPDATE users SET name=$2 WHERE id=$1`, principal.UserID, name)
			candidate.Author.DisplayName, candidate.Body, candidate.ReplyTo = &name, "short", nil
			if err := write(candidate, rejected); !errors.Is(err, rejected) {
				t.Fatalf("oversize author candidate lost rollback cause: %v", err)
			}
			if after := threadWitnessState(t, database, task.ID); after != before {
				t.Fatal("author rejection changed retained messages or head")
			}
			if err := database.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
				messages, err := scope.TaskDAO().ThreadCandidates(t.Context(), task.ID, nil, false, 10)
				if err != nil || len(messages) != 2 || messages[1].Body != body {
					t.Fatalf("later name invalidated prior stored bytes: %#v %v", messages, err)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if afterTask := snapshotTask(t, database, project.ID, task.ID); afterTask.Version != beforeTask.Version || !afterTask.UpdatedAt.Equal(beforeTask.UpdatedAt) {
				t.Fatal("Thread candidate rollback changed parent Task metadata")
			}
		})
	}
}

func threadWitnessRead(ctx context.Context, database *Store, principal model.Principal, projectID, taskID string, anchorID *string) error {
	return database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if _, err := scope.CredentialDAO().Credential(ctx, principal); err != nil {
			return err
		}
		if _, err := scope.ProjectDAO().ProjectAccess(ctx, principal, projectID); err != nil {
			return err
		}
		if _, err := scope.TaskDAO().TaskPresence(ctx, projectID, taskID); err != nil {
			return err
		}
		var anchor *model.ThreadPosition
		if anchorID != nil {
			message, err := scope.TaskDAO().ThreadMessage(ctx, taskID, *anchorID)
			if err != nil {
				return err
			}
			position := message.Position()
			anchor = &position
		}
		messages, err := scope.TaskDAO().ThreadCandidates(ctx, taskID, anchor, false, 50)
		if err != nil {
			return err
		}
		if len(messages) != 0 {
			_, _, err := scope.TaskDAO().ThreadSides(ctx, taskID, messages[0].Position(), messages[len(messages)-1].Position())
			return err
		}
		return nil
	})
}

func TestThreadReadCancellationAndParentDeadlineAreBounded(t *testing.T) {
	database, principal, _, project := membershipFixture(t)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	first := appendStoredThread(t, database, task.ID, principal.UserID, "first")
	appendStoredThread(t, database, task.ID, principal.UserID, "second")
	for _, fragment := range []string{"SELECT expires_at FROM sessions", "FROM project_grants", "SELECT effective_deleted_at FROM task_resource_rows", "FROM task_thread_messages WHERE task_id=$1 AND message_id=$2", "ORDER BY created_at", "EXISTS(SELECT 1 FROM task_thread_messages"} {
		t.Run(fragment, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			fired := false
			traced := threadWitnessTracedStore(t, database, threadWitnessQueryAction{fragment: fragment, after: func() { fired = true; cancel() }})
			err := threadWitnessRead(ctx, traced, principal, project.ID, task.ID, &first.ID)
			if !fired || !errors.Is(err, context.Canceled) {
				t.Fatalf("SQL read stage failed to observe cancellation: fired=%v error=%v", fired, err)
			}
			assertMigrationPoolReusable(t, traced.Pool)
		})
	}
	for _, post := range []bool{false, true} {
		t.Run(fmt.Sprintf("post=%t", post), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
			defer cancel()
			blocker, err := database.Pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(context.Background())
			if _, err := blocker.Exec(t.Context(), `LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE`); err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			if post {
				_, _, err = threadWitnessAppend(ctx, database, principal, project.ID, task.ID, "short parent", nil)
			} else {
				err = threadWitnessRead(ctx, database, principal, project.ID, task.ID, nil)
			}
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
				t.Fatalf("parent deadline ignored after relation lock: %v", err)
			}
			if err := blocker.Rollback(t.Context()); err != nil {
				t.Fatal(err)
			}
			if err := threadWitnessRead(t.Context(), database, principal, project.ID, task.ID, nil); err != nil {
				t.Fatalf("read did not recover after canceled SQL: %v", err)
			}
		})
	}
}

func TestThreadReadDatabaseFailuresRemainVisible(t *testing.T) {
	database, principal, _, project := membershipFixture(t)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	database.Close()
	for _, operation := range []func() error{
		func() error { return threadWitnessRead(t.Context(), database, principal, project.ID, task.ID, nil) },
		func() error {
			_, _, err := threadWitnessAppend(t.Context(), database, principal, project.ID, task.ID, "closed pool", nil)
			return err
		},
	} {
		var failure *store.Error
		if err := operation(); !errors.As(err, &failure) || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("closed pool lost operational failure: %v", err)
		}
	}
}

func TestThreadPreCommitSQLFailureRollsBackCandidate(t *testing.T) {
	database, principal, _, project := membershipFixture(t)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	before := threadWitnessState(t, database, task.ID)
	mustQueryExec(t, database, `CREATE FUNCTION refuse_thread_witness_head() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'private head diagnostic'; END $$;
 CREATE TRIGGER refuse_thread_witness_head BEFORE UPDATE ON task_threads FOR EACH ROW EXECUTE FUNCTION refuse_thread_witness_head()`)
	message, completion, err := threadWitnessAppend(t.Context(), database, principal, project.ID, task.ID, "private body", nil)
	var driver *pgconn.PgError
	var failure *store.ThreadTransactionError
	if !errors.As(err, &driver) || driver.Code != "P0001" || !errors.As(err, &failure) || failure.CommitAttempted || completion.Outcome == store.TransactionCommitted || message.ID == "" {
		t.Fatalf("precommit SQL failure lost candidate or cause: message=%#v completion=%#v error=%v", message, completion, err)
	}
	if after := threadWitnessState(t, database, task.ID); after != before {
		t.Fatal("failed head write retained candidate or lazy head")
	}
}
