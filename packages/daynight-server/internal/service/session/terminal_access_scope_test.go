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

type terminalAccessDAO struct {
	store.SessionDAO
	t       *testing.T
	ctx     context.Context
	actor   model.Principal
	failure string
	cause   error
	calls   []string
}

func (d *terminalAccessDAO) step(name string) error {
	d.calls = append(d.calls, name)
	if d.failure == name {
		return d.cause
	}
	return nil
}
func (d *terminalAccessDAO) LockArchiveTask(ctx context.Context, project, task string) (store.SessionTask, bool, error) {
	if ctx != d.ctx || project != "project" || task != "task" {
		d.t.Fatal("task scope changed")
	}
	return store.SessionTask{}, false, d.step("task")
}
func (d *terminalAccessDAO) LockCredential(ctx context.Context, actor model.Principal, now time.Time) error {
	if ctx != d.ctx || actor != d.actor || now.IsZero() {
		d.t.Fatal("credential scope changed")
	}
	return d.step("credential")
}
func (d *terminalAccessDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	if ctx != d.ctx || user != d.actor.UserID || project != "project" {
		d.t.Fatal("project scope changed")
	}
	return model.ProjectAccess{}, d.step("project")
}
func (d *terminalAccessDAO) LockTerminal(ctx context.Context, id string) ([]byte, error) {
	if ctx != d.ctx || id != "session" {
		d.t.Fatal("session scope changed")
	}
	if err := d.step("load"); err != nil {
		return nil, err
	}
	if d.failure == "bind" {
		return []byte(`{"Owner":{"projectId":"other","taskId":"task"}}`), nil
	}
	return []byte(`{"Owner":{"projectId":"project","taskId":"task","ownerUserId":"reader"}}`), nil
}

type terminalAccessScope struct {
	store.SessionScope
	dao *terminalAccessDAO
}

func (s terminalAccessScope) SessionDAO() store.SessionDAO { return s.dao }
func (s terminalAccessScope) BotDAO() store.BotWriteDAO    { return nil }

func TestTerminalHistoryScopeStopsBeforeWorkOnFailure(t *testing.T) {
	for _, failure := range []string{"", "task", "credential", "project", "load", "bind", "work"} {
		t.Run(failure, func(t *testing.T) {
			ctx := t.Context()
			actor := model.Principal{Kind: model.PATCredential, UserID: "reader", CredentialID: "credential"}
			cause := errors.New("scope operation failed")
			dao := &terminalAccessDAO{t: t, ctx: ctx, actor: actor, failure: failure, cause: cause}
			scope := terminalAccessScope{dao: dao}
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
			var err error
			err = s.terminalHistory(ctx, actor, "project", "task", "session", true, func(access *core.TerminalHistoryAccess) error {
				if access == nil {
					t.Fatal("missing transaction-bound access")
				}
				return dao.step("work")
			})
			if failure == "bind" {
				requireServiceError(t, err, "session_conflict")
			} else if failure == "" && err != nil || failure != "" && !errors.Is(err, cause) {
				t.Fatalf("unexpected result: %v", err)
			}
			want := []string{"task", "credential", "project", "load", "work"}
			stop := failure
			if stop == "bind" {
				stop = "load"
			}
			for i, step := range want {
				if step == stop {
					want = want[:i+1]
					break
				}
			}
			if !reflect.DeepEqual(dao.calls, want) {
				t.Fatalf("calls %v, want %v", dao.calls, want)
			}
		})
	}
}
