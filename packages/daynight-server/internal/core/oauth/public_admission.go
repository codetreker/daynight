package oauth

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/admission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

// PublicAdmission persists public endpoint budgets independently of the
// operation that follows. A rejected request commits its consumed counters.
type PublicAdmission struct {
	Writer store.IdentityWriter
	Now    func() time.Time
}

// Take admits registration and authorization start before allocations or
// metadata fetches. clientID must be empty: unvalidated client identifiers
// must never allocate persistent buckets. Token endpoints use TakeToken.
// False means rate limited; storage errors are separate from that decision.
func (a PublicAdmission) Take(ctx context.Context, kind, source, clientID string) (bool, error) {
	if clientID != "" {
		return false, fmt.Errorf("OAuth admission requires an empty client identifier")
	}
	var global, perSource int
	switch kind {
	case "register":
		global, perSource = 100, 10
	case "start":
		global, perSource = 300, 30
	default:
		return false, fmt.Errorf("invalid OAuth admission kind")
	}
	return a.takeSource(ctx, kind, source, global, perSource)
}

// TokenPermit binds the validated-client budget to one request. Copies share
// consumption state. It is not transferable to a different request and must
// not be persisted. A failed or uncertain second phase still consumes it.
type TokenPermit struct{ state *tokenPermitState }
type tokenPermitState struct {
	mu        sync.Mutex
	used      bool
	admission PublicAdmission
}

// TakeToken consumes the global and source token buckets before secret lookup.
// A permit is returned only after successful admission. If the caller cannot
// validate a client, it discards the permit without persisting that client ID.
func (a PublicAdmission) TakeToken(ctx context.Context, source string) (*TokenPermit, bool, error) {
	allowed, err := a.takeSource(ctx, "token", source, 1200, 120)
	if err != nil || !allowed {
		return nil, allowed, err
	}
	return &TokenPermit{state: &tokenPermitState{admission: a}}, true, nil
}

// TakeClient consumes only the verified client's token bucket, exactly once
// per permit. The caller must pass the authenticated client's ID, never raw
// request input. Duplicate use, an empty ID, and failed or unknown writes all
// prevent reuse; the global and source buckets are not charged a second time.
func (p *TokenPermit) TakeClient(ctx context.Context, validatedClientID string) (bool, error) {
	if p == nil || p.state == nil {
		return false, fmt.Errorf("invalid OAuth token admission permit")
	}
	s := p.state
	s.mu.Lock()
	if s.used {
		s.mu.Unlock()
		return false, fmt.Errorf("OAuth token admission permit already consumed")
	}
	s.used = true
	s.mu.Unlock()
	if validatedClientID == "" {
		return false, fmt.Errorf("missing validated OAuth client")
	}
	return s.admission.take(ctx, []model.DeviceRateBucket{{Hash: secret.Hash("oauth:token:client:" + validatedClientID), Limit: 240}})
}

func (a PublicAdmission) takeSource(ctx context.Context, kind, source string, global, perSource int) (bool, error) {
	if source == "" {
		return false, fmt.Errorf("missing OAuth admission source")
	}
	prefix := "oauth:" + kind + ":"
	return a.take(ctx, []model.DeviceRateBucket{{Hash: secret.Hash(prefix + "global"), Limit: global}, {Hash: secret.Hash(prefix + "source:" + source), Limit: perSource}})
}
func (a PublicAdmission) take(ctx context.Context, buckets []model.DeviceRateBucket) (bool, error) {
	if a.Writer == nil {
		return false, fmt.Errorf("missing OAuth admission store")
	}
	now := time.Now().UTC()
	if a.Now != nil {
		now = a.Now().UTC()
	}
	var allowed bool
	completion, err := a.Writer.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		var err error
		allowed, err = admission.Take(ctx, scope.IdentityDAO(), buckets, now)
		return err
	})
	if err != nil {
		return false, err
	}
	if completion.Outcome != store.TransactionCommitted {
		return false, fmt.Errorf("OAuth admission transaction outcome: %s", completion.Outcome)
	}
	return allowed, nil
}
