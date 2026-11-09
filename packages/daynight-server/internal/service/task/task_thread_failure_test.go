package task_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	threadcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/thread"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"

	"github.com/google/uuid"
)

type threadFailureFixture struct {
	base           taskMockBase
	project        model.Project
	task           model.Task
	principal      model.Principal
	message        model.ThreadMessage
	database       *taskStoreMock
	snapshot       *taskSnapshotScopeMock
	taskRead       *taskReaderMock
	readCredential *credentialReaderMock
	projectRead    *projectReaderMock
	scope          *taskThreadScopeMock
	taskWrite      *threadTaskMock
	credential     *threadCredentialMock
	projectWrite   *threadProjectMock
	thread         *threadDAOMock
	capture        *captureDAOMock
	service        *taskservice.TaskThreads
	call           func(context.Context, string) error
}

func newThreadFailureFixture(t *testing.T) *threadFailureFixture {
	t.Helper()
	project, target, principal := taskMockModels()
	f := &threadFailureFixture{base: newTaskMockBase(t, "thread"), project: project, task: target, principal: principal}
	f.message = model.ThreadMessage{ID: "66666666-6666-4666-8666-666666666666", TaskID: target.ID, Author: model.ThreadAuthor{UserID: principal.UserID}, Body: "Existing message", CreatedAt: target.UpdatedAt}
	f.call = func(ctx context.Context, _ string) error { return ctx.Err() }
	checkTask := func(ctx context.Context, stage, projectID, taskID string) error {
		t.Helper()
		if projectID != f.project.ID || taskID != f.task.ID {
			t.Fatalf("%s scope: project=%s task=%s", stage, projectID, taskID)
		}
		return f.call(ctx, stage)
	}
	checkPrincipal := func(ctx context.Context, stage string, actual model.Principal) error {
		t.Helper()
		if actual != f.principal {
			t.Fatalf("%s principal: %+v", stage, actual)
		}
		return f.call(ctx, stage)
	}
	f.database = &taskStoreMock{taskMockBase: f.base.withLabel("database")}
	f.snapshot = &taskSnapshotScopeMock{taskMockBase: f.base.withLabel("snapshot")}
	f.taskRead = &taskReaderMock{taskMockBase: f.base.withLabel("read-task")}
	f.readCredential = &credentialReaderMock{taskMockBase: f.base.withLabel("read-credential")}
	f.projectRead = &projectReaderMock{taskMockBase: f.base.withLabel("read-project")}
	f.scope = &taskThreadScopeMock{taskMockBase: f.base.withLabel("write-scope")}
	f.taskWrite = &threadTaskMock{taskMockBase: f.base.withLabel("write-task")}
	f.credential = &threadCredentialMock{taskMockBase: f.base.withLabel("write-credential")}
	f.projectWrite = &threadProjectMock{taskMockBase: f.base.withLabel("write-project")}
	f.thread = &threadDAOMock{taskMockBase: f.base.withLabel("thread-dao")}
	f.capture = &captureDAOMock{taskMockBase: f.base.withLabel("capture")}
	f.snapshot.TaskDAOFn = func() store.TaskReader { return f.taskRead }
	f.snapshot.CredentialDAOFn = func() store.CredentialReader { return f.readCredential }
	f.snapshot.ProjectDAOFn = func() store.ProjectReader { return f.projectRead }
	f.scope.TaskDAOFn = func() store.ThreadTaskDAO { return f.taskWrite }
	f.scope.CredentialDAOFn = func() store.ThreadCredentialDAO { return f.credential }
	f.scope.ProjectDAOFn = func() store.ThreadProjectDAO { return f.projectWrite }
	f.scope.ThreadDAOFn = func() store.ThreadDAO { return f.thread }
	f.scope.CaptureDAOFn = func() store.WebhookCaptureDAO { return f.capture }
	f.database.ReadSnapshotFn = func(ctx context.Context, work func(store.SnapshotScope) error) error { return work(f.snapshot) }
	f.database.WriteThreadFn = func(ctx context.Context, work func(store.ThreadScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionNotCommitted}, work(f.scope)
	}
	f.taskRead.TaskPresenceFn = func(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
		return store.TaskPresence{Found: true}, checkTask(ctx, "read-presence", projectID, taskID)
	}
	f.readCredential.CredentialFn = func(ctx context.Context, actual model.Principal) (store.ThreadCredential, error) {
		return store.ThreadCredential{}, checkPrincipal(ctx, "read-credential", actual)
	}
	f.projectRead.ProjectAccessFn = func(ctx context.Context, actual model.Principal, projectID string) (model.ProjectAccess, error) {
		if projectID != f.project.ID {
			t.Fatalf("read authorization project=%s", projectID)
		}
		return taskMockAccess(f.project, f.principal), checkPrincipal(ctx, "read-authorization", actual)
	}
	f.taskRead.ThreadMessageFn = func(ctx context.Context, taskID, messageID string) (model.ThreadMessage, error) {
		if taskID != f.task.ID || messageID != f.message.ID {
			t.Fatalf("read anchor: task=%s message=%s", taskID, messageID)
		}
		return f.message, f.call(ctx, "read-anchor")
	}
	f.taskRead.ThreadCandidatesFn = func(ctx context.Context, taskID string, _ *model.ThreadPosition, _ bool, _ int) ([]model.ThreadMessage, error) {
		if taskID != f.task.ID {
			t.Fatalf("candidate task=%s", taskID)
		}
		return []model.ThreadMessage{f.message}, f.call(ctx, "read-candidates")
	}
	f.taskRead.ThreadSidesFn = func(ctx context.Context, taskID string, first, last model.ThreadPosition) (bool, bool, error) {
		if taskID != f.task.ID || first != f.message.Position() || last != f.message.Position() {
			t.Fatalf("page sides: task=%s first=%+v last=%+v", taskID, first, last)
		}
		return false, false, f.call(ctx, "read-sides")
	}
	f.taskWrite.LockTaskPresenceFn = func(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
		return store.TaskPresence{Found: true}, checkTask(ctx, "presence", projectID, taskID)
	}
	f.credential.CredentialFn = func(ctx context.Context, actual model.Principal) (store.ThreadCredential, error) {
		return store.ThreadCredential{}, checkPrincipal(ctx, "credential", actual)
	}
	f.projectWrite.LockProjectAuthorizationFn = func(ctx context.Context, actual model.Principal, projectID string) (model.ProjectAccess, error) {
		if projectID != f.project.ID {
			t.Fatalf("write authorization project=%s", projectID)
		}
		return taskMockAccess(f.project, f.principal), checkPrincipal(ctx, "authorization", actual)
	}
	f.credential.AuthorNameFn = func(ctx context.Context, userID string) (*string, error) {
		if userID != f.principal.UserID {
			t.Fatalf("author user=%s", userID)
		}
		return nil, f.call(ctx, "author")
	}
	f.thread.LockHeadFn = func(ctx context.Context, taskID string) (*model.ThreadPosition, error) {
		if taskID != f.task.ID {
			t.Fatalf("head task=%s", taskID)
		}
		position := f.message.Position()
		return &position, f.call(ctx, "head")
	}
	f.thread.ThreadMessageFn = func(ctx context.Context, taskID, messageID string) (model.ThreadMessage, error) {
		if taskID != f.task.ID || messageID != f.message.ID {
			t.Fatalf("reply scope: task=%s message=%s", taskID, messageID)
		}
		return f.message, f.call(ctx, "reply")
	}
	f.thread.InsertMessageFn = func(ctx context.Context, message model.ThreadMessage) (model.ThreadMessage, error) {
		if message.TaskID != f.task.ID || message.Author.UserID != f.principal.UserID || message.ID != "" {
			t.Fatalf("candidate scope: %+v", message)
		}
		message.ID = "77777777-7777-4777-8777-777777777777"
		message.CreatedAt = f.task.UpdatedAt.Add(time.Millisecond)
		return message, f.call(ctx, "insert")
	}
	f.thread.PrepareTimestampFn = func(ctx context.Context, message *model.ThreadMessage, head *model.ThreadPosition) error {
		if message.ID == "" || head == nil || *head != f.message.Position() {
			t.Fatalf("timestamp candidate/head: %+v %+v", message, head)
		}
		return f.call(ctx, "timestamp")
	}
	f.credential.CredentialValidFn = func(ctx context.Context, _ store.ThreadCredential) (bool, error) {
		return true, f.call(ctx, "final-credential")
	}
	f.thread.AdvanceHeadFn = func(ctx context.Context, taskID string, position model.ThreadPosition) error {
		if taskID != f.task.ID || position.ID != "77777777-7777-4777-8777-777777777777" {
			t.Fatalf("advance scope: task=%s position=%+v", taskID, position)
		}
		return f.call(ctx, "advance")
	}
	f.capture.FreezeAudienceFn = func(ctx context.Context, projectID string, eventTypes []string) ([]store.WebhookAudience, error) {
		if projectID != f.project.ID || len(eventTypes) != 1 || eventTypes[0] != protocol.ThreadPosted {
			t.Fatalf("capture source: project=%s eventTypes=%v", projectID, eventTypes)
		}
		return []store.WebhookAudience{}, f.call(ctx, "capture")
	}
	f.service = taskservice.NewTaskThreads(f.database)
	return f
}

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
	message := model.ThreadMessage{
		ID: uuid.NewString(), CreatedAt: time.Now().UTC(), Body: strings.Repeat("<>&\u2028中文🌛", 1000),
		Author: model.ThreadAuthor{UserID: uuid.NewString()},
	}
	encoded, err := threadcore.AdmitMessage(ctx, message)
	if encoded != nil || !errors.Is(err, context.Canceled) || !errors.Is(parent.Err(), context.Canceled) {
		t.Fatalf("admission returned encoded bytes after cancellation: %d bytes, %v", len(encoded), err)
	}
}

func TestThreadCredentialIsRecheckedAfterHeadWait(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential} {
		t.Run(string(kind), func(t *testing.T) {
			f := newThreadFailureFixture(t)
			f.principal.Kind = kind
			expires := f.task.UpdatedAt.Add(time.Minute)
			locked := store.ThreadCredential{ExpiresAt: &expires}
			credentialReads, finalChecks := 0, 0
			f.credential.CredentialFn = func(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
				if principal != f.principal {
					t.Fatalf("credential principal=%+v", principal)
				}
				credentialReads++
				return locked, ctx.Err()
			}
			headEntered, releaseHead := make(chan struct{}), make(chan struct{})
			f.thread.LockHeadFn = func(ctx context.Context, taskID string) (*model.ThreadPosition, error) {
				if taskID != f.task.ID {
					t.Fatalf("head task=%s", taskID)
				}
				close(headEntered)
				select {
				case <-releaseHead:
					position := f.message.Position()
					return &position, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			f.credential.CredentialValidFn = func(ctx context.Context, credential store.ThreadCredential) (bool, error) {
				if credential != locked {
					t.Fatalf("final check lost locked credential: %+v", credential)
				}
				finalChecks++
				return false, ctx.Err()
			}
			f.thread.AdvanceHeadFn = nil
			f.capture.FreezeAudienceFn = nil
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			result := make(chan error, 1)
			go func() {
				document, err := f.service.Post(ctx, f.principal, f.project.ID, f.task.ID, taskservice.CreateThreadMessage{Body: "rejected after head wait"})
				if document.JSON != nil {
					result <- fmt.Errorf("expiry refusal returned a resource")
					return
				}
				result <- err
			}()
			select {
			case <-headEntered:
				close(releaseHead)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			select {
			case err := <-result:
				requireThreadFault(t, err, "unauthenticated")
				var attribution *taskservice.ThreadMessageError
				if !errors.As(err, &attribution) || attribution.Outcome != store.TransactionNotCommitted {
					t.Fatalf("expiry outcome: %#v %v", attribution, err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if credentialReads != 1 || finalChecks != 1 {
				t.Fatalf("credential checks: initial=%d final=%d", credentialReads, finalChecks)
			}
			f.readCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
				return store.ThreadCredential{}, model.ErrNotFound
			}
			f.taskRead.ThreadCandidatesFn = nil
			_, err := f.service.List(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.ThreadListRequest{})
			requireThreadFault(t, err, "unauthenticated")
		})
	}
}

func TestThreadCancellationBeforeCommitStopsAtEachDAOStage(t *testing.T) {
	for _, stage := range []string{"presence", "credential", "authorization", "author", "head", "reply", "insert", "timestamp", "final-credential", "advance"} {
		for _, after := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/after=%t", stage, after), func(t *testing.T) {
				f := newThreadFailureFixture(t)
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				fired := false
				f.call = func(actual context.Context, current string) error {
					if err := actual.Err(); err != nil {
						return err
					}
					if current == stage {
						fired = true
						cancel()
						if !after {
							return actual.Err()
						}
					}
					return nil
				}
				var callbackFailure error
				f.database.WriteThreadFn = func(_ context.Context, work func(store.ThreadScope) error) (store.Completion, error) {
					callbackFailure = work(f.scope)
					return store.Completion{Outcome: store.TransactionNotCommitted}, callbackFailure
				}
				document, err := f.service.Post(ctx, f.principal, f.project.ID, f.task.ID, taskservice.CreateThreadMessage{Body: "rejected", ReplyTo: &f.message.ID})
				var attribution *taskservice.ThreadMessageError
				if !fired || !errors.Is(callbackFailure, context.Canceled) || !errors.Is(err, context.Canceled) || document.JSON != nil || !errors.As(err, &attribution) || attribution.Outcome != store.TransactionNotCommitted {
					t.Fatalf("cancellation: fired=%t callback=%v document=%+v error=%v", fired, callbackFailure, document, err)
				}
				var transaction *store.ThreadTransactionError
				if errors.As(err, &transaction) && (transaction.CommitAttempted || transaction.OutcomeUnknown) {
					t.Fatalf("precommit cancellation became attempted commit: %+v", transaction)
				}
			})
		}
	}
}

func TestThreadReadCancellationAndServiceDeadlineAreBounded(t *testing.T) {
	for _, stage := range []string{"read-credential", "read-authorization", "read-presence", "read-anchor", "read-candidates", "read-sides"} {
		t.Run(stage, func(t *testing.T) {
			f := newThreadFailureFixture(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			fired := false
			f.call = func(actual context.Context, current string) error {
				if err := actual.Err(); err != nil {
					return err
				}
				if current == stage {
					fired = true
					cancel()
				}
				return nil
			}
			anchor := f.message
			anchor.ID = "88888888-8888-4888-8888-888888888888"
			anchor.CreatedAt = anchor.CreatedAt.Add(time.Millisecond)
			f.taskRead.ThreadMessageFn = func(actual context.Context, taskID, messageID string) (model.ThreadMessage, error) {
				if taskID != f.task.ID || messageID != anchor.ID {
					t.Fatalf("anchor scope: task=%s message=%s", taskID, messageID)
				}
				return anchor, f.call(actual, "read-anchor")
			}
			document, err := f.service.List(ctx, f.principal, f.project.ID, f.task.ID, taskservice.ThreadListRequest{BeforeID: &anchor.ID})
			if !fired || !errors.Is(err, context.Canceled) || document.JSON != nil {
				t.Fatalf("read cancellation: fired=%t document=%+v error=%v", fired, document, err)
			}
		})
	}
	for _, post := range []bool{false, true} {
		t.Run(fmt.Sprintf("deadline/post=%t", post), func(t *testing.T) {
			f := newThreadFailureFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
			defer cancel()
			parentDeadline, _ := ctx.Deadline()
			wait := func(actual context.Context) error {
				deadline, ok := actual.Deadline()
				if !ok || deadline.After(parentDeadline) {
					t.Fatalf("service extended parent deadline: %v %v", deadline, parentDeadline)
				}
				<-actual.Done()
				return actual.Err()
			}
			f.database.ReadSnapshotFn = func(actual context.Context, _ func(store.SnapshotScope) error) error { return wait(actual) }
			f.database.WriteThreadFn = func(actual context.Context, _ func(store.ThreadScope) error) (store.Completion, error) {
				return store.Completion{Outcome: store.TransactionNotCommitted}, wait(actual)
			}
			start := time.Now()
			var err error
			if post {
				_, err = f.service.Post(ctx, f.principal, f.project.ID, f.task.ID, taskservice.CreateThreadMessage{Body: "short parent"})
			} else {
				_, err = f.service.List(ctx, f.principal, f.project.ID, f.task.ID, taskservice.ThreadListRequest{})
			}
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
				t.Fatalf("parent deadline ignored: %v", err)
			}
		})
	}
}

func TestThreadReadDatabaseFailureAndCancellationAreVisible(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := threadcore.AdmitMessage(ctx, model.ThreadMessage{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("admission cancellation lost: %v", err)
	}
	if _, err := threadcore.SelectPage(ctx, []model.ThreadMessage{{ID: "id"}}, 1, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("selection cancellation lost: %v", err)
	}
	for _, cause := range []error{errors.New("thread query failed"), errors.New("thread store closed")} {
		f := newThreadFailureFixture(t)
		f.database.ReadSnapshotFn = func(context.Context, func(store.SnapshotScope) error) error { return cause }
		f.database.WriteThreadFn = func(context.Context, func(store.ThreadScope) error) (store.Completion, error) {
			return store.Completion{Outcome: store.TransactionNotCommitted}, cause
		}
		for _, post := range []bool{false, true} {
			var err error
			if post {
				_, err = f.service.Post(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.CreateThreadMessage{Body: "failed write"})
			} else {
				_, err = f.service.List(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.ThreadListRequest{})
			}
			var refusal *model.Fault
			if !errors.Is(err, cause) || errors.As(err, &refusal) {
				t.Fatalf("operational failure replaced: %v", err)
			}
		}
	}
}

func TestThreadPreCommitFailureExposesOnlyAvailableCandidateAttribution(t *testing.T) {
	f := newThreadFailureFixture(t)
	cause := errors.New("private head diagnostic")
	f.thread.AdvanceHeadFn = func(context.Context, string, model.ThreadPosition) error { return cause }
	f.capture.FreezeAudienceFn = nil
	document, err := f.service.Post(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.CreateThreadMessage{Body: "private body"})
	var attribution *taskservice.ThreadMessageError
	if !errors.Is(err, cause) || document.JSON != nil || !errors.As(err, &attribution) || attribution.MessageID == "" || attribution.Execution != nil || strings.Contains(err.Error(), "private") || attribution.Outcome != store.TransactionNotCommitted {
		t.Fatalf("failed attribution: %#v %v", attribution, err)
	}
	if _, parseErr := uuid.Parse(attribution.MessageID); parseErr != nil {
		t.Fatal(parseErr)
	}
}

func TestThreadReadSnapshotKeepsAuthorizationMessagesAndSidesConsistent(t *testing.T) {
	f := newThreadFailureFixture(t)
	reads := 0
	f.database.ReadSnapshotFn = func(_ context.Context, work func(store.SnapshotScope) error) error {
		reads++
		return work(f.snapshot)
	}
	presenceRead := false
	f.taskRead.TaskPresenceFn = func(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
		if projectID != f.project.ID || taskID != f.task.ID {
			t.Fatalf("presence scope: project=%s task=%s", projectID, taskID)
		}
		presenceRead = true
		return store.TaskPresence{Found: true}, ctx.Err()
	}
	page, err := f.service.List(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.ThreadListRequest{})
	if err != nil || reads != 1 || !presenceRead || len(page.Page.Items) != 1 || page.Page.Items[0].ID != f.message.ID || page.Page.HasMoreBefore || page.Page.HasMoreAfter {
		t.Fatalf("snapshot handoff: reads=%d page=%+v error=%v", reads, page.Page, err)
	}
	f.projectRead.ProjectAccessFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
		return model.ProjectAccess{}, model.ErrNotFound
	}
	f.taskRead.ThreadCandidatesFn = nil
	_, err = f.service.List(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.ThreadListRequest{})
	requireThreadFault(t, err, "forbidden")
	f.principal.UserID = "99999999-9999-4999-8999-999999999999"
	f.projectRead.ProjectAccessFn = func(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
		if principal != f.principal || projectID != f.project.ID {
			t.Fatal("later snapshot changed principal or Project")
		}
		return taskMockAccess(f.project, f.principal), ctx.Err()
	}
	f.taskRead.TaskPresenceFn = func(context.Context, string, string) (store.TaskPresence, error) {
		return store.TaskPresence{Found: true, DeletedAt: &f.task.UpdatedAt}, nil
	}
	_, err = f.service.List(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.ThreadListRequest{})
	requireThreadFault(t, err, "task_deleted")
	if reads != 3 {
		t.Fatalf("each read needs its own snapshot: %d", reads)
	}
}
