package identity_test

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func profileCredentialDAO(tx pgx.Tx) store.IdentityDAO {
	return identity.NewScope(tx, oauth.NewDAO(tx)).IdentityDAO()
}

func TestProfileCredentialNativeKindsOwnerAndExpiry(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	user, session, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC()
	token := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash(uuid.NewString()), Name: "profile", CreatedAt: now}
	identityScopeTest(t, db, func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, token) })
	pat := model.Principal{Kind: model.PATCredential, UserID: user.ID, CredentialID: token.ID}
	for _, actor := range []model.Principal{session, pat} {
		identityScopeTest(t, db, func(scope store.IdentityScope) error {
			return scope.IdentityDAO().LockProfileCredential(ctx, actor, now)
		})
		wrong := actor
		wrong.UserID = uuid.NewString()
		_, err := db.WriteIdentity(ctx, func(scope store.IdentityScope) error {
			return scope.IdentityDAO().LockProfileCredential(ctx, wrong, now)
		})
		requireMissing(t, err)
	}
	for _, kind := range []model.CredentialKind{model.OAuthCredential, "unsupported"} {
		wrong := pat
		wrong.Kind = kind
		_, err := db.WriteIdentity(ctx, func(scope store.IdentityScope) error {
			return scope.IdentityDAO().LockProfileCredential(ctx, wrong, now)
		})
		requireMissing(t, err)
	}
	expiry := now.Add(time.Hour)
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		_, err := scope.IdentityDAO().SetPATExpiry(ctx, pat.CredentialID, &expiry)
		return err
	})
	_, err := db.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		return scope.IdentityDAO().LockProfileCredential(ctx, pat, expiry)
	})
	requireMissing(t, err)
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		return scope.IdentityDAO().DeletePAT(ctx, user.ID, pat.CredentialID)
	})
	_, err = db.WriteIdentity(ctx, func(scope store.IdentityScope) error { return scope.IdentityDAO().LockProfileCredential(ctx, pat, now) })
	requireMissing(t, err)
	identityScopeTest(t, db, func(scope store.IdentityScope) error { return scope.IdentityDAO().DeleteSession(ctx, session) })
	_, err = db.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		return scope.IdentityDAO().LockProfileCredential(ctx, session, now)
	})
	requireMissing(t, err)
}

func waitProfileCredentialQuery(t *testing.T, ctx context.Context, db *postgres.Store, pid uint32) {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		requireNoError(t, db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')`, pid).Scan(&waiting))
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
}

func TestProfileCredentialSharesReadersAndBlocksNativeMutation(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential} {
		for _, mutation := range []string{"revoke", "expiry"} {
			t.Run(string(kind)+"/"+mutation, func(t *testing.T) {
				db := isolatedStore(t)
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				defer cancel()
				user, actor, _ := testutil.AuthRecords(t, db)
				now := time.Now().UTC()
				if kind == model.PATCredential {
					actor = model.Principal{Kind: kind, UserID: user.ID, CredentialID: uuid.NewString()}
					identityScopeTest(t, db, func(scope store.IdentityScope) error {
						return scope.IdentityDAO().InsertPAT(ctx, model.PersonalAccessToken{ID: actor.CredentialID, UserID: user.ID, TokenHash: hash(uuid.NewString()), Name: "profile", CreatedAt: now})
					})
				}
				holder, err := db.Pool.Begin(ctx)
				requireNoError(t, err)
				defer holder.Rollback(context.Background())
				requireNoError(t, profileCredentialDAO(holder).LockProfileCredential(ctx, actor, now))
				reader, err := db.Pool.Begin(ctx)
				requireNoError(t, err)
				defer reader.Rollback(context.Background())
				requireNoError(t, profileCredentialDAO(reader).LockProfileCredential(ctx, actor, now))
				requireNoError(t, reader.Rollback(ctx))
				writer, err := db.Pool.Begin(ctx)
				requireNoError(t, err)
				defer writer.Rollback(context.Background())
				pid := writer.Conn().PgConn().PID()
				done := make(chan error, 1)
				go func() {
					table := "sessions"
					if kind == model.PATCredential {
						table = "personal_access_tokens"
					}
					sql := `DELETE FROM ` + table + ` WHERE id=$1`
					if mutation == "expiry" {
						sql = `UPDATE ` + table + ` SET expires_at=clock_timestamp() WHERE id=$1`
					}
					_, err := writer.Exec(ctx, sql, actor.CredentialID)
					done <- err
				}()
				waitProfileCredentialQuery(t, ctx, db, pid)
				select {
				case err := <-done:
					t.Fatalf("mutation bypassed shared profile lock: %v", err)
				default:
				}
				requireNoError(t, holder.Commit(ctx))
				requireNoError(t, <-done)
				requireNoError(t, writer.Commit(ctx))
				_, err = db.WriteIdentity(ctx, func(scope store.IdentityScope) error {
					return scope.IdentityDAO().LockProfileCredential(ctx, actor, now)
				})
				requireMissing(t, err)
			})
		}
	}
}

func TestProfileCredentialExpiryIsRecheckedAfterCredentialRowWait(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential} {
		t.Run(string(kind), func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			user, actor, _ := testutil.AuthRecords(t, db)
			now := time.Now().UTC()
			table := "sessions"
			if kind == model.PATCredential {
				table = "personal_access_tokens"
				actor = model.Principal{Kind: kind, UserID: user.ID, CredentialID: uuid.NewString()}
				identityScopeTest(t, db, func(scope store.IdentityScope) error {
					return scope.IdentityDAO().InsertPAT(ctx, model.PersonalAccessToken{ID: actor.CredentialID, UserID: user.ID, TokenHash: hash(uuid.NewString()), Name: "profile", CreatedAt: now})
				})
			}
			expires := now.Add(time.Second)
			_, err := db.Pool.Exec(ctx, `UPDATE `+table+` SET expires_at=$2 WHERE id=$1`, actor.CredentialID, expires)
			requireNoError(t, err)
			holder, err := db.Pool.Begin(ctx)
			requireNoError(t, err)
			defer holder.Rollback(context.Background())
			_, err = holder.Exec(ctx, `SELECT id FROM `+table+` WHERE id=$1 FOR UPDATE`, actor.CredentialID)
			requireNoError(t, err)
			reader, err := db.Pool.Begin(ctx)
			requireNoError(t, err)
			defer reader.Rollback(context.Background())
			done := make(chan error, 1)
			readerPID := reader.Conn().PgConn().PID()
			go func() { done <- profileCredentialDAO(reader).LockProfileCredential(ctx, actor, now) }()
			waitProfileCredentialQuery(t, ctx, db, readerPID)
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
			for {
				var expired bool
				requireNoError(t, db.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expires).Scan(&expired))
				if expired {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-ticker.C:
				}
			}
			requireNoError(t, holder.Commit(ctx))
			requireMissing(t, <-done)
		})
	}
}
