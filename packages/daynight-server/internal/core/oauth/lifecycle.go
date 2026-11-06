package oauth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

// GrantLifecycle owns refresh rotation, revocation and credential retention.
type GrantLifecycle struct {
	writer store.GrantLifecycleWriter
	now    func() time.Time
}
type RotatedTokens struct {
	AccessToken, RefreshToken string
	ExpiresIn                 int64
}

func NewGrantLifecycle(writer store.GrantLifecycleWriter) *GrantLifecycle {
	return &GrantLifecycle{writer: writer, now: time.Now}
}
func (s *GrantLifecycle) clock() time.Time { return s.now().UTC().Truncate(time.Microsecond) }
func lifecycleCompletion(c store.Completion, err error) error {
	if c.Outcome == store.TransactionUnknown {
		return fmt.Errorf("%w: transaction not confirmed", ErrAuthorizationUnknown)
	}
	if err != nil {
		return err
	}
	if c.Outcome != store.TransactionCommitted {
		return fmt.Errorf("OAuth lifecycle transaction not committed")
	}
	return nil
}

// Rotate consumes a refresh token once. admit is called only after the client
// and resource match, before any mutation, including replay revocation. A
// successful response is emitted only after the enclosing transaction commits.
func (s *GrantLifecycle) Rotate(ctx context.Context, token, clientID, resource string, admit func(context.Context, string) error) (RotatedTokens, error) {
	if !secret.Valid(token, RefreshPrefix) || clientID == "" || !validResource(resource) || admit == nil {
		return RotatedTokens{}, ErrInvalidGrant
	}
	hash := secret.Hash(token)
	// Verify the client without retaining a connection while the independent
	// admission transaction runs. The locked transaction below rechecks all
	// bindings because this observation may already be stale.
	c, err := s.writer.WriteGrantLifecycle(ctx, func(d store.GrantLifecycleDAO) error {
		r, e := d.Refresh(ctx, hash, false)
		if e != nil {
			return e
		}
		g, e := d.InspectGrant(ctx, r.GrantID, false)
		if e != nil {
			return e
		}
		if r.GrantID != g.ID || r.ClientID != clientID || g.ClientID != clientID || g.Resource != resource || g.Scope != Scope {
			return ErrInvalidGrant
		}
		return nil
	})
	if c.Outcome != store.TransactionUnknown && errors.Is(err, model.ErrNotFound) {
		return RotatedTokens{}, ErrInvalidGrant
	}
	if e := lifecycleCompletion(c, err); e != nil {
		return RotatedTokens{}, e
	}
	if err = admit(ctx, clientID); err != nil {
		return RotatedTokens{}, err
	}
	var result RotatedTokens
	var replay bool
	c, err = s.writer.WriteGrantLifecycle(ctx, func(d store.GrantLifecycleDAO) error {
		first, e := d.Refresh(ctx, hash, false)
		if e != nil {
			return e
		}
		grant, e := d.InspectGrant(ctx, first.GrantID, true)
		if e != nil {
			return e
		}
		r, e := d.Refresh(ctx, hash, true)
		if e != nil {
			return e
		}
		if r.GrantID != grant.ID || r.ClientID != clientID || grant.ClientID != clientID || grant.Resource != resource || grant.Scope != Scope {
			return ErrInvalidGrant
		}
		now, e := d.FreshTime(ctx, s.clock())
		if e != nil {
			return e
		}
		if grant.RevokedAt != nil || !grant.ExpiresAt.After(now) || !r.ExpiresAt.After(now) {
			return ErrInvalidGrant
		}
		if r.ConsumedAt != nil {
			if _, e = d.RevokeFamily(ctx, grant.ID, now); e != nil {
				return e
			}
			replay = true
			return nil
		}
		accessExpiry := minTime(now.Add(AccessLifetime), grant.ExpiresAt)
		access, refresh := secret.Random(model.OAuthAccessPrefix), secret.Random(RefreshPrefix)
		e = d.RotateRefresh(ctx, store.OAuthRotation{Grant: grant, OldHash: hash, AccessHash: secret.Hash(access), RefreshHash: secret.Hash(refresh), AccessID: uuid.NewString(), CreatedAt: now, AccessExpiresAt: accessExpiry})
		if e != nil {
			return e
		}
		result = RotatedTokens{AccessToken: access, RefreshToken: refresh, ExpiresIn: int64(accessExpiry.Sub(now) / time.Second)}
		return nil
	})
	if c.Outcome != store.TransactionUnknown && errors.Is(err, model.ErrNotFound) {
		return RotatedTokens{}, ErrInvalidGrant
	}
	if e := lifecycleCompletion(c, err); e != nil {
		return RotatedTokens{}, e
	}
	if replay {
		return RotatedTokens{}, ErrInvalidGrant
	}
	return result, nil
}
func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// RevokePublic never discloses whether a token or client matched. Both access
// and refresh tokens identify a family, but the submitted client must own it.
func (s *GrantLifecycle) RevokePublic(ctx context.Context, token, clientID string) error {
	isRefresh := secret.Valid(token, RefreshPrefix)
	isAccess := secret.Valid(token, model.OAuthAccessPrefix)
	if (!isRefresh && !isAccess) || clientID == "" {
		return nil
	}
	hash := secret.Hash(token)
	c, err := s.writer.WriteGrantLifecycle(ctx, func(d store.GrantLifecycleDAO) error {
		var id string
		var e error
		if isRefresh {
			var r store.OAuthRefresh
			r, e = d.Refresh(ctx, hash, false)
			id = r.GrantID
		} else {
			id, e = d.AccessGrant(ctx, hash)
		}
		if errors.Is(e, model.ErrNotFound) {
			return nil
		}
		if e != nil {
			return e
		}
		grant, e := d.InspectGrant(ctx, id, true)
		if errors.Is(e, model.ErrNotFound) {
			return nil
		}
		if e != nil {
			return e
		}
		if grant.ClientID != clientID {
			return nil
		}
		if isRefresh {
			r, err := d.Refresh(ctx, hash, true)
			if errors.Is(err, model.ErrNotFound) {
				return nil
			}
			if err != nil {
				return err
			}
			if r.GrantID != grant.ID || r.ClientID != clientID {
				return nil
			}
		} else {
			actual, err := d.AccessGrant(ctx, hash)
			if errors.Is(err, model.ErrNotFound) {
				return nil
			}
			if err != nil {
				return err
			}
			if actual != grant.ID {
				return nil
			}
		}
		now, e := d.FreshTime(ctx, s.clock())
		if e != nil {
			return e
		}
		_, e = d.RevokeFamily(ctx, id, now)
		return e
	})
	return lifecycleCompletion(c, err)
}
func validID(id string) bool {
	c, e := model.CanonicalID(id)
	return e == nil && c == id && c != uuid.Nil.String()
}

// ListOwnerGrants and RevokeOwnerGrant accept the authenticated account ID;
// the caller owns the authentication boundary for that account.
func (s *GrantLifecycle) ListOwnerGrants(ctx context.Context, userID string) ([]store.OAuthGrant, error) {
	grants, _, err := s.listOwnerGrants(ctx, userID, nil)
	return grants, err
}

// ListSessionGrants validates the browser session in the same transaction as
// the read, including after any wait for its credential lock.
func (s *GrantLifecycle) ListSessionGrants(ctx context.Context, principal model.Principal) ([]store.OAuthGrant, time.Time, error) {
	if !validOwnerSession(principal) {
		return nil, time.Time{}, model.Unauthenticated(nil)
	}
	return s.listOwnerGrants(ctx, principal.UserID, &principal)
}

func validOwnerSession(p model.Principal) bool {
	return p.Kind == model.SessionCredential && validID(p.UserID) && validID(p.CredentialID)
}

func (s *GrantLifecycle) checkOwnerSession(ctx context.Context, d store.GrantLifecycleDAO, p model.Principal) error {
	_, err := s.checkOwnerSessionAt(ctx, d, p)
	return err
}

func (s *GrantLifecycle) checkOwnerSessionAt(ctx context.Context, d store.GrantLifecycleDAO, p model.Principal) (time.Time, error) {
	now, err := d.FreshTime(ctx, s.clock())
	if err != nil {
		return time.Time{}, err
	}
	if err := d.LockOwnerSession(ctx, p, now); errors.Is(err, model.ErrNotFound) {
		return time.Time{}, model.Unauthenticated(nil)
	} else {
		return now, err
	}
}

func (s *GrantLifecycle) listOwnerGrants(ctx context.Context, userID string, principal *model.Principal) ([]store.OAuthGrant, time.Time, error) {
	if !validID(userID) {
		return nil, time.Time{}, invalidInput()
	}
	var out []store.OAuthGrant
	var observedAt time.Time
	c, err := s.writer.WriteGrantLifecycle(ctx, func(d store.GrantLifecycleDAO) error {
		if principal != nil {
			if err := s.checkOwnerSession(ctx, d, *principal); err != nil {
				return err
			}
		}
		var err error
		out, err = d.OwnerGrants(ctx, userID)
		if err != nil {
			return err
		}
		if principal != nil {
			observedAt, err = s.checkOwnerSessionAt(ctx, d, *principal)
			return err
		}
		return nil
	})
	if e := lifecycleCompletion(c, err); e != nil {
		return nil, time.Time{}, e
	}
	return out, observedAt, nil
}
func (s *GrantLifecycle) RevokeOwnerGrant(ctx context.Context, userID, grantID string) (bool, error) {
	return s.revokeOwnerGrant(ctx, userID, grantID, nil)
}

// RevokeSessionGrant rechecks the browser session after grant and access lock
// waits. Grant is locked first, preserving the family lock order.
func (s *GrantLifecycle) RevokeSessionGrant(ctx context.Context, principal model.Principal, grantID string) (bool, error) {
	if !validOwnerSession(principal) {
		return false, model.Unauthenticated(nil)
	}
	return s.revokeOwnerGrant(ctx, principal.UserID, grantID, &principal)
}

func (s *GrantLifecycle) revokeOwnerGrant(ctx context.Context, userID, grantID string, principal *model.Principal) (bool, error) {
	if !validID(userID) || !validID(grantID) {
		return false, invalidInput()
	}
	var changed bool
	c, err := s.writer.WriteGrantLifecycle(ctx, func(d store.GrantLifecycleDAO) error {
		g, e := d.InspectGrant(ctx, grantID, true)
		if e != nil {
			return e
		}
		if g.UserID != userID {
			return model.ErrNotFound
		}
		if principal != nil {
			if err := s.checkOwnerSession(ctx, d, *principal); err != nil {
				return err
			}
		}
		now, e := d.FreshTime(ctx, s.clock())
		if e != nil {
			return e
		}
		changed, e = d.RevokeFamily(ctx, grantID, now)
		if e != nil {
			return e
		}
		if principal != nil {
			return s.checkOwnerSession(ctx, d, *principal)
		}
		return nil
	})
	if e := lifecycleCompletion(c, err); e != nil {
		return false, e
	}
	return changed, nil
}

// PruneCredentials processes no more than budget rows in batches of 100.
func (s *GrantLifecycle) PruneCredentials(ctx context.Context, budget int) (int, error) {
	if budget < 0 {
		return 0, fmt.Errorf("invalid OAuth credential cleanup budget")
	}
	budget = min(budget, 2000)
	total := 0
	for budget > 0 {
		batch := min(budget, 100)
		n := 0
		c, err := s.writer.WriteGrantLifecycle(ctx, func(d store.GrantLifecycleDAO) error {
			var e error
			n, e = d.PruneCredentials(ctx, s.clock(), batch)
			return e
		})
		if e := lifecycleCompletion(c, err); e != nil {
			return total, e
		}
		total += n
		budget -= n
		if n < batch {
			break
		}
	}
	return total, nil
}
