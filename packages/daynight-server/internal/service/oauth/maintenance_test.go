package oauth

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type maintenanceCapability struct{ t *testing.T }

func (c *maintenanceCapability) WriteOAuthClients(context.Context, func(store.OAuthClientScope) error) (store.Completion, error) {
	c.t.Error("unexpected direct use of client writer")
	return store.Completion{}, errors.New("unexpected client writer call")
}

type maintenanceRound struct {
	clientCount, authorizationCount, credentialCount int
	clientErr, authorizationErr, credentialErr       error
	authorization                                    func(context.Context) error
}

type maintenanceFixture struct {
	t             *testing.T
	mu            sync.Mutex
	writer        *maintenanceCapability
	rounds        []maintenanceRound
	ctx           context.Context // nil for a runner-owned context
	clock         *time.Time
	before        time.Time
	observedTimes []time.Time
	calls         int
	roundContext  context.Context
}

func newMaintenanceFixture(t *testing.T, ctx context.Context, rounds ...maintenanceRound) *maintenanceFixture {
	t.Helper()
	f := &maintenanceFixture{t: t, ctx: ctx, rounds: rounds, before: time.Now().UTC()}
	f.writer = &maintenanceCapability{t: t}
	t.Cleanup(func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, now := range f.observedTimes {
			if f.clock == nil && now.After(time.Now().UTC()) {
				t.Errorf("client clock %v is after completion", now)
			}
		}
		if f.calls != 3*len(f.rounds) {
			t.Errorf("cleanup calls = %d, want %d", f.calls, 3*len(f.rounds))
		}
	})
	return f
}

// call checks order within each scan, including the runner's shared context.
func (f *maintenanceFixture) call(ctx context.Context, operation string, budget int, writer store.OAuthClientWriter, now time.Time) (maintenanceRound, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	index := f.calls
	f.calls++
	if index >= 3*len(f.rounds) {
		f.t.Errorf("unexpected %s call %d", operation, index+1)
		return maintenanceRound{}, errors.New("unexpected cleanup call")
	}
	wantOperation := []string{"clients", "authorizations", "credentials"}[index%3]
	wantBudget := 700
	if index%3 == 0 {
		wantBudget = 600
		f.roundContext = ctx
		if writer != f.writer {
			f.t.Error("client writer identity changed")
		}
		f.observedTimes = append(f.observedTimes, now)
		if now.Location() != time.UTC || (f.clock != nil && now != f.clock.UTC()) || (f.clock == nil && now.Before(f.before)) {
			f.t.Errorf("client clock = %v", now)
		}
	}
	if operation != wantOperation || budget != wantBudget || ctx != f.roundContext || (f.ctx != nil && ctx != f.ctx) {
		f.t.Errorf("call %d: operation=%s budget=%d context=%v; want %s budget=%d and original scan context", index+1, operation, budget, ctx, wantOperation, wantBudget)
	}
	return f.rounds[index/3], nil
}

func (f *maintenanceFixture) pruneClients(ctx context.Context, writer store.OAuthClientWriter, budget int, now time.Time) (int, error) {
	round, err := f.call(ctx, "clients", budget, writer, now)
	if err != nil {
		return 0, err
	}
	return round.clientCount, round.clientErr
}
func (f *maintenanceFixture) PruneAuthorizations(ctx context.Context, budget int) (int, error) {
	round, err := f.call(ctx, "authorizations", budget, nil, time.Time{})
	if err != nil {
		return 0, err
	}
	if round.authorization != nil {
		return 0, round.authorization(ctx)
	}
	return round.authorizationCount, round.authorizationErr
}
func (f *maintenanceFixture) PruneCredentials(ctx context.Context, budget int) (int, error) {
	round, err := f.call(ctx, "credentials", budget, nil, time.Time{})
	if err != nil {
		return 0, err
	}
	return round.credentialCount, round.credentialErr
}
func (f *maintenanceFixture) maintenance() Maintenance {
	m := NewMaintenance(f.writer, f, f)
	m.pruneClients = f.pruneClients
	return m
}

func TestNewMaintenanceBindsDependenciesAndCoreOperation(t *testing.T) {
	f := newMaintenanceFixture(t, nil)
	a := newMaintenanceFixture(t, nil)
	g := newMaintenanceFixture(t, nil)
	m := NewMaintenance(f.writer, a, g)
	if m.Clients != f.writer || m.Authorizations != a || m.Credentials != g || m.Now != nil || reflect.ValueOf(m.pruneClients).Pointer() != reflect.ValueOf(core.PruneClients).Pointer() {
		t.Fatal("constructor did not preserve dependencies and bind Core cleanup")
	}
}

func TestMaintenanceBudgetsAndFailures(t *testing.T) {
	boom := errors.New("failure")
	type key struct{}
	ctx := context.WithValue(context.Background(), key{}, "caller")
	f := newMaintenanceFixture(t, ctx, maintenanceRound{clientErr: boom}, maintenanceRound{})
	m := f.maintenance()
	if err := m.Maintain(ctx); !errors.Is(err, boom) {
		t.Fatalf("maintenance error = %v, want failure", err)
	}
	if err := m.Maintain(ctx); err != nil {
		t.Fatalf("second maintenance = %v", err)
	}
}

func stopMaintenance(t *testing.T, runner *MaintenanceRunner) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runner.Stop(ctx); err != nil {
		t.Errorf("cleanup stop: %v", err)
	}
	select {
	case <-runner.done:
	case <-ctx.Done():
		t.Error("runner did not exit during cleanup")
	}
}

func TestMaintenanceStopJoinsStartup(t *testing.T) {
	started := make(chan struct{})
	f := newMaintenanceFixture(t, nil, maintenanceRound{authorization: func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}})
	runner := StartMaintenance(f.maintenance(), nil)
	t.Cleanup(func() { stopMaintenance(t, runner) })
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("startup scan did not run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runner.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if err := runner.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestMaintenanceStopTimeoutCanBeRetried(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	f := newMaintenanceFixture(t, nil, maintenanceRound{authorization: func(context.Context) error {
		close(started)
		<-release
		return nil
	}})
	runner := StartMaintenance(f.maintenance(), nil)
	t.Cleanup(func() { unblock(); stopMaintenance(t, runner) })
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("startup scan did not run")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runner.Stop(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("stop should report cancellation: %v", err)
	}
	select {
	case <-runner.done:
		t.Fatal("runner exited before authorization was released")
	default:
	}
	unblock()
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runner.Stop(ctx); err != nil {
		t.Fatalf("retry stop: %v", err)
	}
	select {
	case <-runner.done:
	default:
		t.Fatal("retry returned before runner exited")
	}
}

func TestMaintenanceReportsFailureAndContinuesOtherCleanup(t *testing.T) {
	boom := errors.New("cleanup failed")
	now := time.Unix(1, 0)
	f := newMaintenanceFixture(t, nil, maintenanceRound{authorizationErr: boom})
	f.clock = &now
	m := f.maintenance()
	m.Now = func() time.Time { return time.Unix(1, 0) }
	reported := make(chan error, 1)
	runner := StartMaintenance(m, func(err error) { reported <- err })
	t.Cleanup(func() { stopMaintenance(t, runner) })
	select {
	case err := <-reported:
		f.mu.Lock()
		calls := f.calls
		f.mu.Unlock()
		if calls != 3 {
			t.Errorf("report arrived after %d cleanup calls, want 3", calls)
		}
		if !errors.Is(err, boom) {
			t.Fatalf("report = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("maintenance failure not reported")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runner.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}
