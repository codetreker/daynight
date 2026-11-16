package postgres

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	githubdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func appAdminScopeFixture(t *testing.T) (*Store, string, model.Principal, model.Principal, model.Principal) {
	t.Helper()
	db := isolatedStore(t)
	users := []model.Principal{{UserID: uuid.NewString()}, {UserID: uuid.NewString()}, {UserID: uuid.NewString()}}
	for _, p := range users {
		mustQueryExec(t, db, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, p.UserID, p.UserID)
	}
	appID := uuid.NewString()
	c, err := db.WriteGitHubApp(t.Context(), func(w store.GitHubAppWriteDAO) error {
		_, err := w.Create(t.Context(), store.GitHubAppCreate{ID: appID, GitHubAppID: 123, Name: "Automation", GitHubName: "Remote", GitHubSlug: "remote", CreatorUserID: users[0].UserID, Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("key"), WebhookSecret: []byte("secret")}})
		return err
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("create fixture: %+v %v", c, err)
	}
	return db, appID, users[0], users[1], users[2]
}

func mintAppAdminInvitation(t *testing.T, db *Store, appID string, actor model.Principal) core.MintedAdminInvitation {
	t.Helper()
	var minted core.MintedAdminInvitation
	c, err := db.WriteGitHubAppAdmins(t.Context(), appID, func(w store.GitHubAppAdminWriter) error {
		var err error
		minted, err = core.CreateAdminInvitation(t.Context(), w, actor, appID)
		return err
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("mint invitation: %+v %v", c, err)
	}
	return minted
}

func readAppAdminMembership(t *testing.T, db *Store, appID, userID string) githubpr.AdminMembership {
	t.Helper()
	var member githubpr.AdminMembership
	if err := db.ReadGitHubAppAdmins(t.Context(), func(r store.GitHubAppAdminReader) error {
		var err error
		member, err = r.Membership(t.Context(), appID, userID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return member
}

func serializedAppAdminOperations(t *testing.T, db *Store, appID string, first, second func(context.Context, store.GitHubAppAdminWriter) error) (store.Completion, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	type result struct {
		completion store.Completion
		err        error
	}
	done := make(chan result, 1)
	started, received := false, false
	defer func() {
		cancel()
		if started && !received {
			<-done
		}
	}()
	c, err := db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error {
		if err := first(ctx, w); err != nil {
			return err
		}
		started = true
		go func() {
			completion, err := db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error { return second(ctx, w) })
			done <- result{completion, err}
		}()
		waitForQueryLock(t, db, "SELECT id::text FROM github_apps WHERE")
		return nil
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("first serialized mutation: %+v %v", c, err)
	}
	select {
	case r := <-done:
		received = true
		return r.completion, r.err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return store.Completion{}, ctx.Err()
	}
}

func TestAppAdminScopeSerializesAcceptAndRevoke(t *testing.T) {
	for _, acceptFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "revoke first", true: "accept first"}[acceptFirst], func(t *testing.T) {
			db, appID, issuer, joiner, _ := appAdminScopeFixture(t)
			invite := mintAppAdminInvitation(t, db, appID, issuer)
			var accepted core.AdminInvitationAcceptance
			var revoked core.AdminInvitationRevocation
			accept := func(ctx context.Context, w store.GitHubAppAdminWriter) error {
				var err error
				accepted, err = core.AcceptAdminInvitation(ctx, w, joiner, invite.Secret)
				return err
			}
			revoke := func(ctx context.Context, w store.GitHubAppAdminWriter) error {
				var err error
				revoked, err = core.RevokeAdminInvitation(ctx, w, issuer, appID, invite.Invitation.ID)
				return err
			}
			first, second := revoke, accept
			if acceptFirst {
				first, second = accept, revoke
			}
			c, err := serializedAppAdminOperations(t, db, appID, first, second)
			if acceptFirst {
				if err != nil || c.Outcome != store.TransactionCommitted || !accepted.Joined || revoked.Changed {
					t.Fatalf("accept then revoke: %+v %+v %+v %v", accepted, revoked, c, err)
				}
				if got := readAppAdminMembership(t, db, appID, joiner.UserID); got.Version != accepted.Membership.Version {
					t.Fatalf("accepted membership changed: %+v", got)
				}
			} else {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "invitation_unavailable" || c.Outcome != store.TransactionNotCommitted || !revoked.Changed {
					t.Fatalf("revoke then accept: %+v %+v %v", revoked, c, err)
				}
				var count int
				if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM github_app_admins WHERE app_resource_id=$1 AND user_id=$2`, appID, joiner.UserID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("rejected accept inserted membership: %d %v", count, err)
				}
			}
			var consumed, revokedAt *time.Time
			if err := db.Pool.QueryRow(t.Context(), `SELECT consumed_at,revoked_at FROM github_app_admin_invitations WHERE id=$1`, invite.Invitation.ID).Scan(&consumed, &revokedAt); err != nil || (consumed != nil) != acceptFirst || (revokedAt != nil) == acceptFirst {
				t.Fatalf("durable terminal state: consumed=%v revoked=%v err=%v", consumed, revokedAt, err)
			}
		})
	}
}

func TestAppAdminScopeSerializesIssuerRemovalAndAccept(t *testing.T) {
	for _, acceptFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "remove issuer first", true: "accept first"}[acceptFirst], func(t *testing.T) {
			db, appID, issuer, remaining, joiner := appAdminScopeFixture(t)
			c, err := db.WriteGitHubAppAdmins(t.Context(), appID, func(w store.GitHubAppAdminWriter) error {
				_, err := w.AddAdmin(t.Context(), appID, remaining.UserID)
				return err
			})
			if err != nil || c.Outcome != store.TransactionCommitted {
				t.Fatal(err)
			}
			member := readAppAdminMembership(t, db, appID, issuer.UserID)
			invite := mintAppAdminInvitation(t, db, appID, issuer)
			accept := func(ctx context.Context, w store.GitHubAppAdminWriter) error {
				_, err := core.AcceptAdminInvitation(ctx, w, joiner, invite.Secret)
				return err
			}
			remove := func(ctx context.Context, w store.GitHubAppAdminWriter) error {
				_, err := core.RemoveAdmin(ctx, w, remaining, appID, issuer.UserID, member.Version)
				return err
			}
			first, second := remove, accept
			if acceptFirst {
				first, second = accept, remove
			}
			c, err = serializedAppAdminOperations(t, db, appID, first, second)
			if acceptFirst {
				if err != nil || c.Outcome != store.TransactionCommitted {
					t.Fatalf("accept first: %+v %v", c, err)
				}
			} else {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "invitation_unavailable" || c.Outcome != store.TransactionNotCommitted {
					t.Fatalf("remove first: %+v %v", c, err)
				}
			}
			var issuerRows, joinerRows int
			if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FILTER(WHERE user_id=$2),count(*) FILTER(WHERE user_id=$3) FROM github_app_admins WHERE app_resource_id=$1`, appID, issuer.UserID, joiner.UserID).Scan(&issuerRows, &joinerRows); err != nil || issuerRows != 0 || joinerRows != map[bool]int{false: 0, true: 1}[acceptFirst] {
				t.Fatalf("durable members: issuer=%d joiner=%d err=%v", issuerRows, joinerRows, err)
			}
		})
	}
}

func TestAppAdminScopeLastAdminAndRejoinCannotRestoreOldInvite(t *testing.T) {
	db, appID, first, second, joiner := appAdminScopeFixture(t)
	ctx := t.Context()
	c, err := db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error { _, err := w.AddAdmin(ctx, appID, second.UserID); return err })
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatal(err)
	}
	firstBefore, secondBefore := readAppAdminMembership(t, db, appID, first.UserID), readAppAdminMembership(t, db, appID, second.UserID)
	oldInvite := mintAppAdminInvitation(t, db, appID, first)
	var removal core.AdminRemoval
	c, err = serializedAppAdminOperations(t, db, appID, func(ctx context.Context, w store.GitHubAppAdminWriter) error {
		var err error
		removal, err = core.RemoveAdmin(ctx, w, first, appID, first.UserID, firstBefore.Version)
		return err
	}, func(ctx context.Context, w store.GitHubAppAdminWriter) error {
		_, err := core.RemoveAdmin(ctx, w, second, appID, second.UserID, secondBefore.Version)
		return err
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "last_admin" || c.Outcome != store.TransactionNotCommitted || !removal.Removed || removal.ActorIsAdmin {
		t.Fatalf("last administrator: %+v %+v %v", removal, c, err)
	}
	freshInvite := mintAppAdminInvitation(t, db, appID, second)
	c, err = db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error {
		_, err := core.AcceptAdminInvitation(ctx, w, first, freshInvite.Secret)
		return err
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("rejoin: %+v %v", c, err)
	}
	if current := readAppAdminMembership(t, db, appID, first.UserID); current.Version <= firstBefore.Version {
		t.Fatalf("rejoin reused membership version: %+v", current)
	}
	if err := db.ReadGitHubAppAdmins(ctx, func(r store.GitHubAppAdminReader) error {
		_, err := core.InspectAdminInvitation(ctx, r, joiner, oldInvite.Secret)
		return err
	}); !errors.As(err, &fault) || fault.Code != "invitation_unavailable" {
		t.Fatalf("rejoined issuer inspect: %v", err)
	}
	c, err = db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error {
		_, err := core.AcceptAdminInvitation(ctx, w, joiner, oldInvite.Secret)
		return err
	})
	if !errors.As(err, &fault) || fault.Code != "invitation_unavailable" || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rejoined issuer accept: %+v %v", c, err)
	}
	c, err = db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error {
		_, err := core.RemoveAdmin(ctx, w, second, appID, first.UserID, firstBefore.Version)
		return err
	})
	if !errors.As(err, &fault) || fault.Code != "version_conflict" || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("old membership deletion: %+v %v", c, err)
	}
}

func TestAppAdminScopeRollbackCancellationAndMissingApp(t *testing.T) {
	db, appID, issuer, joiner, _ := appAdminScopeFixture(t)
	ctx := t.Context()
	refused := errors.New("abort after mutation")
	c, err := db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error {
		if _, err := w.AddAdmin(ctx, appID, joiner.UserID); err != nil {
			return err
		}
		return refused
	})
	if !errors.Is(err, refused) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("callback refusal: %+v %v", c, err)
	}
	if err := db.ReadGitHubAppAdmins(ctx, func(r store.GitHubAppAdminReader) error {
		_, err := r.Membership(ctx, appID, joiner.UserID)
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("rolled-back membership persisted: %v", err)
	}
	holder, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err := holder.Exec(ctx, `SELECT id FROM github_apps WHERE id=$1 FOR UPDATE`, appID); err != nil {
		t.Fatal(err)
	}
	waiting, cancel := context.WithCancel(ctx)
	var called atomic.Bool
	done := make(chan error, 1)
	defer cancel()
	go func() {
		_, err := db.WriteGitHubAppAdmins(waiting, appID, func(store.GitHubAppAdminWriter) error { called.Store(true); return nil })
		done <- err
	}()
	waitForQueryLock(t, db, "SELECT id::text FROM github_apps WHERE")
	cancel()
	bounded, finish := context.WithTimeout(context.Background(), 5*time.Second)
	defer finish()
	if err := receiveQueryResult(t, bounded, done); !errors.Is(err, context.Canceled) || called.Load() {
		t.Fatalf("cancelled lock callback: called=%v err=%v", called.Load(), err)
	}
	if err := holder.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readAppAdminMembership(t, db, appID, issuer.UserID); got.UserID != issuer.UserID {
		t.Fatal(got)
	}
	for _, id := range []string{uuid.NewString(), appID} {
		if id == appID {
			mustQueryExec(t, db, `UPDATE github_apps SET deleted_at=now(),private_key_pem=NULL,webhook_secret=NULL WHERE id=$1`, appID)
		}
		called := false
		c, err := db.WriteGitHubAppAdmins(ctx, id, func(store.GitHubAppAdminWriter) error { called = true; return nil })
		if called || !errors.Is(err, model.ErrNotFound) || c.Outcome != store.TransactionNotCommitted {
			t.Fatalf("missing/deleted App: called=%v %+v %v", called, c, err)
		}
	}
	closed := closedStore(t)
	if _, err := closed.WriteGitHubAppAdmins(ctx, appID, func(store.GitHubAppAdminWriter) error { t.Fatal("closed pool callback"); return nil }); err == nil {
		t.Fatal("closed write pool accepted")
	}
	if err := closed.ReadGitHubAppAdmins(ctx, func(store.GitHubAppAdminReader) error { t.Fatal("closed pool callback"); return nil }); err == nil {
		t.Fatal("closed read pool accepted")
	}
}

func TestAppAdminLostCommitResponsePreservesUnknownAndDurableState(t *testing.T) {
	db, appID, _, joiner, _ := appAdminScopeFixture(t)
	ctx := t.Context()
	tx, err := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("private App administrator commit reply lost")
	err = transact(ctx, &threadCommitResponseLoss{Tx: tx, cause: lost}, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT id FROM github_apps WHERE id=$1 FOR UPDATE`, appID); err != nil {
			return err
		}
		_, err := githubdao.NewAppAdminWriter(tx, appID).AddAdmin(ctx, appID, joiner.UserID)
		return err
	})
	c, err := teamCompletion("App administrator lost commit", err)
	if !errors.Is(err, lost) || c.Outcome != store.TransactionUnknown {
		t.Fatalf("unknown completion: %+v %v", c, err)
	}
	if got := readAppAdminMembership(t, db, appID, joiner.UserID); got.UserID != joiner.UserID {
		t.Fatalf("unknown write did not persist actual state: %+v", got)
	}
}
