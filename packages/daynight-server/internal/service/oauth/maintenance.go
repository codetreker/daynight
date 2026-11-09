package oauth

import (
	"context"
	"errors"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// CredentialPruner removes expired credentials and retained grant metadata.
type CredentialPruner interface {
	PruneCredentials(context.Context, int) (int, error)
}
type AuthorizationPruner interface {
	PruneAuthorizations(context.Context, int) (int, error)
}

// Maintenance bounds each kind independently so retained clients cannot starve
// authorization and credential cleanup. Their combined examination budget is 2000.
type Maintenance struct {
	Clients        store.OAuthClientWriter
	Authorizations AuthorizationPruner
	Credentials    CredentialPruner
	Now            func() time.Time
}

func (m Maintenance) Maintain(ctx context.Context) error {
	now := time.Now().UTC()
	if m.Now != nil {
		now = m.Now().UTC()
	}
	// Attempt all three even if one fails; each retains responsibility for retry.
	_, clients := core.PruneClients(ctx, m.Clients, 600, now)
	_, authorizations := m.Authorizations.PruneAuthorizations(ctx, 700)
	_, credentials := m.Credentials.PruneCredentials(ctx, 700)
	return errors.Join(clients, authorizations, credentials)
}

// MaintenanceRunner owns a startup scan and a minute ticker. Stop cancels and
// joins before callers release the underlying stores; a timed-out stop is retryable.
type MaintenanceRunner struct {
	cancel context.CancelFunc
	done   chan struct{}
}

func StartMaintenance(m Maintenance, report func(error)) *MaintenanceRunner {
	ctx, cancel := context.WithCancel(context.Background())
	r := &MaintenanceRunner{cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(r.done)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			if err := m.Maintain(ctx); err != nil && ctx.Err() == nil && report != nil {
				report(err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return r
}
func (r *MaintenanceRunner) Stop(ctx context.Context) error {
	r.cancel()
	select {
	case <-r.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
