package oauth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type maintenanceClients struct {
	store.OAuthClientDAO
	err     error
	batches []int
}

func (d *maintenanceClients) LockClientCapacity(context.Context) error { return d.err }
func (d *maintenanceClients) ExpiredClients(_ context.Context, _ time.Time, n int) ([]string, error) {
	d.batches = append(d.batches, n)
	return nil, nil
}

type maintenanceScope struct {
	store.OAuthClientScope
	dao store.OAuthClientDAO
}

func (s maintenanceScope) OAuthClientDAO() store.OAuthClientDAO { return s.dao }

type maintenanceWriter struct{ dao *maintenanceClients }

func (w maintenanceWriter) WriteOAuthClients(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
	err := fn(maintenanceScope{dao: w.dao})
	return store.Completion{Outcome: store.TransactionCommitted}, err
}

type maintenancePruner struct {
	n       int
	err     error
	started chan struct{}
}

func (p *maintenancePruner) PruneAuthorizations(ctx context.Context, n int) (int, error) {
	p.n = n
	if p.started != nil {
		close(p.started)
		<-ctx.Done()
		return 0, ctx.Err()
	}
	return 0, p.err
}
func (p *maintenancePruner) PruneCredentials(_ context.Context, n int) (int, error) {
	p.n = n
	return 0, p.err
}
func TestMaintenanceBudgetsAndFailures(t *testing.T) {
	boom := errors.New("failure")
	c := &maintenanceClients{err: boom}
	a := &maintenancePruner{}
	g := &maintenancePruner{}
	m := Maintenance{Clients: maintenanceWriter{c}, Authorizations: a, Credentials: g}
	if err := m.Maintain(context.Background()); !errors.Is(err, boom) || a.n != 700 || g.n != 700 {
		t.Fatalf("maintenance: %v %d %d", err, a.n, g.n)
	}
	c.err = nil
	if err := m.Maintain(context.Background()); err != nil || len(c.batches) != 1 || c.batches[0] != 100 {
		t.Fatalf("batch: %v %v", err, c.batches)
	}
}
func TestMaintenanceStopJoinsStartup(t *testing.T) {
	started := make(chan struct{})
	c := &maintenanceClients{}
	a := &maintenancePruner{started: started}
	g := &maintenancePruner{}
	runner := StartMaintenance(Maintenance{Clients: maintenanceWriter{c}, Authorizations: a, Credentials: g}, nil)
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

type blockingAuthorizationPruner struct {
	started chan struct{}
	release chan struct{}
}

func (p *blockingAuthorizationPruner) PruneAuthorizations(context.Context, int) (int, error) {
	close(p.started)
	<-p.release
	return 0, nil
}

func TestMaintenanceStopTimeoutCanBeRetried(t *testing.T) {
	p := &blockingAuthorizationPruner{started: make(chan struct{}), release: make(chan struct{})}
	runner := StartMaintenance(Maintenance{Clients: maintenanceWriter{&maintenanceClients{}}, Authorizations: p, Credentials: &maintenancePruner{}}, nil)
	select {
	case <-p.started:
	case <-time.After(5 * time.Second):
		close(p.release)
		t.Fatal("startup scan did not run")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runner.Stop(ctx); !errors.Is(err, context.Canceled) {
		close(p.release)
		t.Fatalf("stop should report cancellation: %v", err)
	}
	close(p.release)
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runner.Stop(ctx); err != nil {
		t.Fatalf("retry stop: %v", err)
	}
}

func TestMaintenanceReportsFailureAndContinuesOtherCleanup(t *testing.T) {
	boom := errors.New("cleanup failed")
	a := &maintenancePruner{err: boom}
	g := &maintenancePruner{}
	reported := make(chan error, 1)
	runner := StartMaintenance(Maintenance{Clients: maintenanceWriter{&maintenanceClients{}}, Authorizations: a, Credentials: g, Now: func() time.Time { return time.Unix(1, 0) }}, func(err error) { reported <- err })
	select {
	case err := <-reported:
		if !errors.Is(err, boom) || g.n != 700 {
			t.Fatalf("report=%v credential budget=%d", err, g.n)
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
