package task_test

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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func requireThreadFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code || fault.Message == "" {
		t.Fatalf("expected %s fault, got %#v (error: %#v)", code, fault, err)
	}
	return fault
}

func postThread(t *testing.T, threads *taskservice.TaskThreads, principal model.Principal, target model.Task, input taskservice.CreateThreadMessage) taskservice.ThreadMessageDocument {
	t.Helper()
	result, err := threads.Post(t.Context(), principal, target.ProjectID, target.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	var resource api.ThreadMessage
	if err := json.Unmarshal(result.JSON, &resource); err != nil || resource.ID != result.Message.ID || resource.Body != input.Body {
		t.Fatalf("message document: %#v, %v", resource, err)
	}
	return result
}

func listThread(t *testing.T, threads *taskservice.TaskThreads, principal model.Principal, target model.Task, input taskservice.ThreadListRequest) taskservice.ThreadPageDocument {
	t.Helper()
	result, err := threads.List(t.Context(), principal, target.ProjectID, target.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	var resource api.ThreadPage
	if err := json.Unmarshal(result.JSON, &resource); err != nil || len(resource.Items) != len(result.Page.Items) {
		t.Fatalf("page document: %#v, %v", resource, err)
	}
	return result
}

func expectThreadAppend(t *testing.T, dao *threadDAOMock, target model.Task, principal model.Principal, id string, at time.Time, advanced bool) {
	t.Helper()
	inserted, prepared, advances := 0, 0, 0
	dao.LockHeadFn = func(_ context.Context, actual string) (*model.ThreadPosition, error) {
		if actual != target.ID {
			t.Fatalf("head Task: %s", actual)
		}
		return nil, nil
	}
	dao.InsertMessageFn = func(_ context.Context, message model.ThreadMessage) (model.ThreadMessage, error) {
		inserted++
		if message.ID != "" || !message.CreatedAt.IsZero() || message.TaskID != target.ID || message.Author.UserID != principal.UserID {
			t.Fatalf("proposed message: %#v", message)
		}
		message.ID, message.CreatedAt = id, at
		return message, nil
	}
	dao.PrepareTimestampFn = func(_ context.Context, message *model.ThreadMessage, head *model.ThreadPosition) error {
		prepared++
		if message.ID != id || !message.CreatedAt.Equal(at) || head != nil {
			t.Fatalf("timestamp candidate/head: %#v, %#v", message, head)
		}
		return nil
	}
	dao.AdvanceHeadFn = func(_ context.Context, actual string, position model.ThreadPosition) error {
		advances++
		if actual != target.ID || position.ID != id || !position.CreatedAt.Equal(at) {
			t.Fatalf("advanced position: %s %#v", actual, position)
		}
		return nil
	}
	t.Cleanup(func() {
		want := 0
		if advanced {
			want = 1
		}
		if inserted != 1 || prepared != 1 || advances != want {
			t.Errorf("append calls: insert=%d prepare=%d advance=%d, want 1/1/%d", inserted, prepared, advances, want)
		}
	})
}

func commitThreadCallback(database *taskStoreMock, scope store.ThreadScope) {
	database.WriteThreadFn = func(_ context.Context, work func(store.ThreadScope) error) (store.Completion, error) {
		err := work(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}

func threadActiveTask(t *testing.T, target model.Task, userID string) (model.Task, model.WorkerClaim) {
	t.Helper()
	claim := model.WorkerClaim{
		ClaimID: "66666666-6666-4666-8666-666666666666", State: model.WorkerActive, UserID: userID,
		WorkerID: "77777777-7777-4777-8777-777777777777", Machine: model.WorkerMachine{ID: "88888888-8888-4888-8888-888888888888", Name: "machine"},
		Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr,
		WorktreeID: "99999999-9999-4999-8999-999999999999", Phase: model.WorkerExecuting, ClaimedAt: target.CreatedAt,
	}
	encoded, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	target.Status, target.Properties = model.TaskInProgress, model.TaskProperties{"worker": encoded}
	return target, claim
}

func threadMessages(target model.Task, principal model.Principal, count int, at time.Time, body string) []model.ThreadMessage {
	result := make([]model.ThreadMessage, count)
	for i := range result {
		result[i] = model.ThreadMessage{TaskID: target.ID, ID: fmt.Sprintf("00000000-0000-4000-8000-%012x", i+1), CreatedAt: at, Author: model.ThreadAuthor{UserID: principal.UserID}, Body: body}
	}
	return result
}

func threadCandidates(messages []model.ThreadMessage, reverse bool) []model.ThreadMessage {
	result := slices.Clone(messages)
	if reverse {
		slices.Reverse(result)
	}
	return result
}

func expectThreadPage(t *testing.T, reader *taskReaderMock, target model.Task, request taskservice.ThreadListRequest, anchor *model.ThreadMessage, candidates, selected []model.ThreadMessage, moreBefore, moreAfter bool) {
	t.Helper()
	count := request.Count
	if count == 0 {
		count = 50
	}
	reverse := request.AfterID == nil && !request.FromBeginning
	reader.TaskPresenceFn = func(_ context.Context, projectID, taskID string) (store.TaskPresence, error) {
		if projectID != target.ProjectID || taskID != target.ID {
			t.Fatalf("presence scope: %s %s", projectID, taskID)
		}
		return store.TaskPresence{Found: true}, nil
	}
	reader.ThreadMessageFn, reader.ThreadSidesFn = nil, nil
	anchors, queries, sides := 0, 0, 0
	if anchor != nil {
		reader.ThreadMessageFn = func(_ context.Context, taskID, messageID string) (model.ThreadMessage, error) {
			anchors++
			if taskID != target.ID || messageID != anchor.ID {
				t.Fatalf("anchor scope: %s %s", taskID, messageID)
			}
			return *anchor, nil
		}
	}
	reader.ThreadCandidatesFn = func(_ context.Context, taskID string, position *model.ThreadPosition, before bool, limit int) ([]model.ThreadMessage, error) {
		queries++
		if taskID != target.ID || before != reverse || limit != count+1 || (position == nil) != (anchor == nil) {
			t.Fatalf("candidate query: %s %#v before=%t limit=%d", taskID, position, before, limit)
		}
		if anchor != nil && (position.ID != anchor.ID || !position.CreatedAt.Equal(anchor.CreatedAt)) {
			t.Fatalf("candidate anchor: %#v", position)
		}
		return candidates, nil
	}
	if len(selected) > 0 {
		reader.ThreadSidesFn = func(_ context.Context, taskID string, first, last model.ThreadPosition) (bool, bool, error) {
			sides++
			if taskID != target.ID || first != selected[0].Position() || last != selected[len(selected)-1].Position() {
				t.Fatalf("page sides: %s %#v %#v", taskID, first, last)
			}
			return moreBefore, moreAfter, nil
		}
	}
	t.Cleanup(func() {
		wantAnchor, wantSides := 0, 0
		if anchor != nil {
			wantAnchor = 1
		}
		if len(selected) > 0 {
			wantSides = 1
		}
		if anchors != wantAnchor || queries != 1 || sides != wantSides {
			t.Errorf("page calls: anchor=%d query=%d sides=%d, want %d/1/%d", anchors, queries, sides, wantAnchor, wantSides)
		}
	})
}

func requireThreadPage(t *testing.T, result taskservice.ThreadPageDocument, messages []model.ThreadMessage, moreBefore, moreAfter bool) {
	t.Helper()
	if !reflect.DeepEqual(result.Page.Items, messages) || result.Page.HasMoreBefore != moreBefore || result.Page.HasMoreAfter != moreAfter {
		t.Fatalf("page content/sides: %#v", result.Page)
	}
}

func TestThreadAttributionAndDocumentsAcrossLifecycle(t *testing.T) {
	f := newThreadFailureFixture(t)
	empty := []model.ThreadMessage{}
	expectThreadPage(t, f.taskRead, f.task, taskservice.ThreadListRequest{}, nil, empty, empty, false, false)
	requireThreadPage(t, listThread(t, f.service, f.principal, f.task, taskservice.ThreadListRequest{}), empty, false, false)
	at := time.Date(2026, 11, 3, 0, 0, 0, 123000000, time.UTC)
	firstFixture := newThreadFailureFixture(t)
	firstFixture.thread.ThreadMessageFn = nil
	expectThreadAppend(t, firstFixture.thread, firstFixture.task, firstFixture.principal, uuid.NewString(), at, true)
	commitThreadCallback(firstFixture.database, firstFixture.scope)
	first := postThread(t, firstFixture.service, firstFixture.principal, firstFixture.task, taskservice.CreateThreadMessage{Body: "  <>&\"\\\n\t中文🌛\u2028\u2029  "})
	if first.Message.Author.DisplayName != nil || first.Message.Author.Agent || first.Message.CreatedAt.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("default attribution/precision: %#v", first.Message)
	}
	secondFixture := newThreadFailureFixture(t)
	name := "Alice"
	secondFixture.credential.AuthorNameFn = func(_ context.Context, userID string) (*string, error) {
		if userID != secondFixture.principal.UserID {
			t.Fatal("author identity changed")
		}
		return &name, nil
	}
	secondFixture.thread.ThreadMessageFn = func(_ context.Context, taskID, id string) (model.ThreadMessage, error) {
		if taskID != secondFixture.task.ID || id != first.Message.ID {
			t.Fatal("reply scope changed")
		}
		return first.Message, nil
	}
	expectThreadAppend(t, secondFixture.thread, secondFixture.task, secondFixture.principal, uuid.NewString(), at.Add(time.Millisecond), true)
	commitThreadCallback(secondFixture.database, secondFixture.scope)
	second := postThread(t, secondFixture.service, secondFixture.principal, secondFixture.task, taskservice.CreateThreadMessage{Body: "reply", ReplyTo: pointer(strings.ToUpper(first.Message.ID))})
	if second.Message.ReplyTo == nil || *second.Message.ReplyTo != first.Message.ID || second.Message.Author.DisplayName == nil || *second.Message.Author.DisplayName != name {
		t.Fatalf("reply attribution: %#v", second.Message)
	}
	read := newThreadFailureFixture(t)
	want := []model.ThreadMessage{first.Message, second.Message}
	request := taskservice.ThreadListRequest{Details: true}
	expectThreadPage(t, read.taskRead, read.task, request, nil, threadCandidates(want, true), want, false, false)
	requireThreadPage(t, listThread(t, read.service, read.principal, read.task, request), want, false, false)
	completed := newThreadFailureFixture(t)
	completed.task.Status = model.TaskDone
	completed.thread.ThreadMessageFn = nil
	expectThreadAppend(t, completed.thread, completed.task, completed.principal, uuid.NewString(), at.Add(2*time.Millisecond), true)
	commitThreadCallback(completed.database, completed.scope)
	third := postThread(t, completed.service, completed.principal, completed.task, taskservice.CreateThreadMessage{Body: "Task completion retains the discussion"})
	completedRead := newThreadFailureFixture(t)
	completedRead.task.Status = model.TaskDone
	want = append(want, third.Message)
	expectThreadPage(t, completedRead.taskRead, completedRead.task, taskservice.ThreadListRequest{}, nil, threadCandidates(want, true), want, false, false)
	requireThreadPage(t, listThread(t, completedRead.service, completedRead.principal, completedRead.task, taskservice.ThreadListRequest{}), want, false, false)
}

func TestThreadInputAndScopedAuthorization(t *testing.T) {
	project, target, principal := taskMockModels()
	foreignID := "00000000-0000-4000-8000-000000000099"
	threads := taskservice.NewTaskThreads(&taskStoreMock{taskMockBase: newTaskMockBase(t, "preflight")})
	for _, input := range []taskservice.CreateThreadMessage{
		{}, {Body: " \n\t\u2003"}, {Body: "\xff"}, {Body: "a\x00b"}, {Body: "body", ReplyTo: pointer("bad")}, {Body: "body", ClaimID: pointer("bad")},
	} {
		_, err := threads.Post(t.Context(), principal, project.ID, target.ID, input)
		requireThreadFault(t, err, "invalid_input")
	}
	_, err := threads.Post(t.Context(), principal, project.ID, target.ID, taskservice.CreateThreadMessage{Body: strings.Repeat("x", taskcodec.MessageLimit+1)})
	requireThreadFault(t, err, "payload_too_large")
	for _, request := range []taskservice.ThreadListRequest{
		{Count: -1}, {Count: 101}, {BeforeID: pointer("bad")}, {AfterID: pointer("bad")},
		{BeforeID: &foreignID, AfterID: &foreignID}, {BeforeID: &foreignID, FromBeginning: true}, {AfterID: &foreignID, FromBeginning: true},
	} {
		_, err := threads.List(t.Context(), principal, project.ID, target.ID, request)
		requireThreadFault(t, err, "invalid_input")
	}
	reply := newThreadFailureFixture(t)
	reply.thread.ThreadMessageFn = func(_ context.Context, taskID, id string) (model.ThreadMessage, error) {
		if taskID != target.ID || id != foreignID {
			t.Fatal("foreign reply escaped Task scope")
		}
		return model.ThreadMessage{}, model.ErrNotFound
	}
	_, err = reply.service.Post(t.Context(), principal, project.ID, target.ID, taskservice.CreateThreadMessage{Body: "reply", ReplyTo: &foreignID})
	requireThreadFault(t, err, "message_not_found")
	for _, request := range []taskservice.ThreadListRequest{{BeforeID: &foreignID}, {AfterID: &foreignID}, {AfterID: pointer(uuid.NewString())}} {
		f := newThreadFailureFixture(t)
		f.taskRead.ThreadMessageFn = func(_ context.Context, taskID, id string) (model.ThreadMessage, error) {
			if taskID != target.ID {
				t.Fatal("foreign boundary escaped Task scope")
			}
			return model.ThreadMessage{}, model.ErrNotFound
		}
		_, err := f.service.List(t.Context(), principal, project.ID, target.ID, request)
		requireThreadFault(t, err, "message_not_found")
	}
	for _, operation := range []string{"post", "list"} {
		for _, test := range []struct{ name, code string }{
			{"unauthenticated", "unauthenticated"}, {"project_id", "invalid_input"}, {"task_id", "invalid_input"}, {"missing_task", "not_found"},
			{"outsider", "forbidden"}, {"spoofed", "unauthenticated"}, {"deleted_task", "task_deleted"}, {"deleted_outsider", "forbidden"},
		} {
			t.Run(operation+"/"+test.name, func(t *testing.T) {
				f := newThreadFailureFixture(t)
				p, projectID, taskID := f.principal, f.project.ID, f.task.ID
				if test.name == "deleted_task" || test.name == "deleted_outsider" {
					deleted := f.task.UpdatedAt
					presence := func(ctx context.Context, actualProjectID, actualTaskID string) (store.TaskPresence, error) {
						if actualProjectID != projectID || actualTaskID != taskID {
							t.Fatalf("deleted Task scope: %s %s", actualProjectID, actualTaskID)
						}
						return store.TaskPresence{Found: true, DeletedAt: &deleted}, ctx.Err()
					}
					f.taskRead.TaskPresenceFn = presence
					f.taskWrite.LockTaskPresenceFn = presence
				}
				switch test.name {
				case "unauthenticated":
					p = model.Principal{}
				case "project_id":
					projectID = "bad"
				case "task_id":
					taskID = "bad"
				case "missing_task":
					f.taskRead.TaskPresenceFn = func(context.Context, string, string) (store.TaskPresence, error) { return store.TaskPresence{}, nil }
					f.taskWrite.LockTaskPresenceFn = func(context.Context, string, string) (store.TaskPresence, error) { return store.TaskPresence{}, nil }
				case "outsider", "deleted_outsider":
					f.projectRead.ProjectAccessFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
						return model.ProjectAccess{}, model.ErrNotFound
					}
					f.projectWrite.LockProjectAuthorizationFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
						return model.ProjectAccess{}, model.ErrNotFound
					}
				case "spoofed":
					f.readCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
						return store.ThreadCredential{}, model.ErrNotFound
					}
					f.credential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
						return store.ThreadCredential{}, model.ErrNotFound
					}
				}
				var err error
				if operation == "post" {
					_, err = f.service.Post(t.Context(), p, projectID, taskID, taskservice.CreateThreadMessage{Body: "body"})
				} else {
					_, err = f.service.List(t.Context(), p, projectID, taskID, taskservice.ThreadListRequest{})
				}
				requireThreadFault(t, err, test.code)
			})
		}
	}
}

func TestThreadAgentSourceRequiresCurrentExecutionOwnerAndFreezesDetails(t *testing.T) {
	f := newThreadFailureFixture(t)
	at := time.Date(2026, 11, 3, 0, 0, 0, 123000000, time.UTC)
	f.thread.ThreadMessageFn = nil
	expectThreadAppend(t, f.thread, f.task, f.principal, uuid.NewString(), at, true)
	commitThreadCallback(f.database, f.scope)
	ordinary := postThread(t, f.service, f.principal, f.task, taskservice.CreateThreadMessage{Body: "ordinary message during execution"})
	agentFixture := newThreadFailureFixture(t)
	current, claim := threadActiveTask(t, agentFixture.task, agentFixture.principal.UserID)
	agentFixture.taskWrite.SourceTaskFn = func(_ context.Context, projectID, taskID string) (model.Task, error) {
		if projectID != current.ProjectID || taskID != current.ID {
			t.Fatal("claim source escaped Task scope")
		}
		return current, nil
	}
	agentFixture.thread.ThreadMessageFn = nil
	expectThreadAppend(t, agentFixture.thread, current, agentFixture.principal, uuid.NewString(), at.Add(time.Millisecond), true)
	commitThreadCallback(agentFixture.database, agentFixture.scope)
	agent := postThread(t, agentFixture.service, agentFixture.principal, current, taskservice.CreateThreadMessage{Body: "agent message", ClaimID: pointer(strings.ToUpper(claim.ClaimID))})
	if !agent.Message.Author.Agent || agent.Message.Author.Execution == nil || agent.Message.Author.Execution.ClaimID != claim.ClaimID || agent.Message.Author.Execution.WorkerID != claim.WorkerID || agent.Message.Author.Execution.Provider != string(claim.Agent) || strings.Contains(string(agent.JSON), "execution") {
		t.Fatalf("source snapshot/default: %#v %s", agent.Message.Author, agent.JSON)
	}
	for _, test := range []struct{ name, code string }{{"non_owner", "forbidden"}, {"wrong_claim", "claim_conflict"}, {"released", "claim_conflict"}} {
		t.Run(test.name, func(t *testing.T) {
			f := newThreadFailureFixture(t)
			source, worker := threadActiveTask(t, f.task, f.principal.UserID)
			claimID := worker.ClaimID
			switch test.name {
			case "non_owner":
				worker.UserID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			case "wrong_claim":
				claimID = uuid.NewString()
			case "released":
				worker.State = model.WorkerReleased
			}
			value, err := taskproperty.EncodeWorker(&worker)
			if err != nil {
				t.Fatal(err)
			}
			source.Properties = model.TaskProperties{"worker": value}
			f.taskWrite.SourceTaskFn = func(context.Context, string, string) (model.Task, error) { return source, nil }
			_, err = f.service.Post(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.CreateThreadMessage{Body: "refused attribution", ClaimID: &claimID})
			requireThreadFault(t, err, test.code)
		})
	}
	read := newThreadFailureFixture(t)
	want := []model.ThreadMessage{ordinary.Message, agent.Message}
	request := taskservice.ThreadListRequest{Details: true}
	expectThreadPage(t, read.taskRead, read.task, request, nil, threadCandidates(want, true), want, false, false)
	result := listThread(t, read.service, read.principal, read.task, request)
	requireThreadPage(t, result, want, false, false)
	if result.Page.Items[0].Author.Agent || !strings.Contains(string(result.JSON), `"execution":{"claimId":"`+claim.ClaimID+`"`) {
		t.Fatalf("source details: %#v %s", result.Page, result.JSON)
	}
}

func TestThreadExactMessageBudgetsRejectBeforeHeadAdvance(t *testing.T) {
	for _, agent := range []bool{false, true} {
		t.Run(fmt.Sprintf("agent=%t", agent), func(t *testing.T) {
			f := newThreadFailureFixture(t)
			at := time.Date(2026, 11, 3, 0, 0, 0, 123000000, time.UTC)
			id, replyID := uuid.NewString(), uuid.NewString()
			prefix := " <>&\"\\\n\t中文🌛\u2028\u2029 "
			author := model.ThreadAuthor{UserID: f.principal.UserID}
			var claimID *string
			if agent {
				current, claim := threadActiveTask(t, f.task, f.principal.UserID)
				f.taskWrite.SourceTaskFn = func(context.Context, string, string) (model.Task, error) { return current, nil }
				claimID = &claim.ClaimID
				author.Agent, author.Execution = true, &model.ThreadExecution{ClaimID: claim.ClaimID, WorkerID: claim.WorkerID, Provider: string(claim.Agent)}
			}
			template := model.ThreadMessage{ID: id, TaskID: f.task.ID, Author: author, Body: prefix, ReplyTo: &replyID, CreatedAt: at}
			base, err := taskcodec.EncodeMessage(template, true)
			if err != nil {
				t.Fatal(err)
			}
			body := prefix + strings.Repeat("x", taskcodec.MessageLimit-len(base))
			f.thread.ThreadMessageFn = func(_ context.Context, taskID, messageID string) (model.ThreadMessage, error) {
				if taskID != f.task.ID || messageID != replyID {
					t.Fatal("reply scope changed")
				}
				return model.ThreadMessage{ID: replyID, TaskID: f.task.ID}, nil
			}
			expectThreadAppend(t, f.thread, f.task, f.principal, id, at, true)
			commitThreadCallback(f.database, f.scope)
			first := postThread(t, f.service, f.principal, f.task, taskservice.CreateThreadMessage{Body: body, ClaimID: claimID, ReplyTo: &replyID})
			detailed, err := taskcodec.EncodeMessage(first.Message, true)
			if err != nil || len(detailed) != taskcodec.MessageLimit {
				t.Fatalf("exact admission boundary: %d, %v", len(detailed), err)
			}
			for _, overflow := range []string{"body", "author"} {
				t.Run(overflow, func(t *testing.T) {
					f := newThreadFailureFixture(t)
					if agent {
						current, _ := threadActiveTask(t, f.task, f.principal.UserID)
						f.taskWrite.SourceTaskFn = func(context.Context, string, string) (model.Task, error) { return current, nil }
					}
					input := taskservice.CreateThreadMessage{Body: body + "x", ClaimID: claimID, ReplyTo: &replyID}
					if overflow == "author" {
						input.Body, input.ReplyTo = "short", nil
						f.thread.ThreadMessageFn = nil
						name := strings.Repeat("<", 12000)
						f.credential.AuthorNameFn = func(context.Context, string) (*string, error) { return &name, nil }
					} else {
						f.thread.ThreadMessageFn = func(context.Context, string, string) (model.ThreadMessage, error) {
							return model.ThreadMessage{ID: replyID, TaskID: f.task.ID}, nil
						}
					}
					expectThreadAppend(t, f.thread, f.task, f.principal, id, at, false)
					commitThreadCallback(f.database, f.scope)
					result, err := f.service.Post(t.Context(), f.principal, f.project.ID, f.task.ID, input)
					requireThreadFault(t, err, "payload_too_large")
					if result.JSON != nil {
						t.Fatal("refused message exposed a document")
					}
				})
			}
			read := newThreadFailureFixture(t)
			request := taskservice.ThreadListRequest{Details: true}
			want := []model.ThreadMessage{first.Message}
			expectThreadPage(t, read.taskRead, read.task, request, nil, want, want, false, false)
			requireThreadPage(t, listThread(t, read.service, read.principal, read.task, request), want, false, false)
		})
	}
}

func TestThreadIDPaginationTraversesSameMillisecondInBothDirections(t *testing.T) {
	_, target, principal := taskMockModels()
	at := time.Date(2026, 11, 3, 0, 0, 0, 123000000, time.UTC)
	want := threadMessages(target, principal, 137, at, "same millisecond")
	initial := newThreadFailureFixture(t)
	expectThreadPage(t, initial.taskRead, target, taskservice.ThreadListRequest{}, nil, threadCandidates(want[86:], true), want[87:], true, false)
	requireThreadPage(t, listThread(t, initial.service, principal, target, taskservice.ThreadListRequest{}), want[87:], true, false)
	for _, reverse := range []bool{false, true} {
		var traversed []model.ThreadMessage
		if reverse {
			for end := len(want); end > 0; {
				start := max(end-17, 0)
				request := taskservice.ThreadListRequest{Count: 17}
				var anchor *model.ThreadMessage
				if end < len(want) {
					anchor = &want[end]
					request.BeforeID = &anchor.ID
				}
				f := newThreadFailureFixture(t)
				expectThreadPage(t, f.taskRead, target, request, anchor, threadCandidates(want[max(end-18, 0):end], true), want[start:end], start > 0, end < len(want))
				page := listThread(t, f.service, principal, target, request)
				requireThreadPage(t, page, want[start:end], start > 0, end < len(want))
				traversed = append(page.Page.Items, traversed...)
				end = start
			}
		} else {
			for start := 0; start < len(want); {
				end := min(start+17, len(want))
				request := taskservice.ThreadListRequest{Count: 17, FromBeginning: start == 0}
				var anchor *model.ThreadMessage
				if start > 0 {
					anchor = &want[start-1]
					request.AfterID = &anchor.ID
				}
				f := newThreadFailureFixture(t)
				expectThreadPage(t, f.taskRead, target, request, anchor, want[start:min(start+18, len(want))], want[start:end], start > 0, end < len(want))
				page := listThread(t, f.service, principal, target, request)
				requireThreadPage(t, page, want[start:end], start > 0, end < len(want))
				traversed = append(traversed, page.Page.Items...)
				start = end
			}
		}
		if !reflect.DeepEqual(traversed, want) {
			t.Fatalf("reverse=%t lost or changed messages", reverse)
		}
	}
	for _, reverse := range []bool{false, true} {
		anchor := &want[len(want)-1]
		request := taskservice.ThreadListRequest{AfterID: &anchor.ID}
		if reverse {
			anchor = &want[0]
			request = taskservice.ThreadListRequest{BeforeID: &anchor.ID}
		}
		f := newThreadFailureFixture(t)
		empty := []model.ThreadMessage{}
		expectThreadPage(t, f.taskRead, target, request, anchor, empty, empty, false, false)
		requireThreadPage(t, listThread(t, f.service, principal, target, request), empty, false, false)
	}
	other := target
	other.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	otherMessage := want[0]
	otherMessage.TaskID, otherMessage.Body, otherMessage.CreatedAt = other.ID, "other body", at.Add(time.Second)
	f := newThreadFailureFixture(t)
	otherMessages := []model.ThreadMessage{otherMessage}
	expectThreadPage(t, f.taskRead, other, taskservice.ThreadListRequest{}, nil, otherMessages, otherMessages, false, false)
	requireThreadPage(t, listThread(t, f.service, principal, other, taskservice.ThreadListRequest{}), otherMessages, false, false)
	reply := newThreadFailureFixture(t)
	reply.task = other
	reply.thread.ThreadMessageFn = func(_ context.Context, taskID, id string) (model.ThreadMessage, error) {
		if taskID != other.ID || id != otherMessage.ID {
			t.Fatal("same UUID reply escaped its Task")
		}
		return otherMessage, nil
	}
	expectThreadAppend(t, reply.thread, other, principal, uuid.NewString(), at.Add(time.Second+time.Millisecond), true)
	commitThreadCallback(reply.database, reply.scope)
	postThread(t, reply.service, principal, other, taskservice.CreateThreadMessage{Body: "local reply", ReplyTo: &otherMessage.ID})
}

func TestThreadCountPageKeepsCompleteBodiesAndActualSides(t *testing.T) {
	_, target, principal := taskMockModels()
	at := time.Date(2026, 11, 3, 0, 0, 0, 123000000, time.UTC)
	want := threadMessages(target, principal, 7, at, "")
	base, err := taskcodec.EncodeMessage(want[0], false)
	if err != nil {
		t.Fatal(err)
	}
	for i := range want {
		want[i].Body = strings.Repeat("x", taskcodec.MessageLimit-len(base))
	}
	assertThreadCountTraversal(t, target, principal, want, false, len(want))
}

func assertThreadCountTraversal(t *testing.T, target model.Task, principal model.Principal, want []model.ThreadMessage, details bool, pageCount int) {
	t.Helper()
	for _, reverse := range []bool{false, true} {
		t.Run(fmt.Sprintf("details=%t/reverse=%t", details, reverse), func(t *testing.T) {
			var traversed []model.ThreadMessage
			for offset := 0; offset < len(want); {
				start, end := offset, min(offset+pageCount, len(want))
				request := taskservice.ThreadListRequest{Count: pageCount, Details: details, FromBeginning: !reverse && offset == 0}
				var anchor *model.ThreadMessage
				var candidates []model.ThreadMessage
				if reverse {
					end, start = len(want)-offset, max(len(want)-offset-pageCount, 0)
					candidates = threadCandidates(want[max(end-pageCount-1, 0):end], true)
					if offset > 0 {
						anchor = &want[end]
						request.BeforeID = &anchor.ID
					}
				} else {
					candidates = want[start:min(start+pageCount+1, len(want))]
					if offset > 0 {
						anchor = &want[start-1]
						request.AfterID = &anchor.ID
					}
				}
				f := newThreadFailureFixture(t)
				expectThreadPage(t, f.taskRead, target, request, anchor, candidates, want[start:end], start > 0, end < len(want))
				page := listThread(t, f.service, principal, target, request)
				requireThreadPage(t, page, want[start:end], start > 0, end < len(want))
				if reverse {
					traversed = append(page.Page.Items, traversed...)
				} else {
					traversed = append(traversed, page.Page.Items...)
				}
				offset += end - start
			}
			if !reflect.DeepEqual(traversed, want) {
				t.Fatal("count traversal omitted, duplicated or changed messages")
			}
		})
	}
}

func TestThreadSameMillisecondCountPagesTraverseBothResourceForms(t *testing.T) {
	_, target, principal := taskMockModels()
	at := time.Date(2026, 11, 3, 0, 0, 0, 120000000, time.UTC)
	want := threadMessages(target, principal, 7, at, "")
	name := "Alice <>&"
	execution := &model.ThreadExecution{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Provider: "codex"}
	for i := range want {
		want[i].Author = model.ThreadAuthor{UserID: principal.UserID, DisplayName: &name, Agent: true, Execution: execution}
		want[i].Body = fmt.Sprintf("message %d <>&\"\\\n\t中文🌛\u2028\u2029 ", i)
		if i > 0 {
			want[i].ReplyTo = &want[0].ID
		}
		encoded, err := taskcodec.EncodeMessage(want[i], true)
		if err != nil {
			t.Fatal(err)
		}
		want[i].Body += strings.Repeat("x", taskcodec.MessageLimit-len(encoded))
		encoded, err = taskcodec.EncodeMessage(want[i], true)
		if err != nil || len(encoded) != taskcodec.MessageLimit {
			t.Fatalf("complete detailed resource: %d, %v", len(encoded), err)
		}
	}
	assertThreadCountTraversal(t, target, principal, want, false, 4)
	assertThreadCountTraversal(t, target, principal, want, true, 3)
}

func TestThreadLocalPostDoesNotHideUnreadMessagesAndEmptyInitialization(t *testing.T) {
	_, target, principal := taskMockModels()
	at := time.Date(2026, 11, 3, 0, 0, 0, 123000000, time.UTC)
	want := threadMessages(target, principal, 3, at, "")
	f := newThreadFailureFixture(t)
	empty := []model.ThreadMessage{}
	expectThreadPage(t, f.taskRead, target, taskservice.ThreadListRequest{}, nil, empty, empty, false, false)
	requireThreadPage(t, listThread(t, f.service, principal, target, taskservice.ThreadListRequest{}), empty, false, false)
	for i, body := range []string{"A", "B unseen", "C local"} {
		f := newThreadFailureFixture(t)
		f.thread.ThreadMessageFn = nil
		expectThreadAppend(t, f.thread, target, principal, want[i].ID, at.Add(time.Duration(i)*time.Millisecond), true)
		commitThreadCallback(f.database, f.scope)
		want[i] = postThread(t, f.service, principal, target, taskservice.CreateThreadMessage{Body: body}).Message
	}
	read := newThreadFailureFixture(t)
	request := taskservice.ThreadListRequest{AfterID: &want[0].ID}
	expectThreadPage(t, read.taskRead, target, request, &want[0], want[1:], want[1:], true, false)
	requireThreadPage(t, listThread(t, read.service, principal, target, request), want[1:], true, false)
	beginning := newThreadFailureFixture(t)
	request = taskservice.ThreadListRequest{FromBeginning: true, Count: 1}
	expectThreadPage(t, beginning.taskRead, target, request, nil, want[:2], want[:1], false, true)
	requireThreadPage(t, listThread(t, beginning.service, principal, target, request), want[:1], false, true)
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
		{&store.ThreadTransactionError{Cause: errors.Join(&model.Fault{Code: "payload_too_large"}, context.Canceled), Phase: "rollback", RollbackFailed: true, OutcomeUnknown: true}, "internal_error"},
	} {
		fault, ok := taskservice.ThreadResponseFault(test.err)
		if ok != (test.code != "") || ok && fault.Code != test.code || taskservice.ThreadWriteOutcomeUnknown(test.err) != (test.code == "message_outcome_unknown") {
			t.Fatalf("classification: %#v, %t for %#v", fault, ok, test.err)
		}
		if ok && !errors.Is(fault, test.err) {
			t.Fatal("classification discarded original error chain")
		}
	}
}
