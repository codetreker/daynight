package runtime

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

var errRuntimeStage = errors.New("runtime stage failed")

type runtimeScope struct {
	store.SessionScope
	fixture *runtimeFixture
}

func (s *runtimeScope) BotDAO() store.BotWriteDAO {
	s.fixture.called("botDAO")
	return s.fixture.dao
}

type runtimeBotDAO struct {
	store.BotWriteDAO
	fixture *runtimeFixture
}

func (d *runtimeBotDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	f := d.fixture
	f.called("bot")
	f.context(ctx)
	if id != f.id {
		f.t.Errorf("Bot ID = %q, want %q", id, f.id)
	}
	bot := f.bot
	if bot.SessionID != nil {
		id := *bot.SessionID
		bot.SessionID = &id
	}
	bot.ResolvedConfiguration.Args = slices.Clone(bot.ResolvedConfiguration.Args)
	if bot.Deletion != nil {
		deletion := *bot.Deletion
		bot.Deletion = &deletion
	}
	return bot, f.errors["bot"]
}

type runtimeFixture struct {
	t           *testing.T
	ctx         context.Context
	principal   model.Principal
	workerID    string
	id          string
	bot         model.Bot
	op          *sessioncore.Operation
	access      *sessioncore.Access
	authority   sessioncore.Authority
	scope       *runtimeScope
	dao         *runtimeBotDAO
	credentials []model.Principal
	locks       int
	want        []string
	calls       []string
	errors      map[string]error
	beginResult *sessioncore.Operation
}

func newRuntimeFixture(t *testing.T, want ...string) *runtimeFixture {
	t.Helper()
	p := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	sessionID := "55555555-5555-4555-8555-555555555555"
	f := &runtimeFixture{
		t: t, ctx: t.Context(), principal: p,
		workerID: "33333333-3333-4333-8333-333333333333", id: "44444444-4444-4444-8444-444444444444",
		op: &sessioncore.Operation{}, access: &sessioncore.Access{},
		authority: sessioncore.Authority{Test: true, OwnerID: p.UserID, ParentCredentialID: p.CredentialID},
		want:      slices.Clone(want), errors: map[string]error{},
	}
	f.bot = model.Bot{ID: f.id, OwnerUserID: p.UserID, WorkerID: f.workerID, Name: "Bound Bot", Version: 7, SessionID: &sessionID,
		ResolvedConfiguration: model.BotConfiguration{WorkerID: f.workerID, Cwd: "/ordinary/directory", Provider: "codex", Args: []string{"--sandbox"}},
	}
	f.beginResult = f.op
	f.scope = &runtimeScope{fixture: f}
	f.dao = &runtimeBotDAO{fixture: f}
	t.Cleanup(func() {
		if !slices.Equal(f.calls, f.want) {
			t.Errorf("runtime calls = %v, want %v", f.calls, f.want)
		}
		if f.locks != len(f.credentials) {
			t.Errorf("credential calls = %d, want %d", f.locks, len(f.credentials))
		}
	})
	return f
}

func (f *runtimeFixture) called(name string) {
	f.t.Helper()
	index := len(f.calls)
	f.calls = append(f.calls, name)
	if index >= len(f.want) || name != f.want[index] {
		f.t.Errorf("unexpected runtime call %q at %d; want %v", name, index, f.want)
	}
}

func (f *runtimeFixture) context(ctx context.Context) {
	f.t.Helper()
	if ctx != f.ctx {
		f.t.Error("runtime changed the context")
	}
}

func (f *runtimeFixture) operation(op *sessioncore.Operation) {
	f.t.Helper()
	if op != f.op {
		f.t.Error("runtime changed the Operation")
	}
}

func (f *runtimeFixture) botValue(bot model.Bot) {
	f.t.Helper()
	if !reflect.DeepEqual(bot, f.bot) {
		f.t.Errorf("runtime changed the Bot: %+v", bot)
	}
}

func (f *runtimeFixture) runtime() *Runtime {
	return &Runtime{core: coreOperations{
		beginOperation: func() (*sessioncore.Operation, error) {
			f.called("begin")
			return f.beginResult, f.errors["begin"]
		},
		closeOperation: func(op *sessioncore.Operation) {
			f.called("close")
			f.operation(op)
		},
		lockCredential: func(op *sessioncore.Operation, ctx context.Context, scope store.SessionScope, p model.Principal) error {
			f.locks++
			name := fmt.Sprintf("credential%d", f.locks)
			f.called(name)
			f.operation(op)
			f.context(ctx)
			if scope != f.scope {
				f.t.Error("credential check changed the transaction scope")
			}
			if f.locks > len(f.credentials) || p != f.credentials[f.locks-1] {
				f.t.Errorf("unexpected credential %d: %+v; want %v", f.locks, p, f.credentials)
			}
			return f.errors[name]
		},
		authorizeRuntime: func(bot model.Bot, owner, worker string) error {
			f.called("authorize")
			f.botValue(bot)
			if owner != f.principal.UserID || worker != f.workerID {
				f.t.Errorf("runtime authorization changed owner/worker: %q %q", owner, worker)
			}
			return f.errors["authorize"]
		},
		checkBot: func(op *sessioncore.Operation, id string, bot *model.Bot) error {
			f.called("checkBot")
			f.operation(op)
			if id != *f.bot.SessionID {
				f.t.Errorf("binding check changed Session ID: %q", id)
			}
			f.botValue(*bot)
			return f.errors["checkBot"]
		},
		load: func(op *sessioncore.Operation, ctx context.Context, scope store.SessionScope, id string, bot *model.Bot) (*sessioncore.Access, error) {
			f.called("load")
			f.operation(op)
			f.context(ctx)
			if scope != f.scope || id != *f.bot.SessionID {
				f.t.Error("Session load changed the scope or ID")
			}
			f.botValue(*bot)
			return f.access, f.errors["load"]
		},
		checkTestOwner: func(op *sessioncore.Operation, access *sessioncore.Access, p model.Principal) error {
			f.called("checkOwner")
			f.operation(op)
			if access != f.access || p != f.principal {
				f.t.Error("owner check changed the Access or principal")
			}
			return f.errors["checkOwner"]
		},
		authority: func(access *sessioncore.Access) sessioncore.Authority {
			f.called("authority")
			if access != f.access {
				f.t.Error("authority read changed the Access")
			}
			return f.authority
		},
	}, write: func(ctx context.Context, op *sessioncore.Operation, callback func(store.SessionScope) error) error {
		f.called("write")
		f.context(ctx)
		f.operation(op)
		return callback(f.scope)
	}}
}

func (f *runtimeFixture) prepare(bot model.Bot) error {
	f.called("prepare")
	f.botValue(bot)
	return f.errors["prepare"]
}

func (f *runtimeFixture) check(bot model.Bot, access *sessioncore.Access) error {
	f.called("check")
	f.botValue(bot)
	if access != f.access {
		f.t.Error("binding callback changed the Access")
	}
	return f.errors["check"]
}

func (f *runtimeFixture) work(recheck bool) func(*sessioncore.Operation, store.SessionScope, model.Bot, *sessioncore.Access, func(model.Principal) error) error {
	return func(op *sessioncore.Operation, scope store.SessionScope, bot model.Bot, access *sessioncore.Access, check func(model.Principal) error) error {
		f.called("work")
		f.operation(op)
		f.botValue(bot)
		if scope != f.scope || access != f.access {
			f.t.Error("work changed the scope or Access")
		}
		if recheck {
			return check(f.principal)
		}
		return nil
	}
}

func requireRuntimeFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func TestRuntimeLocksCredentialBotSessionAndRechecksCredentials(t *testing.T) {
	f := newRuntimeFixture(t, "begin", "write", "credential1", "botDAO", "bot", "authorize", "checkBot", "load", "credential2", "checkOwner", "authority", "credential3", "work", "close")
	parent := f.principal
	f.principal.CredentialID = "66666666-6666-4666-8666-666666666666"
	f.credentials = []model.Principal{f.principal, f.principal, parent}
	if err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(false)); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeUsesBoundBotAndRechecksCredential(t *testing.T) {
	t.Run("callbacks", func(t *testing.T) {
		f := newRuntimeFixture(t, "begin", "write", "credential1", "botDAO", "bot", "authorize", "prepare", "checkBot", "load", "check", "credential2", "checkOwner", "authority", "credential3", "work", "credential4", "close")
		f.credentials = []model.Principal{f.principal, f.principal, f.principal, f.principal}
		if err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, f.prepare, f.check, f.work(true)); err != nil {
			t.Fatal(err)
		}
	})
	for _, stage := range []string{"prepare", "check"} {
		t.Run(stage, func(t *testing.T) {
			want := []string{"begin", "write", "credential1", "botDAO", "bot", "authorize", "prepare"}
			if stage == "check" {
				want = append(want, "checkBot", "load", "check")
			}
			f := newRuntimeFixture(t, append(want, "close")...)
			f.credentials = []model.Principal{f.principal}
			f.errors[stage] = errRuntimeStage
			if err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, f.prepare, f.check, f.work(false)); err != errRuntimeStage {
				t.Fatalf("%s error changed: %v", stage, err)
			}
		})
	}
	t.Run("credential kind", func(t *testing.T) {
		f := newRuntimeFixture(t, "begin", "write", "close")
		f.principal.Kind = model.SessionCredential
		err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(false))
		requireRuntimeFault(t, err, "forbidden")
	})
	t.Run("credential missing", func(t *testing.T) {
		f := newRuntimeFixture(t, "begin", "write", "credential1", "close")
		f.principal.CredentialID = "77777777-7777-4777-8777-777777777777"
		f.credentials = []model.Principal{f.principal}
		f.errors["credential1"] = model.Unauthenticated(model.ErrNotFound)
		err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(false))
		requireRuntimeFault(t, err, "unauthenticated")
		if err != f.errors["credential1"] {
			t.Fatalf("credential error changed: %v", err)
		}
	})
	t.Run("Bot missing", func(t *testing.T) {
		f := newRuntimeFixture(t, "begin", "write", "credential1", "botDAO", "bot", "close")
		f.id = "88888888-8888-4888-8888-888888888888"
		f.credentials = []model.Principal{f.principal}
		f.errors["bot"] = model.ErrNotFound
		err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(false))
		requireRuntimeFault(t, err, "not_found")
	})
	t.Run("foreign Worker", func(t *testing.T) {
		f := newRuntimeFixture(t, "begin", "write", "credential1", "botDAO", "bot", "authorize", "close")
		f.workerID = "99999999-9999-4999-8999-999999999999"
		f.credentials = []model.Principal{f.principal}
		f.errors["authorize"] = &model.Fault{Code: "forbidden", Message: "Bot is not available."}
		err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(false))
		requireRuntimeFault(t, err, "forbidden")
		if err != f.errors["authorize"] {
			t.Fatalf("authorization error changed: %v", err)
		}
	})
	for _, stage := range []string{"bot", "load", "credential2"} {
		t.Run(stage, func(t *testing.T) {
			want := []string{"begin", "write", "credential1", "botDAO", "bot"}
			if stage != "bot" {
				want = append(want, "authorize", "checkBot", "load")
			}
			if stage == "credential2" {
				want = append(want, "credential2")
			}
			f := newRuntimeFixture(t, append(want, "close")...)
			f.credentials = []model.Principal{f.principal}
			if stage == "credential2" {
				f.credentials = append(f.credentials, f.principal)
			}
			f.errors[stage] = errRuntimeStage
			if err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(false)); err != errRuntimeStage {
				t.Fatalf("%s error changed: %v", stage, err)
			}
		})
	}
	t.Run("revoked parent credential", func(t *testing.T) {
		f := newRuntimeFixture(t, "begin", "write", "credential1", "botDAO", "bot", "authorize", "checkBot", "load", "credential2", "checkOwner", "authority", "credential3", "close")
		parent := f.principal
		f.principal.CredentialID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		f.credentials = []model.Principal{f.principal, f.principal, parent}
		f.errors["credential3"] = model.Unauthenticated(model.ErrNotFound)
		err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(false))
		requireRuntimeFault(t, err, "unauthenticated")
		if err != f.errors["credential3"] {
			t.Fatalf("parent credential error changed: %v", err)
		}
	})
}

func TestRuntimeRejectsDeletedBotAndStoppedEngine(t *testing.T) {
	t.Run("deleted Bot", func(t *testing.T) {
		f := newRuntimeFixture(t, "begin", "write", "credential1", "botDAO", "bot", "authorize", "close")
		f.bot.Deletion = &model.BotDeletion{DeletionID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", RequestedVersion: f.bot.Version}
		f.credentials = []model.Principal{f.principal}
		f.errors["authorize"] = &model.Fault{Code: "resource_conflict", Message: "Bot is deleted."}
		err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(false))
		requireRuntimeFault(t, err, "resource_conflict")
		if err != f.errors["authorize"] {
			t.Fatalf("deleted Bot error changed: %v", err)
		}
	})
	t.Run("stopped Engine", func(t *testing.T) {
		f := newRuntimeFixture(t, "begin")
		f.beginResult = nil
		f.errors["begin"] = &model.Fault{Code: "service_unavailable", Message: "Session work is stopping."}
		err := f.runtime().Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(false))
		requireRuntimeFault(t, err, "service_unavailable")
		if err != f.errors["begin"] {
			t.Fatalf("operation admission error changed: %v", err)
		}
	})
}
