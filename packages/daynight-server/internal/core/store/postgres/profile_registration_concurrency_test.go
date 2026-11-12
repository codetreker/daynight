package postgres

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

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
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user, _, _ := testAuthRecords(t, database)
	now := time.Now().UTC().Truncate(time.Microsecond)
	expires := now.Add(time.Hour)
	pats := []model.PersonalAccessToken{
		{ID: uuid.NewString(), UserID: user.ID, TokenHash: deviceStoreHash(uuid.NewString()), Name: "retry", CreatedAt: now, ExpiresAt: &expires},
		{ID: uuid.NewString(), UserID: user.ID, TokenHash: deviceStoreHash(uuid.NewString()), Name: "original", CreatedAt: now, ExpiresAt: &expires},
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
