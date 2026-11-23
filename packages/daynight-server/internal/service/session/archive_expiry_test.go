package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type expiryReadDAO struct {
	store.SessionDAO
	read func(context.Context, string) (bool, error)
}

func (d expiryReadDAO) SessionArchiveExpired(c context.Context, id string) (bool, error) {
	return d.read(c, id)
}
func TestRequireArchiveReadable(t *testing.T) {
	failure := errors.New("expiry lookup failed")
	for _, tc := range []struct {
		name    string
		expired bool
		err     error
	}{{"readable", false, nil}, {"expired", true, nil}, {"lookup failure", false, failure}} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			ctx := t.Context()
			err := requireArchiveReadable(ctx, expiryReadDAO{read: func(c context.Context, id string) (bool, error) {
				calls++
				if c != ctx || id != "session" {
					t.Fatal("wrong lookup")
				}
				return tc.expired, tc.err
			}}, "session")
			if calls != 1 {
				t.Fatal("lookup count")
			}
			if tc.err != nil {
				if !errors.Is(err, tc.err) {
					t.Fatalf("lost cause %v", err)
				}
				return
			}
			if tc.expired {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "history_unavailable" {
					t.Fatalf("wrong refusal %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
	if err := requireArchiveReadable(t.Context(), nil, "legacy"); err != nil {
		t.Fatal(err)
	}
}

type expiryAdmissionDAO struct {
	*scopeTestDAO
	check func(context.Context, string) (bool, error)
}

func (d expiryAdmissionDAO) SessionArchiveExpired(c context.Context, id string) (bool, error) {
	return d.check(c, id)
}
func (d expiryAdmissionDAO) LockArchiveTask(c context.Context, p, id string) (store.SessionTask, bool, error) {
	v, e := d.LockTask(c, p, id)
	return v, false, e
}
func (d expiryAdmissionDAO) SessionLocation(context.Context, string) (store.SessionLocation, error) {
	return store.SessionLocation{ProjectID: "project", TaskID: "task", SessionID: "session"}, nil
}

type expiryAdmissionScope struct {
	store.SessionScope
	dao store.SessionDAO
}

func (s expiryAdmissionScope) SessionDAO() store.SessionDAO { return s.dao }
func (s expiryAdmissionScope) BotDAO() store.BotWriteDAO    { return nil }

func TestArchiveExpiryAdmissionFollowsBindingAndPreservesReceipts(t *testing.T) {
	for _, kind := range []string{"browser", "archive", "receipt"} {
		for _, wrongBinding := range []bool{false, true} {
			t.Run(kind+map[bool]string{false: "/expired", true: "/wrong identity"}[wrongBinding], func(t *testing.T) {
				ctx := t.Context()
				var calls []string
				actor := model.Principal{Kind: model.PATCredential, UserID: "owner", CredentialID: "browser"}
				snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: "session", ClaimID: "claim"}}, Identity: sp.Identity{ProjectID: "project", TaskID: "task"}, Lifecycle: "archived"}
				if wrongBinding {
					snapshot.Identity.TaskID = "other"
				}
				base := &scopeTestDAO{calls: &calls, task: store.SessionTask{Status: "done", Worker: &model.WorkerClaim{ClaimID: "claim", AgentControlMode: model.AgentControlModeWeb}}, record: store.SessionRecord{Snapshot: snapshot, Owner: actor.UserID}}
				checks, work := 0, 0
				dao := expiryAdmissionDAO{scopeTestDAO: base, check: func(c context.Context, id string) (bool, error) {
					checks++
					if c != ctx || id != "session" {
						t.Fatal("wrong expiry identity")
					}
					calls = append(calls, "expiry")
					return true, nil
				}}
				scope := expiryAdmissionScope{dao: dao}
				writer := archiveCompletionOrderWriter(func(c context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
					if c != ctx {
						t.Fatal("lost context")
					}
					return store.Completion{Outcome: store.TransactionCommitted}, fn(scope)
				})
				engine := core.NewEngine(nil)
				t.Cleanup(func() { stopHistoryEngine(t, engine) })
				s := New(writer, engine)
				fn := func(*core.Access) error { work++; return nil }
				var err error
				if kind == "archive" {
					err = s.archive(ctx, actor, "project", "task", "session", true, fn)
				} else {
					purpose := core.BrowserAccess
					if kind == "receipt" {
						purpose = core.TaskReceiptAccess
					}
					err = s.browserFor(ctx, actor, "project", "task", "session", purpose, fn)
				}
				if wrongBinding {
					if err == nil || checks != 0 || work != 0 {
						t.Fatalf("binding failed open %d %d %v", checks, work, err)
					}
					return
				}
				if kind == "receipt" {
					if err != nil || checks != 0 || work != 1 {
						t.Fatalf("receipt blocked %d %d %v", checks, work, err)
					}
					return
				}
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "history_unavailable" || checks != 1 || work != 0 {
					t.Fatalf("expiry refusal %d %d %v", checks, work, err)
				}
				if !reflect.DeepEqual(calls, []string{"task", "credential:browser", "project", "association", "session", "expiry"}) {
					t.Fatalf("admission order %v", calls)
				}
			})
		}
	}
}

func TestHistoryExpiryChecksContentButPreservesSummaryQueries(t *testing.T) {
	for _, kind := range []string{"content", "archive", "query"} {
		for _, bindFailure := range []bool{false, true} {
			t.Run(kind+map[bool]string{false: "/expired", true: "/binding failure"}[bindFailure], func(t *testing.T) {
				ctx := t.Context()
				actor := model.Principal{Kind: model.PATCredential, UserID: "owner"}
				bound, checks, work := false, 0, 0
				cause := errors.New("binding refused")
				dao := expiryReadDAO{read: func(c context.Context, id string) (bool, error) {
					checks++
					if !bound || c != ctx || id != "session" {
						t.Fatal("expiry escaped authorized binding")
					}
					return true, nil
				}}
				scope := expiryAdmissionScope{dao: dao}
				engine := core.NewEngine(nil)
				t.Cleanup(func() { stopHistoryEngine(t, engine) })
				s := New(archiveCompletionOrderWriter(func(c context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
					return store.Completion{Outcome: store.TransactionCommitted}, fn(scope)
				}), engine)
				task, access := &core.TaskAccess{}, &core.Access{}
				bind := func() error {
					if bindFailure {
						return cause
					}
					bound = true
					return nil
				}
				s.historyOps = historyScopeOperations{
					lockTask: func(*core.Operation, context.Context, store.SessionScope, string, string) (*core.TaskAccess, error) {
						return task, nil
					},
					credential: func(*core.Operation, context.Context, store.SessionScope, model.Principal) error { return nil },
					project:    func(*core.Operation, context.Context, store.SessionScope, model.Principal, string) error { return nil },
					load: func(context.Context, sessionAccessOperation, store.SessionScope, string) (*core.Access, error) {
						return access, nil
					},
					bindRead: func(*core.Operation, *core.Access, *core.TaskAccess, string, string) error { return bind() },
					bindArchive: func(*core.Operation, *core.Access, *core.TaskAccess, model.Principal, string, string, bool) error {
						return bind()
					},
				}
				fn := func(*core.Access) error { work++; return nil }
				var err error
				switch kind {
				case "content":
					err = s.taskContentRead(ctx, actor, "project", "task", "session", core.BrowserAccess, fn)
				case "archive":
					err = s.taskArchiveRead(ctx, actor, "project", "task", "session", false, fn)
				case "query":
					err = s.taskReadQuery(ctx, actor, "project", "task", func(_ *core.Operation, _ store.SessionScope, _ *core.TaskAccess, load func(string) (*core.Access, error)) error {
						a, e := load("session")
						if e != nil {
							return e
						}
						return fn(a)
					})
				}
				if kind == "query" {
					if err != nil || checks != 0 || work != 1 {
						t.Fatalf("summary blocked %d %d %v", checks, work, err)
					}
					return
				}
				if bindFailure {
					if !errors.Is(err, cause) || checks != 0 || work != 0 {
						t.Fatalf("binding failure leaked expiry %v", err)
					}
					return
				}
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "history_unavailable" || checks != 1 || work != 0 {
					t.Fatalf("content admitted %d %d %v", checks, work, err)
				}
			})
		}
	}
}
