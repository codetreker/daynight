package postgres

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	coreidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEnsureUserCompleteAccountRacesNativeLogin(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	identity := identityservice.New(database, nil, "https://example.test/auth/callback")
	externalName, nativeName := "external", "native"
	input := model.User{UniAuthID: "microsoft:tenant:object", Name: &externalName}
	start := make(chan struct{})
	type result struct {
		user model.User
		err  error
	}
	results := make(chan result, 2)
	go func() { <-start; user, err := identity.EnsureUser(ctx, input); results <- result{user, err} }()
	go func() {
		<-start
		var user model.User
		now := time.Now().UTC()
		_, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
			var err error
			user, err = coreidentity.NewIdentity("").CompleteLogin(ctx, scope.IdentityDAO(), model.User{UniAuthID: "msft:object@tenant", Name: &nativeName}, now)
			if err != nil {
				return err
			}
			user.PersonalTeam, err = team.BootstrapPersonalTeam(ctx, scope.PersonalTeamDAO(), user.ID, now)
			return err
		})
		results <- result{user, err}
	}()
	close(start)
	first, second := <-results, <-results
	if first.err != nil || second.err != nil || first.user.ID != second.user.ID || first.user.PersonalTeam.ID != second.user.PersonalTeam.ID {
		t.Fatalf("canonical account: %+v %+v", first, second)
	}
	var valid bool
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users)=1 AND (SELECT count(*) FROM teams)=1 AND (SELECT count(*) FROM team_members)=1 AND EXISTS(SELECT FROM team_members WHERE user_id=$1 AND role='admin') AND EXISTS(SELECT FROM users WHERE id=$1 AND uniauth_id='msft:object@tenant' AND name=$2)`, first.user.ID, nativeName).Scan(&valid); err != nil || !valid {
		t.Fatalf("complete native account: %t %v", valid, err)
	}
	actual, err := identity.EnsureUser(ctx, input)
	if err != nil || actual.ID != first.user.ID || actual.Name == nil || *actual.Name != nativeName {
		t.Fatalf("existing profile overwritten: %+v %v", actual, err)
	}
}

func TestEnsureUserInitializationFailureRollsBackAccount(t *testing.T) {
	for _, table := range []string{"teams", "team_members"} {
		t.Run(table, func(t *testing.T) {
			database := isolatedStore(t)
			ctx := t.Context()
			if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION refuse_profile_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture bootstrap rejection'; END $$; CREATE TRIGGER refuse_profile_bootstrap BEFORE INSERT ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_profile_bootstrap()`); err != nil {
				t.Fatal(err)
			}
			actual, err := identityservice.New(database, nil, "https://example.test/auth/callback").EnsureUser(ctx, model.User{UniAuthID: "github:bootstrap"})
			var pg *pgconn.PgError
			if actual.ID != "" || !errors.As(err, &pg) || pg.Code != "P0001" {
				t.Fatalf("bootstrap failure: %+v %v", actual, err)
			}
			var empty bool
			if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users)=0 AND (SELECT count(*) FROM teams)=0 AND (SELECT count(*) FROM team_members)=0`).Scan(&empty); err != nil || !empty {
				t.Fatalf("partial account: %t %v", empty, err)
			}
		})
	}
}

func TestProfilePatchCompleteValidationRollsBackSparseWrite(t *testing.T) {
	for _, failure := range []string{"personal-team", "profile-capacity", "stored-field-capacity"} {
		t.Run(failure, func(t *testing.T) {
			database := isolatedStore(t)
			ctx := t.Context()
			user, principal, _ := testAuthRecords(t, database)
			switch failure {
			case "personal-team":
				mustQueryExec(t, database, `DELETE FROM team_members WHERE team_id=$1`, user.PersonalTeam.ID)
			case "profile-capacity":
				mustQueryExec(t, database, `UPDATE users SET avatar_url=$2 WHERE id=$1`, user.ID, strings.Repeat("\"", coreidentity.MaxAvatarURLBytes))
			case "stored-field-capacity":
				mustQueryExec(t, database, `UPDATE users SET email=$2 WHERE id=$1`, user.ID, strings.Repeat("x", coreidentity.MaxProfileFieldBytes+1))
			}
			before := authorizationReceiverRow(t, ctx, database, "users", "id", user.ID)
			name := "should roll back"
			actual, err := identityservice.New(database, nil, "https://example.test/auth/callback").PatchUser(ctx, principal, model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &name}})
			if err == nil || actual.ID != "" {
				t.Fatalf("invalid complete account accepted: %+v %v", actual, err)
			}
			if after := authorizationReceiverRow(t, ctx, database, "users", "id", user.ID); after != before {
				t.Fatalf("sparse write survived validation refusal: before=%s after=%s", before, after)
			}
		})
	}
}

func TestProfilePatchRechecksExpiryAfterUserRowWait(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.OAuthCredential} {
		t.Run(string(kind), func(t *testing.T) {
			database := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			user, principal, _ := testAuthRecords(t, database)
			expires := time.Now().UTC().Add(time.Second)
			if kind == model.SessionCredential {
				mustQueryExec(t, database, `UPDATE sessions SET expires_at=$2 WHERE id=$1`, principal.CredentialID, expires)
			} else {
				var issued coreoauth.IssuedFamily
				_, err := database.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
					var err error
					issued, err = coreoauth.IssueAPIFamily(ctx, scope.CredentialFamilyDAO(), user.ID, "https://example.test/api/v1", time.Now())
					return err
				})
				if err != nil {
					t.Fatal(err)
				}
				principal = model.Principal{Kind: kind, UserID: user.ID, CredentialID: issued.AccessID}
				mustQueryExec(t, database, `UPDATE oauth_access_tokens SET expires_at=$2 WHERE id=$1`, issued.AccessID, expires)
			}
			before := authorizationReceiverRow(t, ctx, database, "users", "id", user.ID)
			holder, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err = holder.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, user.ID); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			name := "expired after contention"
			go func() {
				_, err := identityservice.New(database, nil, "https://example.test/auth/callback").PatchUser(ctx, principal, model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &name}})
				done <- err
			}()
			waitIdentityLock(t, ctx, database, "UPDATE users SET %")
			for {
				var expired bool
				if err := database.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expires).Scan(&expired); err != nil {
					t.Fatal(err)
				}
				if expired {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(5 * time.Millisecond):
				}
			}
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = <-done
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
				t.Fatalf("expired user wait accepted: %v", err)
			}
			if after := authorizationReceiverRow(t, ctx, database, "users", "id", user.ID); after != before {
				t.Fatalf("expired profile update committed: before=%s after=%s", before, after)
			}
		})
	}
}

func TestEnsureUserLostCommitAcknowledgementReturnsUnknown(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	var armed, lost atomic.Bool
	config := database.Pool.Config().Copy()
	config.ConnConfig.TLSConfig = nil
	config.ConnConfig.Fallbacks = nil
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostGrantCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	armed.Store(true)
	actual, err := identityservice.New(&Store{Pool: pool}, nil, "https://example.test/auth/callback").EnsureUser(ctx, model.User{UniAuthID: "github:unknown-account"})
	var failure *store.TransactionError
	if actual.ID != "" || !lost.Load() || !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown || !failure.CommitAttempted {
		t.Fatalf("unknown account receipt: actual=%+v lost=%v error=%v", actual, lost.Load(), err)
	}
	var complete bool
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users)=1 AND (SELECT count(*) FROM teams)=1 AND (SELECT count(*) FROM team_members)=1`).Scan(&complete); err != nil || !complete {
		t.Fatalf("unknown transaction lost durable complete account: %t %v", complete, err)
	}
}
