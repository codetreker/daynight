package testutil

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func IdentityWrite(ctx context.Context, writer store.IdentityWriter, operation func(store.IdentityScope) error) error {
	_, err := writer.WriteIdentity(ctx, operation)
	return err
}

func SeedIdentitySession(ctx context.Context, writer store.IdentityWriter, user model.User, session model.Session) (model.User, error) {
	var result model.User
	err := IdentityWrite(ctx, writer, func(scope store.IdentityScope) error {
		var err error
		result, err = scope.IdentityDAO().UpsertUser(ctx, user, session.CreatedAt)
		if err != nil {
			return err
		}
		teamID := uuid.NewString()
		created, err := scope.PersonalTeamDAO().InsertPersonalTeam(ctx, teamID, result.ID, session.CreatedAt)
		if err != nil {
			return err
		}
		if !created {
			return errors.New("fixture requires a new personal team")
		}
		if err = scope.PersonalTeamDAO().InsertPersonalOwner(ctx, teamID, result.ID, session.CreatedAt); err != nil {
			return err
		}
		result.PersonalTeam = model.TeamRef{ID: teamID, Kind: "personal"}
		session.UserID = result.ID
		return scope.IdentityDAO().InsertSession(ctx, session)
	})
	return result, err
}

func Authenticate(ctx context.Context, writer store.IdentityWriter, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	var principal model.Principal
	err := IdentityWrite(ctx, writer, func(scope store.IdentityScope) error {
		var err error
		principal, err = scope.IdentityDAO().Authenticate(ctx, kind, hash, now)
		return err
	})
	return principal, err
}

func IdentityUser(ctx context.Context, writer store.IdentityWriter, id string) (model.User, store.PersonalTeamFacts, error) {
	var user model.User
	var facts store.PersonalTeamFacts
	err := IdentityWrite(ctx, writer, func(scope store.IdentityScope) error {
		var err error
		user, facts, err = scope.IdentityDAO().IdentityUser(ctx, id)
		return err
	})
	return user, facts, err
}

func AuthRecords(t *testing.T, writer store.IdentityWriter) (model.User, model.Principal, model.Session) {
	t.Helper()
	now := time.Now().UTC()
	hash := sha256.Sum256([]byte(uuid.NewString()))
	session := model.Session{ID: uuid.NewString(), TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	user, err := SeedIdentitySession(context.Background(), writer, model.User{ID: uuid.NewString(), UniAuthID: "github:" + uuid.NewString()}, session)
	if err != nil {
		t.Fatal(err)
	}
	principal, err := Authenticate(context.Background(), writer, model.SessionCredential, hash[:], now)
	if err != nil {
		t.Fatal(err)
	}
	return user, principal, session
}

func DeviceHash(value string) []byte {
	hash := sha256.Sum256([]byte(value))
	return hash[:]
}

func DeviceCredential(now time.Time) model.PersonalAccessToken {
	return model.PersonalAccessToken{ID: uuid.NewString(), TokenHash: DeviceHash(uuid.NewString()), Name: "test device", CreatedAt: now}
}
