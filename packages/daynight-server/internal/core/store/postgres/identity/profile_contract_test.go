package identity_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestEnsureUserReturnsActualIdentityWithoutOverwritingProfile(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	name, avatar := "Original", "https://example.test/avatar"
	candidate := model.User{ID: uuid.NewString(), UniAuthID: "github:" + uuid.NewString(), Name: &name, AvatarURL: &avatar}
	var actual model.User
	identityScopeTest(t, db, func(sc store.IdentityScope) error {
		var inserted bool
		var err error
		actual, inserted, err = sc.IdentityDAO().EnsureUser(ctx, candidate, now)
		if err == nil && (!inserted || actual.ID != candidate.ID || !actual.CreatedAt.Equal(now) || !actual.UpdatedAt.Equal(now)) {
			t.Fatalf("new identity: %+v inserted=%t", actual, inserted)
		}
		return err
	})
	replacement := model.User{ID: uuid.NewString(), UniAuthID: candidate.UniAuthID}
	identityScopeTest(t, db, func(sc store.IdentityScope) error {
		got, inserted, err := sc.IdentityDAO().EnsureUser(ctx, replacement, now.Add(time.Hour))
		if err == nil && (inserted || !reflect.DeepEqual(got, actual)) {
			t.Fatalf("existing profile changed: got=%+v original=%+v inserted=%t", got, actual, inserted)
		}
		return err
	})
	stop := errors.New("initialization failed")
	rolledBackID := uuid.NewString()
	completion, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
		_, inserted, err := sc.IdentityDAO().EnsureUser(ctx, model.User{ID: rolledBackID, UniAuthID: "github:" + uuid.NewString()}, now)
		if err != nil {
			return err
		}
		if !inserted {
			t.Fatal("new identity not inserted")
		}
		return stop
	})
	if !errors.Is(err, stop) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	var count int
	requireNoError(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id=$1`, rolledBackID).Scan(&count))
	if count != 0 {
		t.Fatal("rolled back candidate persisted")
	}
}

func TestEnsureUserReadsCommittedConcurrentWinner(t *testing.T) {
	for _, mode := range []string{"ensure-commit", "ensure-rollback", "native-commit", "native-rollback"} {
		commitWinner := mode == "ensure-commit" || mode == "native-commit"
		t.Run(mode, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			tx, err := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
			requireNoError(t, err)
			defer tx.Rollback(context.Background())
			now := time.Now().UTC()
			name := "Winner"
			winner := model.User{ID: uuid.NewString(), UniAuthID: "github:" + uuid.NewString(), Name: &name}
			dao := identity.NewScope(tx, oauth.NewDAO(tx)).IdentityDAO()
			var winningUser model.User
			if mode == "native-commit" || mode == "native-rollback" {
				winningUser, err = dao.UpsertUser(ctx, winner, now)
				requireNoError(t, err)
			} else {
				var inserted bool
				winningUser, inserted, err = dao.EnsureUser(ctx, winner, now)
				requireNoError(t, err)
				if !inserted {
					t.Fatal("winner not inserted")
				}
			}
			candidate := model.User{ID: uuid.NewString(), UniAuthID: winner.UniAuthID}
			var result model.User
			var resultInserted bool
			done := make(chan error, 1)
			go func() {
				_, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
					var err error
					result, resultInserted, err = sc.IdentityDAO().EnsureUser(ctx, candidate, now.Add(time.Hour))
					return err
				})
				done <- err
			}()
			testutil.WaitForQueryLock(t, db.Pool, "INSERT INTO users")
			if commitWinner {
				requireNoError(t, tx.Commit(ctx))
			} else {
				requireNoError(t, tx.Rollback(ctx))
			}
			requireNoError(t, testutil.ReceiveQueryResult(t, ctx, done))
			if commitWinner && (resultInserted || !reflect.DeepEqual(result, winningUser)) {
				t.Fatalf("concurrent winner lost: %+v inserted=%t", result, resultInserted)
			}
			if !commitWinner && (!resultInserted || result.ID != candidate.ID) {
				t.Fatalf("rollback did not insert candidate: %+v inserted=%t", result, resultInserted)
			}
			var count int
			requireNoError(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE uniauth_id=$1`, winner.UniAuthID).Scan(&count))
			if count != 1 {
				t.Fatalf("identity count=%d", count)
			}
		})
	}
}

func TestPatchUserSparseConcurrentUpdatesAndRollback(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	user, _, _ := testutil.AuthRecords(t, db)
	name, avatar := "New name", "https://example.test/new"
	tx, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer tx.Rollback(context.Background())
	first, err := identity.NewScope(tx, oauth.NewDAO(tx)).IdentityDAO().PatchUser(ctx, user.ID, model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &name}})
	requireNoError(t, err)
	if first.Name == nil || *first.Name != name || first.AvatarURL != nil || !first.UpdatedAt.After(user.UpdatedAt) {
		t.Fatalf("name patch=%+v", first)
	}
	var second model.User
	done := make(chan error, 1)
	go func() {
		_, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
			var err error
			second, err = sc.IdentityDAO().PatchUser(ctx, user.ID, model.UserProfilePatch{AvatarURL: model.ProfileField{Present: true, Value: &avatar}})
			return err
		})
		done <- err
	}()
	testutil.WaitForQueryLock(t, db.Pool, "UPDATE users SET")
	requireNoError(t, tx.Commit(ctx))
	requireNoError(t, testutil.ReceiveQueryResult(t, ctx, done))
	if second.Name == nil || *second.Name != name || second.AvatarURL == nil || *second.AvatarURL != avatar {
		t.Fatalf("concurrent sparse update=%+v", second)
	}
	identityScopeTest(t, db, func(sc store.IdentityScope) error {
		cleared, err := sc.IdentityDAO().PatchUser(ctx, user.ID, model.UserProfilePatch{Name: model.ProfileField{Present: true}, AvatarURL: model.ProfileField{Present: true}})
		if err == nil && (cleared.Name != nil || cleared.AvatarURL != nil || cleared.ID != user.ID || cleared.UniAuthID != user.UniAuthID || !cleared.CreatedAt.Equal(user.CreatedAt)) {
			t.Fatalf("clear changed immutable fields: %+v", cleared)
		}
		return err
	})
	stop := errors.New("encoding refused")
	completion, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
		if _, err := sc.IdentityDAO().PatchUser(ctx, user.ID, model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &name}}); err != nil {
			return err
		}
		return stop
	})
	if !errors.Is(err, stop) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("patch rollback: %+v %v", completion, err)
	}
	actual, facts, err := testutil.IdentityUser(ctx, db, user.ID)
	requireNoError(t, err)
	if actual.Name != nil || actual.AvatarURL != nil || facts.ID != user.PersonalTeam.ID {
		t.Fatalf("rollback changed profile/team: %+v %+v", actual, facts)
	}
	_, err = db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
		_, err := sc.IdentityDAO().PatchUser(ctx, uuid.NewString(), model.UserProfilePatch{Name: model.ProfileField{Present: true}})
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing user: %v", err)
	}
}
