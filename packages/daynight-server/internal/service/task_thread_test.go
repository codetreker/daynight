package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskthreadjson"
	"github.com/google/uuid"
)

func requireThreadFault(t *testing.T, err error, code string) *Fault {
	t.Helper()
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != code || fault.Message == "" {
		t.Fatalf("expected %s fault, got %#v", code, err)
	}
	return fault
}

func postThread(t *testing.T, threads *TaskThreads, principal core.Principal, task core.Task, input CreateThreadMessage) ThreadMessageDocument {
	t.Helper()
	result, err := threads.Post(context.Background(), principal, task.ProjectID, task.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	var resource api.ThreadMessage
	if err := json.Unmarshal(result.JSON, &resource); err != nil || resource.ID != result.Message.ID || resource.Body != input.Body {
		t.Fatalf("message document: %#v, %v", resource, err)
	}
	return result
}

func listThread(t *testing.T, threads *TaskThreads, principal core.Principal, task core.Task, input ThreadListRequest) ThreadPageDocument {
	t.Helper()
	result, err := threads.List(context.Background(), principal, task.ProjectID, task.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	var resource api.ThreadPage
	if err := json.Unmarshal(result.JSON, &resource); err != nil || len(resource.Items) != len(result.Page.Items) || len(result.JSON) > taskthreadjson.PageLimit {
		t.Fatalf("page document: %#v, %v", resource, err)
	}
	return result
}

func threadStoredState(t *testing.T, database *store.Store, taskID string) string {
	t.Helper()
	var result string
	if err := database.Pool.QueryRow(context.Background(), `SELECT json_build_object(
 'messages',(SELECT json_agg(row_to_json(m) ORDER BY created_at,message_id) FROM task_thread_messages m WHERE task_id=$1),
 'head',(SELECT row_to_json(h) FROM task_threads h WHERE task_id=$1))::text`, taskID).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestThreadPreservesTaskAndImmutableAuthorAcrossLifecycle(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	threads := NewTaskThreads(database)
	task := createTask(t, tasks, principal, project.ID, "Discussion without an executor")
	ctx := context.Background()
	var epoch string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	empty := listThread(t, threads, principal, task, ThreadListRequest{})
	if empty.Page.Items == nil || len(empty.Page.Items) != 0 || empty.Page.HasMoreBefore || empty.Page.HasMoreAfter {
		t.Fatalf("empty thread: %#v", empty.Page)
	}
	first := postThread(t, threads, principal, task, CreateThreadMessage{Body: "  <>&\"\\\n\t中文🌛\u2028\u2029  "})
	if first.Message.Author.DisplayName != nil || first.Message.Author.Agent || first.Message.CreatedAt.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("default attribution/precision: %#v", first.Message)
	}
	name := "Alice"
	if _, err := database.Pool.Exec(ctx, `UPDATE users SET name=$2 WHERE id=$1`, principal.UserID, name); err != nil {
		t.Fatal(err)
	}
	second := postThread(t, threads, principal, task, CreateThreadMessage{Body: "reply", ReplyTo: pointer(strings.ToUpper(first.Message.ID))})
	if second.Message.ReplyTo == nil || *second.Message.ReplyTo != first.Message.ID || second.Message.Author.DisplayName == nil || *second.Message.Author.DisplayName != name {
		t.Fatalf("reply attribution: %#v", second.Message)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE users SET name=$2 WHERE id=$1`, principal.UserID, strings.Repeat("later-name", 10000)); err != nil {
		t.Fatal(err)
	}
	page := listThread(t, threads, principal, task, ThreadListRequest{Details: true})
	if len(page.Page.Items) != 2 || !reflect.DeepEqual(page.Page.Items[0], first.Message) || !reflect.DeepEqual(page.Page.Items[1], second.Message) {
		t.Fatalf("history changed after rename: %#v", page.Page)
	}
	assertTaskUnchanged(t, tasks, principal, task)
	var afterEpoch string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&afterEpoch); err != nil || afterEpoch != epoch {
		t.Fatalf("thread changed cache epoch: %s %s, %v", epoch, afterEpoch, err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE users SET name=NULL WHERE id=$1`, principal.UserID); err != nil {
		t.Fatal(err)
	}
	task = finishTask(t, tasks, principal, task)
	postThread(t, threads, principal, task, CreateThreadMessage{Body: "Task completion retains the discussion"})
	assertTaskUnchanged(t, tasks, principal, task)
	if len(listThread(t, threads, principal, task, ThreadListRequest{}).Page.Items) != 3 {
		t.Fatal("completed task discussion is unavailable")
	}
}

func TestThreadInputAndScopedAuthorization(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	threads := NewTaskThreads(database)
	task := createTask(t, tasks, principal, project.ID, "Thread")
	other := createTask(t, tasks, principal, project.ID, "Other")
	foreign := postThread(t, threads, principal, other, CreateThreadMessage{Body: "foreign"})
	ctx := context.Background()
	for _, input := range []CreateThreadMessage{
		{}, {Body: " \n\t\u2003"}, {Body: "\xff"}, {Body: "a\x00b"},
		{Body: "body", ReplyTo: pointer("bad")}, {Body: "body", ClaimID: pointer("bad")},
	} {
		_, err := threads.Post(ctx, principal, project.ID, task.ID, input)
		requireThreadFault(t, err, "invalid_input")
	}
	_, err := threads.Post(ctx, principal, project.ID, task.ID, CreateThreadMessage{Body: strings.Repeat("x", taskthreadjson.MessageLimit+1)})
	requireThreadFault(t, err, "payload_too_large")
	for _, request := range []ThreadListRequest{
		{Count: -1}, {Count: 101}, {BeforeID: pointer("bad")}, {AfterID: pointer("bad")},
		{BeforeID: &foreign.Message.ID, AfterID: &foreign.Message.ID},
		{BeforeID: &foreign.Message.ID, FromBeginning: true}, {AfterID: &foreign.Message.ID, FromBeginning: true},
	} {
		_, err := threads.List(ctx, principal, project.ID, task.ID, request)
		requireThreadFault(t, err, "invalid_input")
	}
	_, err = threads.Post(ctx, principal, project.ID, task.ID, CreateThreadMessage{Body: "reply", ReplyTo: &foreign.Message.ID})
	requireThreadFault(t, err, "message_not_found")
	for _, request := range []ThreadListRequest{{BeforeID: &foreign.Message.ID}, {AfterID: &foreign.Message.ID}, {AfterID: pointer(uuid.NewString())}} {
		_, err := threads.List(ctx, principal, project.ID, task.ID, request)
		requireThreadFault(t, err, "message_not_found")
	}
	outsider := servicePrincipal(t, database)
	for _, call := range []func(core.Principal, string, string) error{
		func(p core.Principal, projectID, taskID string) error {
			_, err := threads.Post(ctx, p, projectID, taskID, CreateThreadMessage{Body: "body"})
			return err
		},
		func(p core.Principal, projectID, taskID string) error {
			_, err := threads.List(ctx, p, projectID, taskID, ThreadListRequest{})
			return err
		},
	} {
		requireThreadFault(t, call(core.Principal{}, project.ID, task.ID), "unauthenticated")
		requireThreadFault(t, call(principal, "bad", task.ID), "invalid_input")
		requireThreadFault(t, call(principal, project.ID, "bad"), "invalid_input")
		requireThreadFault(t, call(principal, project.ID, uuid.NewString()), "not_found")
		requireThreadFault(t, call(outsider, project.ID, task.ID), "forbidden")
		spoofed := principal
		spoofed.UserID = outsider.UserID
		requireThreadFault(t, call(spoofed, project.ID, task.ID), "unauthenticated")
	}
	if err := tasks.Delete(ctx, principal, project.ID, task.ID, DeleteTask{Version: task.Version}); err != nil {
		t.Fatal(err)
	}
	_, err = threads.Post(ctx, principal, project.ID, task.ID, CreateThreadMessage{Body: "deleted"})
	requireThreadFault(t, err, "task_deleted")
	_, err = threads.List(ctx, principal, project.ID, task.ID, ThreadListRequest{})
	requireThreadFault(t, err, "task_deleted")
	_, err = threads.List(ctx, outsider, project.ID, task.ID, ThreadListRequest{})
	requireThreadFault(t, err, "forbidden")
}

func TestThreadAgentSourceRequiresCurrentExecutionOwnerAndFreezesDetails(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	owner := workerMember(t, database, project.ID)
	threads := NewTaskThreads(database)
	descriptor := workerDescriptor()
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, admin, project.ID), descriptor)
	ctx := context.Background()
	postThread(t, threads, owner, task, CreateThreadMessage{Body: "ordinary message during execution"})
	agent := postThread(t, threads, owner, task, CreateThreadMessage{Body: "agent message", ClaimID: pointer(strings.ToUpper(descriptor.ClaimID))})
	if !agent.Message.Author.Agent || agent.Message.Author.Execution == nil || agent.Message.Author.Execution.ClaimID != descriptor.ClaimID || agent.Message.Author.Execution.WorkerID != descriptor.WorkerID || agent.Message.Author.Execution.Provider != string(descriptor.Agent) || strings.Contains(string(agent.JSON), "execution") {
		t.Fatalf("source snapshot/default: %#v %s", agent.Message.Author, agent.JSON)
	}
	_, err := threads.Post(ctx, admin, project.ID, task.ID, CreateThreadMessage{Body: "cannot impersonate owner", ClaimID: &descriptor.ClaimID})
	requireThreadFault(t, err, "forbidden")
	_, err = threads.Post(ctx, owner, project.ID, task.ID, CreateThreadMessage{Body: "wrong claim", ClaimID: pointer(uuid.NewString())})
	requireThreadFault(t, err, "claim_conflict")
	released, err := tasks.ReleaseWorker(ctx, owner, project.ID, task.ID, ReleaseWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = threads.Post(ctx, owner, project.ID, task.ID, CreateThreadMessage{Body: "released claim", ClaimID: &descriptor.ClaimID})
	requireThreadFault(t, err, "claim_conflict")
	details := listThread(t, threads, owner, released, ThreadListRequest{Details: true})
	if !reflect.DeepEqual(details.Page.Items[1], agent.Message) || details.Page.Items[0].Author.Agent || !strings.Contains(string(details.JSON), `"execution":{"claimId":"`+descriptor.ClaimID+`"`) {
		t.Fatalf("source history changed after release: %#v", details.Page)
	}
	assertTaskUnchanged(t, tasks, owner, released)
}

func TestThreadExactMessageBudgetsAndRollback(t *testing.T) {
	for _, agent := range []bool{false, true} {
		t.Run(fmt.Sprintf("agent=%t", agent), func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			threads := NewTaskThreads(database)
			task := createTask(t, tasks, principal, project.ID, "Budget")
			var claimID *string
			author := core.ThreadAuthor{UserID: principal.UserID}
			if agent {
				task = updateTask(t, tasks, principal, task, UpdateTask{AllowAgents: pointer(true)})
				descriptor := workerDescriptor()
				task = claimWorkerTask(t, tasks, principal, task, descriptor)
				claimID = &descriptor.ClaimID
				author.Agent, author.Execution = true, &core.ThreadExecution{ClaimID: descriptor.ClaimID, WorkerID: descriptor.WorkerID, Provider: string(descriptor.Agent)}
			}
			reply := postThread(t, threads, principal, task, CreateThreadMessage{Body: "reply target"})
			prefix := " <>&\"\\\n\t中文🌛\u2028\u2029 "
			template := core.ThreadMessage{ID: uuid.NewString(), TaskID: task.ID, Author: author, Body: prefix, ReplyTo: &reply.Message.ID, CreatedAt: time.Now().UTC()}
			base, err := taskthreadjson.EncodeMessage(template, true)
			if err != nil {
				t.Fatal(err)
			}
			body := prefix + strings.Repeat("x", taskthreadjson.MessageLimit-len(base))
			first := postThread(t, threads, principal, task, CreateThreadMessage{Body: body, ClaimID: claimID, ReplyTo: &reply.Message.ID})
			detailed, err := taskthreadjson.EncodeMessage(first.Message, true)
			if err != nil || len(detailed) != taskthreadjson.MessageLimit {
				t.Fatalf("exact admission boundary: %d, %v", len(detailed), err)
			}
			before := threadStoredState(t, database, task.ID)
			_, err = threads.Post(context.Background(), principal, project.ID, task.ID, CreateThreadMessage{Body: body + "x", ClaimID: claimID, ReplyTo: &reply.Message.ID})
			requireThreadFault(t, err, "payload_too_large")
			if after := threadStoredState(t, database, task.ID); before != after {
				t.Fatal("oversize refusal changed messages or head")
			}
			if _, err := database.Pool.Exec(context.Background(), `UPDATE users SET name=$2 WHERE id=$1`, principal.UserID, strings.Repeat("<", 12000)); err != nil {
				t.Fatal(err)
			}
			_, err = threads.Post(context.Background(), principal, project.ID, task.ID, CreateThreadMessage{Body: "short", ClaimID: claimID})
			requireThreadFault(t, err, "payload_too_large")
			if after := threadStoredState(t, database, task.ID); before != after {
				t.Fatal("oversize author refusal changed messages or head")
			}
			page := listThread(t, threads, principal, task, ThreadListRequest{Details: true})
			if len(page.Page.Items) != 2 || page.Page.Items[1].Body != body {
				t.Fatal("later name change invalidated prior admission")
			}
			assertTaskUnchanged(t, tasks, principal, task)
		})
	}
}

func insertThreadFixture(t *testing.T, database *store.Store, task core.Task, principal core.Principal, id string, createdAt time.Time, body string) {
	t.Helper()
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_thread_messages(task_id,message_id,created_at,author_user_id,author_agent,body) VALUES($1,$2,$3,$4,false,$5)`, task.ID, id, createdAt, principal.UserID, body); err != nil {
		t.Fatal(err)
	}
}

func TestThreadIDPaginationTraversesSameMillisecondInBothDirections(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	threads := NewTaskThreads(database)
	task := createTask(t, tasks, principal, project.ID, "Same millisecond")
	createdAt := time.Date(2026, 11, 3, 0, 0, 0, 123000000, time.UTC)
	want := make([]string, 137)
	for i := range want {
		want[i] = fmt.Sprintf("00000000-0000-4000-8000-%012x", i+1)
		insertThreadFixture(t, database, task, principal, want[i], createdAt, "same millisecond")
	}
	initial := listThread(t, threads, principal, task, ThreadListRequest{})
	if len(initial.Page.Items) != 50 || !initial.Page.HasMoreBefore || initial.Page.HasMoreAfter || initial.Page.Items[0].ID != want[87] {
		t.Fatalf("default tail: %#v", initial.Page)
	}
	for _, reverse := range []bool{false, true} {
		request := ThreadListRequest{Count: 17, FromBeginning: !reverse}
		var ids []string
		for {
			page := listThread(t, threads, principal, task, request).Page
			if len(page.Items) == 0 {
				t.Fatal("unexpected empty traversal page")
			}
			batch := make([]string, len(page.Items))
			for i, message := range page.Items {
				batch[i] = message.ID
				if message.Body != "same millisecond" || !message.CreatedAt.Equal(createdAt) {
					t.Fatal("pagination changed stored message")
				}
			}
			if reverse {
				ids = append(batch, ids...)
				if !page.HasMoreBefore {
					break
				}
				request = ThreadListRequest{Count: 17, BeforeID: &page.Items[0].ID}
			} else {
				ids = append(ids, batch...)
				if !page.HasMoreAfter {
					break
				}
				request = ThreadListRequest{Count: 17, AfterID: &page.Items[len(page.Items)-1].ID}
			}
		}
		if !slices.Equal(ids, want) {
			t.Fatalf("reverse=%t pagination lost/duplicated IDs: %v", reverse, ids)
		}
	}
	for _, request := range []ThreadListRequest{{BeforeID: &want[0]}, {AfterID: &want[len(want)-1]}} {
		page := listThread(t, threads, principal, task, request).Page
		if len(page.Items) != 0 || page.Items == nil || page.HasMoreBefore || page.HasMoreAfter {
			t.Fatalf("empty bound page: %#v", page)
		}
	}
	other := createTask(t, tasks, principal, project.ID, "Same UUID in another task")
	insertThreadFixture(t, database, other, principal, want[0], createdAt.Add(time.Second), "other body")
	otherPage := listThread(t, threads, principal, other, ThreadListRequest{}).Page
	if len(otherPage.Items) != 1 || otherPage.Items[0].Body != "other body" {
		t.Fatalf("cross-task UUID leaked: %#v", otherPage)
	}
	postThread(t, threads, principal, other, CreateThreadMessage{Body: "local reply", ReplyTo: &want[0]})
}

func TestThreadPageByteLimitKeepsCompleteBodiesAndActualSides(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	threads := NewTaskThreads(database)
	task := createTask(t, tasks, principal, project.ID, "Byte page")
	template := core.ThreadMessage{ID: uuid.NewString(), Author: core.ThreadAuthor{UserID: principal.UserID}, CreatedAt: time.Now()}
	base, err := taskthreadjson.EncodeMessage(template, false)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Repeat("x", taskthreadjson.MessageLimit-len(base))
	var ids []string
	for range 7 {
		ids = append(ids, postThread(t, threads, principal, task, CreateThreadMessage{Body: body}).Message.ID)
	}
	for _, reverse := range []bool{false, true} {
		request := ThreadListRequest{Count: 100, FromBeginning: !reverse}
		var traversed []string
		for {
			page := listThread(t, threads, principal, task, request).Page
			if len(page.Items) == 0 || len(page.Items) > 3 {
				t.Fatalf("byte page has %d items", len(page.Items))
			}
			batch := make([]string, len(page.Items))
			for i, message := range page.Items {
				batch[i] = message.ID
				if message.Body != body {
					t.Fatal("page truncated body")
				}
			}
			if reverse {
				traversed = append(batch, traversed...)
				if !page.HasMoreBefore {
					break
				}
				request.BeforeID = &page.Items[0].ID
			} else {
				traversed = append(traversed, batch...)
				if !page.HasMoreAfter {
					break
				}
				request.FromBeginning, request.AfterID = false, &page.Items[len(page.Items)-1].ID
			}
		}
		if !slices.Equal(traversed, ids) {
			t.Fatal("byte truncation skipped or duplicated messages")
		}
	}
}

func TestThreadSameMillisecondBytePagesTraverseBothResourceForms(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	threads := NewTaskThreads(database)
	task := createTask(t, tasks, principal, project.ID, "Same millisecond byte pages")
	createdAt := time.Date(2026, 11, 3, 0, 0, 0, 120000000, time.UTC)
	execution := &core.ThreadExecution{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Provider: "codex"}
	name := "Alice <>&"
	want := make([]core.ThreadMessage, 7)
	indices := make(map[string]int, len(want))
	for i := range want {
		message := core.ThreadMessage{
			TaskID: task.ID, ID: fmt.Sprintf("00000000-0000-4000-8000-%012x", i+1), CreatedAt: createdAt,
			Author: core.ThreadAuthor{UserID: principal.UserID, DisplayName: &name, Agent: true, Execution: execution},
			Body:   fmt.Sprintf("message %d <>&\"\\\n\t中文🌛\u2028\u2029 ", i),
		}
		if i > 0 {
			message.ReplyTo = &want[0].ID
		}
		encoded, err := taskthreadjson.EncodeMessage(message, true)
		if err != nil {
			t.Fatal(err)
		}
		message.Body += strings.Repeat("x", taskthreadjson.MessageLimit-len(encoded))
		encoded, err = taskthreadjson.EncodeMessage(message, true)
		if err != nil || len(encoded) != taskthreadjson.MessageLimit {
			t.Fatalf("detailed fixture is not exactly 64 KiB: %d, %v", len(encoded), err)
		}
		// Equal-time rows isolate UUID pagination from clock preparation. The
		// separate admission tests prove these complete resource sizes are legal.
		if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_thread_messages
 (task_id,message_id,created_at,author_user_id,author_display_name,author_agent,author_claim_id,author_worker_id,author_provider,body,reply_to_message_id)
 VALUES($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10)`, task.ID, message.ID, createdAt, principal.UserID, name,
			execution.ClaimID, execution.WorkerID, execution.Provider, message.Body, message.ReplyTo); err != nil {
			t.Fatal(err)
		}
		want[i], indices[message.ID] = message, i
	}
	for _, details := range []bool{false, true} {
		for _, reverse := range []bool{false, true} {
			t.Run(fmt.Sprintf("details=%t/reverse=%t", details, reverse), func(t *testing.T) {
				request := ThreadListRequest{Count: 100, Details: details, FromBeginning: !reverse}
				var traversed []core.ThreadMessage
				pages := 0
				for {
					page := listThread(t, threads, principal, task, request).Page
					pages++
					if pages > len(want) || len(page.Items) == 0 || len(page.Items) >= len(want) {
						t.Fatalf("byte limit did not provide bounded progress: page %d has %d items", pages, len(page.Items))
					}
					if details && len(page.Items) > 3 {
						t.Fatalf("four complete 64 KiB resources fit in one page: %d items", len(page.Items))
					}
					first, last := indices[page.Items[0].ID], indices[page.Items[len(page.Items)-1].ID]
					if page.HasMoreBefore != (first > 0) || page.HasMoreAfter != (last < len(want)-1) {
						t.Fatalf("page sides disagree with boundaries %d..%d: before=%t after=%t", first, last, page.HasMoreBefore, page.HasMoreAfter)
					}
					for _, message := range page.Items {
						index, exists := indices[message.ID]
						if !exists || !reflect.DeepEqual(message, want[index]) {
							t.Fatalf("same-millisecond byte page changed a complete message: %s", message.ID)
						}
					}
					if reverse {
						traversed = append(page.Items, traversed...)
						if !page.HasMoreBefore {
							break
						}
						request.BeforeID = &page.Items[0].ID
					} else {
						traversed = append(traversed, page.Items...)
						if !page.HasMoreAfter {
							break
						}
						request.FromBeginning, request.AfterID = false, &page.Items[len(page.Items)-1].ID
					}
				}
				if pages < 2 || !reflect.DeepEqual(traversed, want) {
					t.Fatal("same-millisecond byte traversal omitted, duplicated or changed messages")
				}
			})
		}
	}
}

func TestThreadLocalPostDoesNotHideUnreadMessagesAndEmptyInitialization(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	threads := NewTaskThreads(database)
	task := createTask(t, tasks, principal, project.ID, "Incremental")
	if len(listThread(t, threads, principal, task, ThreadListRequest{}).Page.Items) != 0 {
		t.Fatal("new thread not empty")
	}
	a := postThread(t, threads, principal, task, CreateThreadMessage{Body: "A"})
	b := postThread(t, threads, principal, task, CreateThreadMessage{Body: "B unseen"})
	c := postThread(t, threads, principal, task, CreateThreadMessage{Body: "C local"})
	page := listThread(t, threads, principal, task, ThreadListRequest{AfterID: &a.Message.ID}).Page
	if len(page.Items) != 2 || page.Items[0].ID != b.Message.ID || page.Items[1].ID != c.Message.ID || !page.HasMoreBefore || page.HasMoreAfter {
		t.Fatalf("unread/local interleave: %#v", page)
	}
	beginning := listThread(t, threads, principal, task, ThreadListRequest{FromBeginning: true, Count: 1}).Page
	if len(beginning.Items) != 1 || beginning.Items[0].ID != a.Message.ID || beginning.HasMoreBefore || !beginning.HasMoreAfter {
		t.Fatalf("initial empty-page recovery: %#v", beginning)
	}
}

func TestThreadResponseClassificationPreservesUnknownAndCleanupPriority(t *testing.T) {
	clock := &store.ThreadClockError{Cause: context.DeadlineExceeded}
	for _, test := range []struct {
		err  error
		code string
	}{
		{nil, ""}, {errors.New("ordinary"), ""},
		{&store.ThreadTransactionError{Cause: errors.New("database"), Phase: "callback"}, ""},
		{&store.ThreadTransactionError{Cause: clock, Phase: "callback"}, "clock_not_advanced"},
		{&store.ThreadTransactionError{Cause: context.DeadlineExceeded, Phase: "commit", CommitAttempted: true, OutcomeUnknown: true}, "message_outcome_unknown"},
		{&store.ThreadTransactionError{Cause: clock, Phase: "commit", CommitAttempted: true}, ""},
		{&store.ThreadTransactionError{Cause: clock, Phase: "rollback", RollbackFailed: true}, "internal_error"},
		{&store.ThreadTransactionError{Cause: errors.Join(&Fault{Code: "payload_too_large"}, context.Canceled), Phase: "rollback", RollbackFailed: true, OutcomeUnknown: true}, "internal_error"},
	} {
		fault, ok := ThreadResponseFault(test.err)
		if ok != (test.code != "") || ok && fault.Code != test.code || ThreadWriteOutcomeUnknown(test.err) != (test.code == "message_outcome_unknown") {
			t.Fatalf("classification: %#v, %t for %#v", fault, ok, test.err)
		}
		if ok && !errors.Is(fault, test.err) {
			t.Fatal("classification discarded original error chain")
		}
	}
}
