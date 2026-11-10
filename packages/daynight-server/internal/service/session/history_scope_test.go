package session

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func stopHistoryEngine(t *testing.T, engine *core.Engine) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engine.Stop(ctx); err != nil {
		t.Fatalf("history scope retained its operation: %v", err)
	}
}

func TestHistoryScopeOrdersAdmissionAndPreservesCompletion(t *testing.T) {
	for _, kind := range []string{"query", "content", "archive"} {
		steps := []string{"task", "credential", "project", "load"}
		if kind != "query" {
			steps = append(steps, "bind")
		}
		steps = append(steps, "work")
		for _, failure := range append(slices.Clone(steps), "", "not_committed", "unknown", "cleanup", "panic") {
			t.Run(kind+"/"+failure, func(t *testing.T) {
				ctx := t.Context()
				actor := model.Principal{Kind: model.OAuthCredential, UserID: "reader", CredentialID: "credential"}
				scope := &archiveCompletionOrderScope{}
				task, access := &core.TaskAccess{}, &core.Access{}
				cause := errors.New("history scope failure")
				var calls []string
				var operation *core.Operation
				active := false
				checkOperation := func(op *core.Operation) {
					t.Helper()
					if !active || op == nil {
						t.Fatal("core operation escaped its transaction")
					}
					if operation == nil {
						operation = op
					} else if operation != op {
						t.Fatal("transaction operation changed")
					}
				}
				checkScope := func(op *core.Operation, actual context.Context, transaction store.SessionScope) {
					t.Helper()
					checkOperation(op)
					if actual != ctx || transaction != scope {
						t.Fatal("core operation lost context or transaction binding")
					}
				}
				step := func(name string) error {
					t.Helper()
					if len(calls) >= len(steps) || steps[len(calls)] != name {
						t.Fatalf("unexpected operation %s after %v", name, calls)
					}
					calls = append(calls, name)
					if failure == name {
						return cause
					}
					return nil
				}
				writerCalls := 0
				writer := archiveCompletionOrderWriter(func(actual context.Context, run func(store.SessionScope) error) (store.Completion, error) {
					writerCalls++
					if actual != ctx || writerCalls != 1 {
						t.Fatal("transaction lost context or retried")
					}
					active = true
					defer func() { active = false }()
					if err := run(scope); err != nil {
						return store.Completion{Outcome: store.TransactionNotCommitted}, err
					}
					switch failure {
					case "not_committed":
						return store.Completion{Outcome: store.TransactionNotCommitted}, nil
					case "unknown":
						return store.Completion{Outcome: store.TransactionUnknown}, nil
					case "cleanup":
						return store.Completion{Outcome: store.TransactionCommitted}, cause
					case "panic":
						panic(cause)
					default:
						return store.Completion{Outcome: store.TransactionCommitted}, nil
					}
				})
				engine := core.NewEngine(nil)
				t.Cleanup(func() { stopHistoryEngine(t, engine) })
				s := New(writer, engine)
				s.historyOps = historyScopeOperations{
					lockTask: func(op *core.Operation, actual context.Context, transaction store.SessionScope, project, id string) (*core.TaskAccess, error) {
						checkScope(op, actual, transaction)
						if project != "project" || id != "task" {
							t.Fatal("task identity changed")
						}
						return task, step("task")
					},
					credential: func(op *core.Operation, actual context.Context, transaction store.SessionScope, p model.Principal) error {
						checkScope(op, actual, transaction)
						if p != actor {
							t.Fatal("credential principal changed")
						}
						return step("credential")
					},
					project: func(op *core.Operation, actual context.Context, transaction store.SessionScope, p model.Principal, project string) error {
						checkScope(op, actual, transaction)
						if p != actor || project != "project" {
							t.Fatal("project principal or identity changed")
						}
						return step("project")
					},
					load: func(actual context.Context, op *core.Operation, transaction store.SessionScope, id string) (*core.Access, error) {
						checkScope(op, actual, transaction)
						if id != "session" {
							t.Fatal("session identity changed")
						}
						return access, step("load")
					},
					bindRead: func(op *core.Operation, a *core.Access, taskAccess *core.TaskAccess, project, id string) error {
						checkOperation(op)
						if kind != "content" || a != access || taskAccess != task || project != "project" || id != "task" {
							t.Fatal("unexpected content admission")
						}
						return step("bind")
					},
					bindArchive: func(op *core.Operation, a *core.Access, taskAccess *core.TaskAccess, p model.Principal, project, id string, deleted bool) error {
						checkOperation(op)
						if kind != "archive" || a != access || taskAccess != task || p != actor || project != "project" || id != "task" || deleted {
							t.Fatal("archive read broadened its authority or changed binding")
						}
						return step("bind")
					},
				}
				work := func(actual *core.Access) error {
					if actual != access || !active {
						t.Fatal("work lost its transaction access")
					}
					return step("work")
				}
				var err error
				var caught any
				func() {
					defer func() { caught = recover() }()
					switch kind {
					case "content":
						err = s.taskContentRead(ctx, actor, "project", "task", "session", work)
					case "archive":
						err = s.taskArchiveRead(ctx, actor, "project", "task", "session", true, work)
					case "query":
						err = s.taskReadQuery(ctx, actor, "project", "task", func(op *core.Operation, transaction store.SessionScope, taskAccess *core.TaskAccess, load func(string) (*core.Access, error)) error {
							checkScope(op, ctx, transaction)
							if taskAccess != task {
								t.Fatal("query task binding changed")
							}
							a, err := load("session")
							if err != nil {
								return err
							}
							return work(a)
						})
					}
				}()
				if failure == "panic" {
					if caught != cause {
						t.Fatalf("panic changed: %v", caught)
					}
				} else if caught != nil {
					t.Fatalf("unexpected panic: %v", caught)
				} else if failure == "" {
					if err != nil {
						t.Fatal(err)
					}
				} else if failure == "unknown" || failure == "not_committed" {
					if err == nil {
						t.Fatal("unconfirmed transaction reported success")
					}
				} else if !errors.Is(err, cause) {
					t.Fatalf("operation cause lost: %v", err)
				}
				want := steps
				if index := slices.Index(steps, failure); index >= 0 {
					want = steps[:index+1]
				}
				if writerCalls != 1 || !reflect.DeepEqual(calls, want) {
					t.Fatalf("calls %v want %v; writer %d", calls, want, writerCalls)
				}
			})
		}
	}
}

func TestHistoryScopeRejectsMissingTaskAndStoppedEngineBeforeTransaction(t *testing.T) {
	for _, scenario := range []string{"no_project", "no_task", "no_scope", "stopped"} {
		t.Run(scenario, func(t *testing.T) {
			engine := core.NewEngine(nil)
			t.Cleanup(func() { stopHistoryEngine(t, engine) })
			s := New(archiveCompletionOrderWriter(func(context.Context, func(store.SessionScope) error) (store.Completion, error) {
				t.Fatal("refused history scope opened a transaction")
				return store.Completion{}, nil
			}), engine)
			project, task := "project", "task"
			if scenario == "no_project" || scenario == "no_scope" {
				project = ""
			}
			if scenario == "no_task" || scenario == "no_scope" {
				task = ""
			}
			code := "forbidden"
			if scenario == "stopped" {
				stopHistoryEngine(t, engine)
				code = "service_unavailable"
			}
			err := s.taskReadQuery(t.Context(), model.Principal{}, project, task, func(*core.Operation, store.SessionScope, *core.TaskAccess, func(string) (*core.Access, error)) error {
				t.Fatal("refused history scope ran work")
				return nil
			})
			requireHistoryFault(t, err, code)
		})
	}
}
