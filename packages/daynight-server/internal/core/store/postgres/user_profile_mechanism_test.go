package postgres

import (
	"context"
	"errors"
	"net"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	coreidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEnsureUserCompleteAccountRacesNativeLogin(t *testing.T) {
	parallelRootDatabaseTest(t)
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
	parallelRootDatabaseTest(t)
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
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	for _, failure := range []string{"personal-team", "profile-capacity", "stored-field-capacity"} {
		if !t.Run(failure, func(t *testing.T) {
			ctx := t.Context()
			user, principal, _ := testAuthRecords(t, database)
			var field string
			var maxBytes int64
			switch failure {
			case "personal-team":
				result, err := database.Pool.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2 AND role='admin'`, user.PersonalTeam.ID, user.ID)
				if err != nil || result.RowsAffected() != 1 {
					t.Fatalf("remove Personal Team owner: rows=%d error=%v", result.RowsAffected(), err)
				}
			case "profile-capacity":
				field, maxBytes = "profile", coreidentity.MaxProfileJSONBytes
				mustQueryExec(t, database, `UPDATE users SET avatar_url=$2 WHERE id=$1`, user.ID, strings.Repeat("\"", coreidentity.MaxAvatarURLBytes))
			case "stored-field-capacity":
				field, maxBytes = "email", coreidentity.MaxProfileFieldBytes
				mustQueryExec(t, database, `UPDATE users SET email=$2 WHERE id=$1`, user.ID, strings.Repeat("x", coreidentity.MaxProfileFieldBytes+1))
			}
			before := authorizationReceiverRow(t, ctx, database, "users", "id", user.ID)
			name := "should roll back"
			actual, err := identityservice.New(database, nil, "https://example.test/auth/callback").PatchUser(ctx, principal, model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &name}})
			if err == nil || actual.ID != "" {
				t.Fatalf("invalid complete account accepted: %+v %v", actual, err)
			}
			var rollback *store.TransactionError
			if !errors.As(err, &rollback) || rollback.Phase != "operation" || rollback.Outcome != store.TransactionNotCommitted || rollback.CommitAttempted || rollback.CleanupFailed {
				t.Fatalf("profile validation did not roll back the operation: completion=%+v error=%v", rollback, err)
			}
			if failure == "personal-team" {
				if rollback.Cause == nil || rollback.Cause.Error() != "Personal Team owner membership is invalid" {
					t.Fatalf("expected Personal Team owner refusal: %v", rollback.Cause)
				}
			} else {
				var fault *model.Fault
				var violation *limit.Violation
				if !errors.As(err, &fault) || fault.Code != "invalid_input" || !errors.As(err, &violation) || violation.Field != field || violation.Max != maxBytes {
					t.Fatalf("expected %s capacity refusal at %d bytes: fault=%+v violation=%+v", field, maxBytes, fault, violation)
				}
			}
			if after := authorizationReceiverRow(t, ctx, database, "users", "id", user.ID); after != before {
				t.Fatalf("sparse write survived validation refusal: before=%s after=%s", before, after)
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, database.Pool)
	}
}

func TestProfilePatchRechecksExpiryAfterUserRowWait(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.OAuthCredential} {
		t.Run(string(kind), func(t *testing.T) {
			database := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			user, principal, _ := testAuthRecords(t, database)
			table := "sessions"
			if kind == model.OAuthCredential {
				table = "oauth_access_tokens"
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
			name := "expired after contention"
			err = expireCredentialDuringRowWait(t, ctx, database.Pool, holder, table, principal.CredentialID,
				"UPDATE users SET ", func(ctx context.Context) error {
					_, err := identityservice.New(database, nil, "https://example.test/auth/callback").PatchUser(ctx, principal, model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &name}})
					return err
				})
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
	parallelRootDatabaseTest(t)
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

type registrationOwnerBarrier struct {
	store.SessionWriter
	locked chan struct{}
	resume chan struct{}
}

func (w registrationOwnerBarrier) WriteSession(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	return w.SessionWriter.WriteSession(ctx, func(scope store.SessionScope) error {
		return work(registrationOwnerScope{SessionScope: scope, dao: registrationOwnerDAO{SessionDAO: scope.SessionDAO(), barrier: w}})
	})
}

type registrationOwnerScope struct {
	store.SessionScope
	dao store.SessionDAO
}

func (s registrationOwnerScope) SessionDAO() store.SessionDAO { return s.dao }

type registrationOwnerDAO struct {
	store.SessionDAO
	barrier registrationOwnerBarrier
}

func (d registrationOwnerDAO) LockTestOwner(ctx context.Context, user string) error {
	if err := d.SessionDAO.LockTestOwner(ctx, user); err != nil {
		return err
	}
	close(d.barrier.locked)
	select {
	case <-d.barrier.resume:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestProfilePatchSharesPATWithSameOwnerTestRegistrationRetry(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user, _, _ := testAuthRecords(t, database)
	now := time.Now().UTC().Truncate(time.Microsecond)
	expires := now.Add(time.Hour)
	pats := []model.PersonalAccessToken{
		{ScopePolicy: testutil.PATPolicy(), ID: uuid.NewString(), UserID: user.ID, TokenHash: deviceStoreHash(uuid.NewString()), Name: "retry", CreatedAt: now, ExpiresAt: &expires},
		{ScopePolicy: testutil.PATPolicy(), ID: uuid.NewString(), UserID: user.ID, TokenHash: deviceStoreHash(uuid.NewString()), Name: "original", CreatedAt: now, ExpiresAt: &expires},
	}
	identityScopeTest(t, database, func(scope store.IdentityScope) error {
		for _, pat := range pats {
			if err := scope.IdentityDAO().InsertPAT(ctx, pat); err != nil {
				return err
			}
		}
		return nil
	})
	actorA := model.Principal{Kind: model.PATCredential, UserID: user.ID, CredentialID: pats[0].ID}
	actorB := model.Principal{Kind: model.PATCredential, UserID: user.ID, CredentialID: pats[1].ID}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	engine := sessioncore.NewEngine(files)
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer stopCancel()
		if err := engine.Stop(stopCtx); err != nil {
			t.Error(err)
		}
	})
	registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	first, err := sessionservice.New(database, engine).RegisterTest(ctx, actorB, registration)
	if err != nil {
		t.Fatal(err)
	}
	originalSession := authorizationReceiverRow(t, ctx, database, "task_sessions", "id", first.SessionID)
	barrier := registrationOwnerBarrier{SessionWriter: database, locked: make(chan struct{}), resume: make(chan struct{})}
	var resumeOnce sync.Once
	resume := func() { resumeOnce.Do(func() { close(barrier.resume) }) }
	defer resume()
	var operations sync.WaitGroup
	t.Cleanup(func() {
		cancel()
		resume()
		drained := make(chan struct{})
		go func() { operations.Wait(); close(drained) }()
		select {
		case <-drained:
		case <-time.After(5 * time.Second):
			t.Error("profile/registration operations did not drain")
		}
	})
	type registrationResult struct {
		snapshot sp.Snapshot
		err      error
	}
	retried := make(chan registrationResult, 1)
	operations.Add(1)
	go func() {
		defer operations.Done()
		snapshot, err := sessionservice.New(barrier, engine).RegisterTest(ctx, actorA, registration)
		retried <- registrationResult{snapshot, err}
	}()
	select {
	case <-barrier.locked:
	case <-ctx.Done():
		t.Fatal("registration did not acquire its owner lock", ctx.Err())
	}
	// The retry holds the real owner lock before it reaches its original PAT.
	profileLockProbe(t, ctx, database, `SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT`, user.ID, true)
	name := "profile while registration retries"
	type profileResult struct {
		user model.User
		err  error
	}
	patched := make(chan profileResult, 1)
	operations.Add(1)
	go func() {
		defer operations.Done()
		actual, err := identityservice.New(database, nil, "https://example.test/auth/callback").PatchUser(ctx, actorB, model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: &name}})
		patched <- profileResult{actual, err}
	}()
	waitIdentityLock(t, ctx, database, "UPDATE users SET %")
	// The profile owns B while waiting for the user. It must exclude writers and
	// admit the same shared read that the registration's parent check requires.
	profileLockProbe(t, ctx, database, `SELECT id FROM personal_access_tokens WHERE id=$1 FOR UPDATE NOWAIT`, actorB.CredentialID, true)
	profileLockProbe(t, ctx, database, `SELECT id FROM personal_access_tokens WHERE id=$1 FOR SHARE NOWAIT`, actorB.CredentialID, false)
	resume()
	var retry registrationResult
	select {
	case retry = <-retried:
	case <-ctx.Done():
		t.Fatal("registration retry failed to complete", ctx.Err())
	}
	if retry.err != nil || !reflect.DeepEqual(retry.snapshot.Identity, first.Identity) || retry.snapshot.ControllerFence != first.ControllerFence || retry.snapshot.SessionRevision != first.SessionRevision || retry.snapshot.HistoryEpoch != first.HistoryEpoch || retry.snapshot.Lifecycle != first.Lifecycle || retry.snapshot.ConnectionState != first.ConnectionState || retry.snapshot.InitialInputState != first.InitialInputState {
		t.Fatalf("registration retry changed identity/state: %+v %v", retry.snapshot, retry.err)
	}
	var profile profileResult
	select {
	case profile = <-patched:
	case <-ctx.Done():
		t.Fatal("profile failed to complete", ctx.Err())
	}
	if profile.err != nil || profile.user.ID != user.ID || profile.user.Name == nil || *profile.user.Name != name || profile.user.PersonalTeam.ID != user.PersonalTeam.ID {
		t.Fatalf("profile result: %+v %v", profile.user, profile.err)
	}
	if after := authorizationReceiverRow(t, ctx, database, "task_sessions", "id", first.SessionID); after != originalSession {
		t.Fatalf("retry changed persisted session: before=%s after=%s", originalSession, after)
	}
	var intact bool
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_sessions)=1 AND EXISTS(SELECT FROM task_sessions WHERE id=$1 AND parent_credential_id=$2) AND (SELECT count(*) FROM personal_access_tokens WHERE user_id=$3 AND expires_at=$4)=2 AND EXISTS(SELECT FROM users WHERE id=$3 AND name=$5)`, first.SessionID, actorB.CredentialID, user.ID, expires, name).Scan(&intact); err != nil || !intact {
		t.Fatalf("profile/retry persisted state or PAT expiry changed: %t %v", intact, err)
	}
}

func profileLockProbe(t *testing.T, ctx context.Context, database *Store, query, id string, blocked bool) {
	t.Helper()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var actual string
	err = tx.QueryRow(ctx, query, id).Scan(&actual)
	if blocked {
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || pg.Code != "55P03" {
			t.Fatalf("expected conflicting lock for %q: %v", query, err)
		}
	} else if err != nil || actual != id {
		t.Fatalf("compatible credential reader blocked: id=%q err=%v", actual, err)
	}
}
