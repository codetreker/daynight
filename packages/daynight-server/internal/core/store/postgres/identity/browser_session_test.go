package identity_test

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	identitystore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	oauthstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestBrowserSessionRollingActivityPersistsAndSharesPreviewExpiry(t *testing.T) {
	f := newPreviewFixture(t)
	ctx := t.Context()
	main := service.New(f.db, nil, "https://daynight.cc/api/v1/auth/callback")
	preview, err := service.NewPreviewSSO(f.db, "https://daynight.cc", "https://preview.daynight.cc", "https://daynight.cc/api/v1/auth/callback")
	requireNoError(t, err)
	value, pv := secret.Random("dnst_"), secret.Random("dnpv_")
	_, err = f.db.Pool.Exec(ctx, `UPDATE sessions SET token_hash=$2,preview_token_hash=$3,created_at=clock_timestamp()-interval '7 days',expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, f.session.ID, secret.Hash(value), secret.Hash(pv))
	requireNoError(t, err)
	var used *time.Time
	var originalExpiry time.Time
	requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT last_used_at,expires_at FROM sessions WHERE id=$1`, f.session.ID).Scan(&used, &originalExpiry))
	if used != nil {
		t.Fatal("legacy activity was backfilled")
	}
	p, err := main.AuthenticateBrowserActivity(ctx, value, f.principal.UserID)
	requireNoError(t, err)
	if p != f.principal {
		t.Fatal(p)
	}
	var expires, timeBefore time.Time
	requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT last_used_at,expires_at,clock_timestamp() FROM sessions WHERE id=$1`, f.session.ID).Scan(&used, &expires, &timeBefore))
	if used == nil || !expires.Equal(used.Add(core.SessionLifetime)) || !expires.After(originalExpiry) || used.After(timeBefore) {
		t.Fatalf("renewed used=%v expires=%v db=%v", used, expires, timeBefore)
	}
	observed, previewExpiry, err := preview.Authenticate(ctx, pv)
	requireNoError(t, err)
	if observed != p || !previewExpiry.Equal(expires) {
		t.Fatal("preview did not share renewed deadline")
	}
	requireNoError(t, preview.Renew(ctx, pv, p))
	var renewed time.Time
	requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT expires_at FROM sessions WHERE id=$1`, f.session.ID).Scan(&renewed))
	if renewed.Before(expires) {
		t.Fatal("preview moved expiry backward")
	}
	_, err = main.Authenticate(ctx, model.SessionCredential, value)
	requireNoError(t, err)
	var unchanged time.Time
	requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT expires_at FROM sessions WHERE id=$1`, f.session.ID).Scan(&unchanged))
	if !unchanged.Equal(renewed) {
		t.Fatal("nonactivity authentication renewed")
	}
	_, err = f.db.Pool.Exec(ctx, `UPDATE sessions SET last_used_at=clock_timestamp()-interval '168 hours',expires_at=clock_timestamp() WHERE id=$1`, f.session.ID)
	requireNoError(t, err)
	_, err = main.AuthenticateBrowserActivity(ctx, value, "")
	requireMissing(t, err)
	_, _, err = preview.Authenticate(ctx, pv)
	requireMissing(t, err)
}

func TestBrowserActivityRollbackAndAccountRefusalLeaveSessionUnchanged(t *testing.T) {
	f := newPreviewFixture(t)
	ctx := t.Context()
	value := secret.Random("dnst_")
	_, err := f.db.Pool.Exec(ctx, `UPDATE sessions SET token_hash=$2 WHERE id=$1`, f.session.ID, secret.Hash(value))
	requireNoError(t, err)
	main := service.New(f.db, nil, "https://daynight.cc/api/v1/auth/callback")
	_, err = main.AuthenticateBrowserActivity(ctx, value, uuid.NewString())
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "identity_mismatch" {
		t.Fatal(err)
	}
	abort := errors.New("abort after touch")
	completion, err := f.db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
		if _, err := core.NewIdentity("").AuthenticateBrowserActivity(ctx, sc.IdentityDAO(), value, ""); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback=%+v %v", completion, err)
	}
	var used *time.Time
	var expires time.Time
	requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT last_used_at,expires_at FROM sessions WHERE id=$1`, f.session.ID).Scan(&used, &expires))
	if used != nil || !expires.Equal(f.session.ExpiresAt) {
		t.Fatal("refusal or rollback persisted activity")
	}
}

func TestBrowserActivityWaitCannotReviveExpiredRevokedOrRotatedCredential(t *testing.T) {
	db := isolatedStore(t)
	for _, change := range []string{"expiry", "revoke", "cleanup", "preview-rotation"} {
		t.Run(change, func(t *testing.T) {
			f := newPreviewFixtureInStore(t, db)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			value, pv := secret.Random("dnst_"), secret.Random("dnpv_")
			_, err := db.Pool.Exec(ctx, `UPDATE sessions SET token_hash=$2,preview_token_hash=$3,created_at=clock_timestamp()-interval '1 day' WHERE id=$1`, f.session.ID, secret.Hash(value), secret.Hash(pv))
			requireNoError(t, err)
			holder, err := db.Pool.Begin(ctx)
			requireNoError(t, err)
			defer holder.Rollback(context.Background())
			_, err = holder.Exec(ctx, `SELECT id FROM sessions WHERE id=$1 FOR UPDATE`, f.session.ID)
			requireNoError(t, err)
			result := make(chan error, 1)
			go func() {
				if change == "preview-rotation" {
					preview, err := service.NewPreviewSSO(db, "https://daynight.cc", "https://preview.daynight.cc", "https://daynight.cc/api/v1/auth/callback")
					if err == nil {
						err = preview.Renew(ctx, pv, f.principal)
					}
					result <- err
				} else {
					_, err := service.New(db, nil, "https://daynight.cc/api/v1/auth/callback").AuthenticateBrowserActivity(ctx, value, "")
					result <- err
				}
			}()
			for {
				var waiting bool
				requireNoError(t, db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT id::text,user_id::text,token_hash,preview_token_hash,created_at,last_used_at,expires_at FROM sessions%')`, int32(holder.Conn().PgConn().PID())).Scan(&waiting))
				if waiting {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal("activity did not wait for row lock")
				case <-time.After(time.Millisecond):
				}
			}
			switch change {
			case "expiry":
				_, err = holder.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp()+interval '30 milliseconds' WHERE id=$1`, f.session.ID)
				requireNoError(t, err)
				for {
					var expired bool
					requireNoError(t, holder.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM sessions WHERE id=$1`, f.session.ID).Scan(&expired))
					if expired {
						break
					}
					select {
					case <-ctx.Done():
						t.Fatal("database expiry did not arrive")
					case <-time.After(time.Millisecond):
					}
				}
			case "revoke":
				_, err = holder.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, f.session.ID)
				requireNoError(t, err)
			case "cleanup":
				_, err = holder.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp() WHERE id=$1`, f.session.ID)
				requireNoError(t, err)
				requireNoError(t, identitystore.NewScope(holder, oauthstore.NewDAO(holder)).IdentityDAO().CleanupCredentials(ctx, time.Now()))
			case "preview-rotation":
				_, err = holder.Exec(ctx, `UPDATE sessions SET preview_token_hash=$2 WHERE id=$1`, f.session.ID, secret.Hash(secret.Random("dnpv_")))
				requireNoError(t, err)
			}
			requireNoError(t, holder.Commit(ctx))
			select {
			case err := <-result:
				requireMissing(t, err)
			case <-ctx.Done():
				t.Fatal("activity did not drain")
			}
			var used *time.Time
			var count int
			if change == "revoke" || change == "cleanup" {
				requireNoError(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE id=$1`, f.session.ID).Scan(&count))
				if count != 0 {
					t.Fatal("revoked session was recreated")
				}
			} else {
				requireNoError(t, db.Pool.QueryRow(ctx, `SELECT last_used_at FROM sessions WHERE id=$1`, f.session.ID).Scan(&used))
				if used != nil {
					t.Fatal("late request wrote activity")
				}
			}
		})
	}
}
