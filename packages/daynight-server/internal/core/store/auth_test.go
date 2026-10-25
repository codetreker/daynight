package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func testAuthRecords(t *testing.T, s *Store) (core.User, core.Principal, core.Session) {
	t.Helper()
	now := time.Now().UTC()
	hash := sha256.Sum256([]byte(uuid.NewString()))
	c := core.Session{ID: uuid.NewString(), TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	u, err := s.CreateIdentitySession(context.Background(), core.User{ID: uuid.NewString(), UniAuthID: "github:" + uuid.NewString()}, c)
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Authenticate(context.Background(), core.SessionCredential, hash[:], now)
	if err != nil {
		t.Fatal(err)
	}
	return u, p, c
}

func TestIdentityStorageConstraintsAndCleanup(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	for _, sql := range []string{
		`INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000001','',NULL,NULL,NULL,NULL,now(),now())`,
		`INSERT INTO login_transactions VALUES ('00000000-0000-0000-0000-000000000001',decode('00','hex'),decode(repeat('00',32),'hex'),'github','/',now())`,
		`INSERT INTO login_transactions VALUES ('00000000-0000-0000-0000-000000000001',decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex'),'other','/',now())`,
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
	_, err := s.Pool.Exec(ctx, `INSERT INTO login_transactions SELECT md5('id'||n)::uuid,sha256(n::text::bytea),sha256(n::text::bytea),'github','/',$1::timestamptz-interval '1 hour' FROM generate_series(1,120) n`, now)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256([]byte("current"))
	if err := s.CreateLogin(ctx, core.LoginTransaction{ID: uuid.NewString(), StateHash: h[:], BrowserBindingHash: h[:], Provider: "github", ReturnPath: "/", ExpiresAt: now.Add(time.Minute)}, now); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"login_transactions", "sessions", "personal_access_tokens"} {
		var count int
		if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE expires_at<=$1`, now).Scan(&count); err != nil || count != 20 {
			t.Fatalf("bounded cleanup %s: %d %v", table, count, err)
		}
	}
}

func TestIdentityStorageRollbackAndOwnership(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	user, p, c := testAuthRecords(t, s)
	_, other, _ := testAuthRecords(t, s)
	_, err := s.CreateIdentitySession(ctx, core.User{ID: uuid.NewString(), UniAuthID: "rollback-user"}, c)
	if err == nil {
		t.Fatal("duplicate session accepted")
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE uniauth_id='rollback-user'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("user not rolled back: %d %v", count, err)
	}
	hash := sha256.Sum256([]byte("pat"))
	pat := core.PersonalAccessToken{ID: uuid.NewString(), TokenHash: hash[:], Name: "owned", CreatedAt: time.Now().UTC(), ExpiresAt: storeTokenExpiry(time.Now().UTC().Add(time.Hour))}
	if err := s.CreatePAT(ctx, p, pat); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Authenticate(ctx, core.PATCredential, hash[:], time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokePAT(ctx, other, pat.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	tokens, err := s.ListPATs(ctx, p, time.Now())
	if err != nil || len(tokens) != 1 || tokens[0].UserID != user.ID || tokens[0].TokenHash != nil {
		t.Fatalf("ownership/list: %+v %v", tokens, err)
	}
	p.Kind = core.PATCredential
	if _, err := s.ListPATs(ctx, p, time.Now()); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("PAT session access: %v", err)
	}
	if _, err := s.Authenticate(ctx, "unknown", hash[:], time.Now()); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("invalid kind: %v", err)
	}
	if _, err := s.IdentityUser(ctx, uuid.NewString()); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("missing user: %v", err)
	}
}

func TestIdentityStorageOperationalFailures(t *testing.T) {
	for _, phase := range []string{"create-login", "upsert-user", "insert-session", "insert-pat", "list-pat", "delete-pat", "delete-session", "consume-login", "authenticate", "user"} {
		t.Run(phase, func(t *testing.T) {
			s := isolatedStore(t)
			_, p, c := testAuthRecords(t, s)
			now := time.Now().UTC()
			hash := sha256.Sum256([]byte("state"))
			pending := core.LoginTransaction{ID: uuid.NewString(), StateHash: hash[:], BrowserBindingHash: hash[:], Provider: "github", ReturnPath: "/", ExpiresAt: now.Add(time.Minute)}
			table := "personal_access_tokens"
			switch phase {
			case "create-login", "consume-login":
				table = "login_transactions"
			case "upsert-user", "user":
				table = "users"
			case "insert-session", "delete-session", "authenticate":
				table = "sessions"
			}
			if _, err := s.Pool.Exec(context.Background(), "DROP TABLE "+table); err != nil {
				t.Fatal(err)
			}
			var err error
			switch phase {
			case "create-login":
				err = s.CreateLogin(context.Background(), pending, now)
			case "upsert-user", "insert-session":
				_, err = s.CreateIdentitySession(context.Background(), core.User{ID: uuid.NewString(), UniAuthID: "github:new"}, c)
			case "insert-pat":
				err = s.CreatePAT(context.Background(), p, core.PersonalAccessToken{ID: uuid.NewString(), TokenHash: hash[:], Name: "token", CreatedAt: now, ExpiresAt: storeTokenExpiry(now.Add(time.Hour))})
			case "list-pat":
				_, err = s.ListPATs(context.Background(), p, now)
			case "delete-pat":
				err = s.RevokePAT(context.Background(), p, uuid.NewString(), now)
			case "delete-session":
				err = s.DeleteSession(context.Background(), p)
			case "consume-login":
				_, err = s.ConsumeLogin(context.Background(), hash[:], hash[:], now)
			case "authenticate":
				_, err = s.Authenticate(context.Background(), core.SessionCredential, c.TokenHash, now)
			case "user":
				_, err = s.IdentityUser(context.Background(), p.UserID)
			}
			var databaseError *Error
			if !errors.As(err, &databaseError) || strings.Contains(err.Error(), "SELECT") {
				t.Fatalf("error chain: %v", err)
			}
		})
	}
	s := isolatedStore(t)
	s.Close()
	now := time.Now().UTC()
	if err := s.CreateLogin(context.Background(), core.LoginTransaction{}, now); err == nil {
		t.Fatal("closed pool login accepted")
	}
	if _, err := s.CreateIdentitySession(context.Background(), core.User{}, core.Session{}); err == nil {
		t.Fatal("closed pool identity accepted")
	}
	if _, err := s.ListPATs(context.Background(), core.Principal{Kind: core.SessionCredential}, now); err == nil {
		t.Fatal("closed pool operation accepted")
	}
}
