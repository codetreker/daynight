package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type terminalDirectoryScope struct {
	store.SessionScope
	dao *terminalDirectoryDAO
}

func (s terminalDirectoryScope) SessionDAO() store.SessionDAO { return s.dao }
func (s terminalDirectoryScope) BotDAO() store.BotWriteDAO    { return nil }

type terminalDirectoryDAO struct {
	store.SessionDAO
	t       *testing.T
	ctx     context.Context
	actor   model.Principal
	failure string
	cause   error
	calls   []string
}

func (d *terminalDirectoryDAO) step(name string) error {
	d.calls = append(d.calls, name)
	if d.failure == name {
		return d.cause
	}
	return nil
}
func (d *terminalDirectoryDAO) LockTask(ctx context.Context, project, task string) (store.SessionTask, error) {
	if ctx != d.ctx || project != "project" || task != "task" {
		d.t.Fatal("task scope changed")
	}
	return store.SessionTask{}, d.step("task")
}
func (d *terminalDirectoryDAO) LockCredential(ctx context.Context, actor model.Principal, now time.Time) error {
	if ctx != d.ctx || actor != d.actor || now.IsZero() {
		d.t.Fatal("credential scope changed")
	}
	return d.step("credential")
}
func (d *terminalDirectoryDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	if ctx != d.ctx || user != d.actor.UserID || project != "project" {
		d.t.Fatal("project scope changed")
	}
	return model.ProjectAccess{}, d.step("project")
}

func TestTerminalDirectoryChecksScopeBeforeWork(t *testing.T) {
	for _, failure := range []string{"", "task", "credential", "project", "work"} {
		t.Run(failure, func(t *testing.T) {
			ctx := t.Context()
			actor := model.Principal{Kind: model.PATCredential, UserID: "reader", CredentialID: "credential"}
			cause := errors.New("admission failed")
			dao := &terminalDirectoryDAO{t: t, ctx: ctx, actor: actor, failure: failure, cause: cause}
			scope := terminalDirectoryScope{dao: dao}
			writer := archiveCompletionOrderWriter(func(actual context.Context, run func(store.SessionScope) error) (store.Completion, error) {
				if actual != ctx {
					t.Fatal("writer context changed")
				}
				if err := run(scope); err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			})
			engine := core.NewEngine(nil)
			t.Cleanup(func() { stopHistoryEngine(t, engine) })
			s := New(writer, engine)
			err := s.terminalDirectory(ctx, actor, "project", "task", func(op *core.Operation, actual store.SessionScope, task *core.TaskAccess) error {
				if op == nil || actual != scope || task == nil {
					t.Fatal("work lost transaction scope")
				}
				return dao.step("work")
			})
			if failure == "" && err != nil || failure != "" && !errors.Is(err, cause) {
				t.Fatalf("unexpected result: %v", err)
			}
			want := []string{"task", "credential", "project", "work"}
			if failure != "" {
				for i, step := range want {
					if step == failure {
						want = want[:i+1]
						break
					}
				}
			}
			if !reflect.DeepEqual(dao.calls, want) {
				t.Fatalf("calls %v, want %v", dao.calls, want)
			}
		})
	}
}
