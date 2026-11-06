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
