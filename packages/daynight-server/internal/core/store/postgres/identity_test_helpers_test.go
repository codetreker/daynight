package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

// Storage fixtures use the same transaction scope as production callers.
func testIdentityWrite(s *Store, ctx context.Context, f func(IdentityScope) error) error {
	_, err := s.WriteIdentity(ctx, f)
	return err
}
func seedIdentitySession(s *Store, ctx context.Context, u model.User, c model.Session) (model.User, error) {
	var result model.User
	err := testIdentityWrite(s, ctx, func(sc IdentityScope) error {
		var err error
		result, err = sc.IdentityDAO().UpsertUser(ctx, u, c.CreatedAt)
		if err != nil {
			return err
		}
		id := uuid.NewString()
		created, err := sc.PersonalTeamDAO().InsertPersonalTeam(ctx, id, result.ID, c.CreatedAt)
		if err != nil {
			return err
		}
		if !created {
			return errors.New("fixture requires a new personal team")
		}
		if err = sc.PersonalTeamDAO().InsertPersonalOwner(ctx, id, result.ID, c.CreatedAt); err != nil {
			return err
		}
		result.PersonalTeam = model.TeamRef{ID: id, Kind: "personal"}
		c.UserID = result.ID
		return sc.IdentityDAO().InsertSession(ctx, c)
	})
	return result, err
}
func testAuthenticate(s *Store, ctx context.Context, k model.CredentialKind, h []byte, now time.Time) (model.Principal, error) {
	var p model.Principal
	err := testIdentityWrite(s, ctx, func(sc IdentityScope) error {
		var err error
		p, err = sc.IdentityDAO().Authenticate(ctx, k, h, now)
		return err
	})
	return p, err
}
func testIdentityUser(s *Store, ctx context.Context, id string) (model.User, PersonalTeamFacts, error) {
	var u model.User
	var facts PersonalTeamFacts
	err := testIdentityWrite(s, ctx, func(sc IdentityScope) error {
		var err error
		u, facts, err = sc.IdentityDAO().IdentityUser(ctx, id)
		return err
	})
	return u, facts, err
}
func deviceStoreHash(value string) []byte { hash := sha256.Sum256([]byte(value)); return hash[:] }
func deviceStoreCredential(now time.Time) model.PersonalAccessToken {
	return model.PersonalAccessToken{ID: uuid.NewString(), TokenHash: deviceStoreHash(uuid.NewString()), Name: "test device", CreatedAt: now}
}
