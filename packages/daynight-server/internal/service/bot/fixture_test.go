package bot

import (
	"context"
	"errors"
	"os"
	"reflect"
	"slices"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestMain(m *testing.M) {
	os.Unsetenv("DAYNIGHT_TEST_DATABASE_URL")
	os.Unsetenv("DAYNIGHT_TEST_UNIAUTH_FIXTURE")
	os.Exit(m.Run())
}
func pointer[T any](v T) *T { return &v }
func requireFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code || f.Message == "" {
		t.Fatalf("want %s, got %v", code, err)
	}
	return f
}
func requireCleanupFault(t *testing.T, err error, code string) {
	t.Helper()
	requireFault(t, err, code)
}
func botInput(worker string) botcore.CreateBot {
	return botcore.CreateBot{ID: uuid.NewString(), Name: "助手", ResolvedConfiguration: model.BotConfiguration{WorkerID: worker, Cwd: "/ordinary/directory", Provider: "codex", Args: []string{}}}
}
func testPrincipal() model.Principal {
	return model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
}

type callPlan struct {
	t         *testing.T
	want, got []string
}

func newPlan(t *testing.T, want ...string) *callPlan {
	p := &callPlan{t: t, want: want}
	t.Cleanup(func() {
		if !slices.Equal(p.want, p.got) {
			t.Errorf("calls %v, want %v", p.got, p.want)
		}
	})
	return p
}
func (p *callPlan) call(name string) {
	p.t.Helper()
	i := len(p.got)
	p.got = append(p.got, name)
	if i >= len(p.want) || p.want[i] != name {
		p.t.Errorf("unexpected call %s at %d, plan %v", name, i, p.want)
		panic("unexpected operation " + name)
	}
}
func same(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

type botToken struct{ store.BotWriteDAO }
type readToken struct{ store.BotReader }
type snapshotToken struct {
	store.SnapshotScope
	reader     store.BotReader
	credential store.CredentialReader
}

func (s *snapshotToken) BotDAO() store.BotReader               { return s.reader }
func (s *snapshotToken) CredentialDAO() store.CredentialReader { return s.credential }

type writeToken struct{ dao store.BotWriteDAO }

func (s *writeToken) BotDAO() store.BotWriteDAO { return s.dao }

type botFixture struct {
	t                                                                                        *testing.T
	plan                                                                                     *callPlan
	ctx                                                                                      context.Context
	p                                                                                        model.Principal
	snapshot                                                                                 *snapshotToken
	write                                                                                    *writeToken
	service                                                                                  *Bots
	readBeginError, readCallbackError, writeCallbackError, readFinishError, writeFinishError error
	completion                                                                               store.TransactionOutcome
}

func newBotFixture(t *testing.T, want ...string) *botFixture {
	f := &botFixture{t: t, plan: newPlan(t, want...), ctx: context.WithValue(t.Context(), struct{}{}, "caller"), p: testPrincipal(), snapshot: &snapshotToken{reader: &readToken{}}, write: &writeToken{dao: &botToken{}}, completion: store.TransactionCommitted}
	f.service = New(f)
	f.service.operations = botOperations{}
	return f
}
func (f *botFixture) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	f.plan.call("snapshot")
	identical(f.t, ctx, f.ctx)
	if f.readBeginError != nil {
		return f.readBeginError
	}
	e := fn(f.snapshot)
	same(f.t, e, f.readCallbackError)
	f.plan.call("read_done")
	if f.readFinishError != nil {
		return f.readFinishError
	}
	return e
}
func (f *botFixture) WriteBot(ctx context.Context, fn func(store.BotScope) error) (store.Completion, error) {
	f.plan.call("write")
	identical(f.t, ctx, f.ctx)
	e := fn(f.write)
	same(f.t, e, f.writeCallbackError)
	f.plan.call("write_done")
	if f.writeFinishError != nil {
		return store.Completion{Outcome: f.completion}, f.writeFinishError
	}
	if e != nil {
		return store.Completion{Outcome: f.completion}, &store.TransactionError{Phase: "operation", Outcome: f.completion, Cause: e}
	}
	return store.Completion{Outcome: f.completion}, nil
}
func frozenBot(p model.Principal, input botcore.CreateBot) model.Bot {
	return model.Bot{ID: input.ID, OwnerUserID: p.UserID, WorkerID: input.ResolvedConfiguration.WorkerID, Name: input.Name, Version: 9007199254740993, CreationOrder: 27, RequestedOverrides: input.Overrides, ResolvedConfiguration: input.ResolvedConfiguration, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: time.Date(2026, 11, 9, 0, 0, 0, 123456000, time.UTC), UpdatedAt: time.Date(2026, 11, 9, 1, 0, 0, 654321000, time.UTC)}
}

func identical(t *testing.T, got, want any) {
	t.Helper()
	if got != want {
		t.Fatalf("dependency identity changed: got %T %p, want %T %p", got, got, want, want)
	}
}
