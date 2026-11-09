package identity_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"testing"
	"time"
)

func insertLoginWithCleanup(s *postgres.Store, ctx context.Context, pending model.LoginTransaction, now time.Time) error {
	_, err := s.WriteIdentity(ctx, func(sc store.IdentityScope) error {
		if err := sc.IdentityDAO().CleanupLoginCredentials(ctx, now, now); err != nil {
			return err
		}
		return sc.IdentityDAO().InsertLogin(ctx, pending)
	})
	return err
}

func TestIdentityStorageConstraintsAndCleanup(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	for _, sql := range []string{
		`INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000001','',NULL,NULL,NULL,NULL,now(),now())`,
		`INSERT INTO login_transactions VALUES ('00000000-0000-0000-0000-000000000001',decode('00','hex'),decode(repeat('00',32),'hex'),'github','/',now(),decode(repeat('00',32),'hex'))`,
		`INSERT INTO login_transactions VALUES ('00000000-0000-0000-0000-000000000001',decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex'),'other','/',now(),decode(repeat('00',32),'hex'))`,
		`INSERT INTO sessions VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode(repeat('00',32),'hex'),now(),now())`,
		`INSERT INTO personal_access_tokens VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',decode(repeat('00',32),'hex'),' ',now(),now()+interval '1 day')`,
	} {
		_, err := s.Pool.Exec(ctx, sql)
		var failure *pgconn.PgError
		if !errors.As(err, &failure) || failure.Code != "23514" {
			t.Fatalf("constraint accepted: %v", err)
		}
	}
	for _, table := range []string{"sessions", "personal_access_tokens"} {
		name := ""
		if table == "personal_access_tokens" {
			name = ",name"
		}
		value := ""
		if name != "" {
			value = ",'expired'"
		}
		_, err := s.Pool.Exec(ctx, `INSERT INTO `+table+` (id,user_id,token_hash,created_at,expires_at`+name+`) SELECT md5('id'||n)::uuid,md5('user')::uuid,sha256(n::text::bytea),$1::timestamptz-interval '2 hours',$1::timestamptz-interval '1 hour'`+value+` FROM generate_series(1,120) n`, now)
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO login_transactions SELECT md5('id'||n)::uuid,sha256(n::text::bytea),sha256(n::text::bytea),'github','/',$1::timestamptz-interval '1 hour',sha256(n::text::bytea) FROM generate_series(1,120) n`, now)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256([]byte("current"))
	if err := insertLoginWithCleanup(s, ctx, model.LoginTransaction{ID: uuid.NewString(), StateHash: h[:], BrowserBindingHash: h[:], ScopeHash: h[:], Provider: "github", ReturnPath: "/", ExpiresAt: now.Add(time.Minute)}, now); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"login_transactions", "sessions", "personal_access_tokens"} {
		var count int
		if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE expires_at<=$1`, now).Scan(&count); err != nil || count != 20 {
			t.Fatalf("bounded cleanup %s: %d %v", table, count, err)
		}
	}
}
