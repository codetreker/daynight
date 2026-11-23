package identity

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func browserSessions(dao any) (store.BrowserSessionDAO, error) {
	sessions, ok := dao.(store.BrowserSessionDAO)
	if !ok {
		return nil, errors.New("identity scope lacks browser session capability")
	}
	return sessions, nil
}

func (s *Identity) SessionTime(ctx context.Context, dao store.IdentityDAO) (time.Time, error) {
	return browserTime(ctx, dao)
}

func browserTime(ctx context.Context, dao any) (time.Time, error) {
	clock, ok := dao.(store.BrowserSessionClock)
	if !ok {
		return time.Time{}, errors.New("identity scope lacks browser session clock")
	}
	return clock.SessionTime(ctx)
}

func touchBrowserSession(ctx context.Context, dao store.BrowserSessionDAO, session model.Session, now time.Time) error {
	if !session.ExpiresAt.After(now) {
		return model.Unauthenticated(model.ErrNotFound)
	}
	lastUsed := now
	if session.LastUsedAt != nil && session.LastUsedAt.After(lastUsed) {
		lastUsed = *session.LastUsedAt
	}
	expires := lastUsed.Add(SessionLifetime)
	if session.ExpiresAt.After(expires) {
		expires = session.ExpiresAt
	}
	return dao.TouchBrowserSession(ctx, session.ID, lastUsed, expires)
}

func (s *Identity) AuthenticateBrowserActivity(ctx context.Context, dao store.IdentityDAO, value, expectedUserID string) (model.Principal, error) {
	if err := ValidateCredential(model.SessionCredential, value); err != nil {
		return model.Principal{}, err
	}
	if expectedUserID != "" {
		id, err := model.CanonicalID(expectedUserID)
		if err != nil {
			return model.Principal{}, err
		}
		expectedUserID = id
	}
	sessions, err := browserSessions(dao)
	if err != nil {
		return model.Principal{}, err
	}
	session, now, err := sessions.LockBrowserSession(ctx, secret.Hash(value), false)
	if err != nil {
		return model.Principal{}, authLookupError(err)
	}
	if !session.ExpiresAt.After(now) {
		return model.Principal{}, model.Unauthenticated(model.ErrNotFound)
	}
	if expectedUserID != "" && session.UserID != expectedUserID {
		return model.Principal{}, &model.Fault{Code: "identity_mismatch", Message: "The browser account changed."}
	}
	if err := touchBrowserSession(ctx, sessions, session, now); err != nil {
		return model.Principal{}, err
	}
	return model.Principal{Kind: model.SessionCredential, UserID: session.UserID, CredentialID: session.ID}, nil
}

func (s *PreviewSSO) Renew(ctx context.Context, dao store.PreviewSSODAO, value string, principal model.Principal) error {
	if !secret.Valid(value, previewSecretPrefix) || principal.Kind != model.SessionCredential {
		return model.Unauthenticated(model.ErrNotFound)
	}
	sessions, err := browserSessions(dao)
	if err != nil {
		return err
	}
	session, now, err := sessions.LockBrowserSession(ctx, secret.Hash(value), true)
	if err != nil {
		return authLookupError(err)
	}
	if session.UserID != principal.UserID || session.ID != principal.CredentialID {
		return model.Unauthenticated(model.ErrNotFound)
	}
	return touchBrowserSession(ctx, sessions, session, now)
}
