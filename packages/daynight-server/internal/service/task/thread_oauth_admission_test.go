package task_test

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestOAuthThreadCredentialRefusalStopsBeforeBusinessWork(t *testing.T) {
	for _, name := range []string{"forged", "expired while waiting", "revoke wait", "revoked"} {
		t.Run(name, func(t *testing.T) {
			principal := model.Principal{Kind: model.OAuthCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "f6666666-6666-4666-8666-666666666666"}
			if name == "forged" {
				principal.CredentialID = "f3333333-3333-4333-8333-333333333333"
			}
			const project = "d1111111-1111-4111-8111-111111111111"
			const task = "e2222222-2222-4222-8222-222222222222"
			base := newTaskMockBase(t, "oauth-thread")
			database := &taskStoreMock{taskMockBase: base.withLabel("database")}
			scope := &taskThreadScopeMock{taskMockBase: base.withLabel("scope")}
			tasks := &threadTaskMock{taskMockBase: base.withLabel("task")}
			credentials := &threadCredentialMock{taskMockBase: base.withLabel("credential")}
			active := false
			var scopeContext context.Context
			var events []string
			check := func(ctx context.Context, event string) {
				t.Helper()
				if !active || ctx != scopeContext || ctx.Err() != nil {
					t.Fatalf("%s outside active scope: %v", event, ctx.Err())
				}
				events = append(events, event)
			}
			scope.TaskDAOFn = func() store.ThreadTaskDAO { return tasks }
			scope.CredentialDAOFn = func() store.ThreadCredentialDAO { return credentials }
			entered, release := make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			tasks.LockTaskPresenceFn = func(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
				check(ctx, "presence")
				if projectID != project || taskID != task {
					t.Fatalf("presence scope: %s/%s", projectID, taskID)
				}
				if name == "expired while waiting" {
					close(entered)
					select {
					case <-release:
					case <-ctx.Done():
						return store.TaskPresence{}, ctx.Err()
					}
				}
				return store.TaskPresence{Found: true}, nil
			}
			credentials.CredentialFn = func(ctx context.Context, actual model.Principal) (store.ThreadCredential, error) {
				check(ctx, "credential")
				if actual != principal || !slices.Equal(events, []string{"presence", "credential"}) {
					t.Fatalf("initial credential: principal=%+v order=%v", actual, events)
				}
				return store.ThreadCredential{}, model.ErrNotFound
			}
			callbackExpectedCause := model.ErrNotFound
			completion := store.Completion{Outcome: store.TransactionNotCommitted}
			finalError := model.Unauthenticated(model.ErrNotFound)
			database.WriteThreadFn = func(ctx context.Context, work func(store.ThreadScope) error) (store.Completion, error) {
				if active || len(events) != 0 || ctx.Err() != nil {
					t.Fatalf("unexpected write: active=%t events=%v error=%v", active, events, ctx.Err())
				}
				active, scopeContext = true, ctx
				callbackError := work(scope)
				active = false
				var fault *model.Fault
				if !errors.Is(callbackError, callbackExpectedCause) || !errors.As(callbackError, &fault) || fault.Code != "unauthenticated" {
					t.Fatalf("callback credential refusal: %v", callbackError)
				}
				return completion, finalError
			}
			threads := taskservice.NewTaskThreads(database)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			type result struct {
				document taskservice.ThreadMessageDocument
				err      error
			}
			finished := make(chan result, 1)
			joined := false
			t.Cleanup(func() {
				unblock()
				cancel()
				if !joined {
					select {
					case <-finished:
					case <-time.After(5 * time.Second):
						t.Error("OAuth Thread writer did not exit")
					}
				}
			})
			go func() {
				document, err := threads.Post(ctx, principal, project, task, taskservice.CreateThreadMessage{Body: name})
				finished <- result{document, err}
			}()
			if name == "expired while waiting" {
				select {
				case <-entered:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				unblock()
			}
			select {
			case got := <-finished:
				joined = true
				var failure *taskservice.ThreadMessageError
				if !reflect.DeepEqual(got.document, taskservice.ThreadMessageDocument{}) || !errors.Is(got.err, finalError) || !errors.As(got.err, &failure) || failure.Outcome != completion.Outcome || failure.MessageID != "" || failure.Execution != nil {
					t.Fatalf("credential refusal result: %+v error=%v", got.document, got.err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if !slices.Equal(events, []string{"presence", "credential"}) || active {
				t.Fatalf("credential refusal entered business work: %v active=%t", events, active)
			}
		})
	}
}
