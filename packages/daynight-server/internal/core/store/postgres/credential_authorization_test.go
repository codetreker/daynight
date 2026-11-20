package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestCurrentCredentialAuthorizationRejectsExpiryDuringLockWait(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.SessionCredential} {
		t.Run(string(kind), func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			p := model.Principal{Kind: kind, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			table := "sessions"
			columns, values := "", ""
			if kind == model.PATCredential {
				table = "personal_access_tokens"
				columns = ",name,business_scopes,scope_version"
				values = ",'expiry probe',ARRAY['task:read'],1"
			}
			var expiry time.Time
			err := db.Pool.QueryRow(ctx, "INSERT INTO "+table+"(id,user_id,token_hash,created_at,expires_at"+columns+") VALUES($1,$2,decode(repeat('01',32),'hex'),clock_timestamp(),clock_timestamp()+interval '2 seconds'"+values+") RETURNING expires_at", p.CredentialID, p.UserID).Scan(&expiry)
			if err != nil {
				t.Fatal(err)
			}
			holder, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err = holder.Exec(ctx, "SELECT id FROM "+table+" WHERE id=$1 FOR UPDATE", p.CredentialID); err != nil {
				t.Fatal(err)
			}
			reader, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Rollback(context.Background())
			done := make(chan error, 1)
			go func() {
				_, err := (credentialAuthorization{reader}).CurrentCredentialAuthorization(ctx, p, "https://example.test", true)
				done <- err
			}()
			defer func() {
				cancel()
				_ = holder.Rollback(context.Background())
				select {
				case <-done:
				case <-time.After(time.Second):
				}
			}()
			for {
				var blocked bool
				if err := db.Pool.QueryRow(ctx, "SELECT $1::integer=ANY(pg_blocking_pids($2::integer))", int32(holder.Conn().PgConn().PID()), int32(reader.Conn().PgConn().PID())).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("reader did not wait: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(5 * time.Millisecond):
				}
			}
			if _, err := db.Pool.Exec(ctx, "SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp())))", expiry); err != nil {
				t.Fatal(err)
			}
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				done <- err
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
					t.Fatalf("expired credential accepted after lock wait: %v", err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}
