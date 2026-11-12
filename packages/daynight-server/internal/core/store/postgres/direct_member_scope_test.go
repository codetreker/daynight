package postgres

import (
	"context"
	"errors"
	"net"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const directMemberResource = "https://example.test/api/v1"

func directMembers(db *Store) *teamservice.DirectMembers {
	identity := identityservice.New(db, nil, "https://example.test/auth/callback")
	return teamservice.NewDirectMembers(db, identity.EnsureUser, directMemberResource)
}

func directMemberInput(actor model.Principal, external string, role model.ProjectRole) coreteam.AddTeamMember {
	return coreteam.AddTeamMember{ExpectedUserID: actor.UserID, User: model.User{UniAuthID: external}, Role: role}
}

func directMemberPrincipal(t *testing.T, db *Store, actor model.Principal, kind model.CredentialKind) (model.Principal, string) {
	t.Helper()
	if kind == model.SessionCredential {
		return actor, ""
	}
	if kind == model.PATCredential {
		pat := testutil.DeviceCredential(time.Now().UTC())
		pat.UserID = actor.UserID
		_, err := db.WriteIdentity(t.Context(), func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(t.Context(), pat) })
		if err != nil {
			t.Fatal(err)
		}
		return model.Principal{Kind: kind, UserID: actor.UserID, CredentialID: pat.ID}, ""
	}
	var issued coreoauth.IssuedFamily
	_, err := db.WriteCredentialFamily(t.Context(), func(scope store.CredentialFamilyScope) error {
		var err error
		issued, err = coreoauth.IssueAPIFamily(t.Context(), scope.CredentialFamilyDAO(), actor.UserID, directMemberResource, time.Now())
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return model.Principal{Kind: kind, UserID: actor.UserID, CredentialID: issued.AccessID}, issued.Grant.ID
}

func TestDirectMemberScopeConcurrentEnsuresConvergeWithoutAdvancingMembership(t *testing.T) {
	for _, role := range []model.ProjectRole{model.ProjectAdmin, model.ProjectMemberRole} {
		t.Run(string(role), func(t *testing.T) {
			db, actor, team := storeTeamFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			external := "github:" + uuid.NewString()
			holder, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err := holder.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
				t.Fatal(err)
			}
			type outcome struct {
				result coreteam.DirectMemberResult
				err    error
			}
			results := make(chan outcome, 2)
			for range 2 {
				go func() {
					result, err := directMembers(db).AddMember(ctx, actor, team.ID, directMemberInput(actor, external, role))
					results <- outcome{result, err}
				}()
			}
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text FROM teams WHERE", holder.Conn().PgConn().PID())
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			first, second := <-results, <-results
			if first.err != nil || second.err != nil || first.result.Added == second.result.Added || !reflect.DeepEqual(first.result.Membership, second.result.Membership) {
				t.Fatalf("convergence: %#v %#v", first, second)
			}
			actual := readStoreTeam(t, db, first.result.Membership.UserID, team.ID)
			if actual.Membership != first.result.Membership || actual.Membership.Role != role || actual.Version != team.Version {
				t.Fatalf("persisted result %#v", actual)
			}
			var complete bool
			if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users WHERE uniauth_id=$1)=1 AND (SELECT count(*) FROM team_members WHERE team_id=$2 AND user_id=$3)=1 AND EXISTS(SELECT FROM teams t JOIN team_members m ON m.team_id=t.id WHERE t.personal_user_id=$3 AND m.user_id=$3 AND m.role='admin')`, external, team.ID, actual.Membership.UserID).Scan(&complete); err != nil || !complete {
				t.Fatalf("complete target %t %v", complete, err)
			}
			repeated, err := directMembers(db).AddMember(ctx, actor, team.ID, directMemberInput(actor, external, role))
			if err != nil || repeated.Added || repeated.Membership != actual.Membership {
				t.Fatalf("stable repeat %#v %v", repeated, err)
			}
			otherRole := model.ProjectAdmin
			if role == model.ProjectAdmin {
				otherRole = model.ProjectMemberRole
			}
			rejected, err := directMembers(db).AddMember(ctx, actor, team.ID, directMemberInput(actor, external, otherRole))
			var fault *model.Fault
			if rejected != (coreteam.DirectMemberResult{}) || !errors.As(err, &fault) || fault.Code != "resource_conflict" {
				t.Fatalf("role conflict %#v %v", rejected, err)
			}
			if fresh := readStoreTeam(t, db, actual.Membership.UserID, team.ID); !reflect.DeepEqual(fresh, actual) {
				t.Fatalf("role conflict wrote: %#v %#v", fresh, actual)
			}
		})
	}
}

func TestDirectMemberScopeRechecksRevocationAfterCompleteTarget(t *testing.T) {
	for _, cause := range []string{"admin", "session", "pat", "oauth"} {
		t.Run(cause, func(t *testing.T) {
			db, actor, team := storeTeamFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			grant := ""
			switch cause {
			case "pat":
				actor, grant = directMemberPrincipal(t, db, actor, model.PATCredential)
			case "oauth":
				actor, grant = directMemberPrincipal(t, db, actor, model.OAuthCredential)
			}
			ready := make(chan model.User, 1)
			proceed := make(chan struct{})
			identity := identityservice.New(db, nil, "")
			service := teamservice.NewDirectMembers(db, func(ctx context.Context, input model.User) (model.User, error) {
				user, err := identity.EnsureUser(ctx, input)
				if err != nil {
					return model.User{}, err
				}
				ready <- user
				select {
				case <-proceed:
					return user, nil
				case <-ctx.Done():
					return model.User{}, ctx.Err()
				}
			}, directMemberResource)
			done := make(chan error, 1)
			go func() {
				_, err := service.AddMember(ctx, actor, team.ID, directMemberInput(actor, "github:"+uuid.NewString(), model.ProjectMemberRole))
				done <- err
			}()
			var target model.User
			select {
			case target = <-ready:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			before := authorizationReceiverRow(t, ctx, db, "users", "id", target.ID)
			switch cause {
			case "admin":
				_, other, _ := testAuthRecords(t, db)
				mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team.ID, other.UserID)
				_, err := db.WriteTeam(ctx, team.ID, func(scope store.TeamWriteScope) error {
					_, err := scope.TeamDAO().SetMemberRole(ctx, actor.UserID, model.ProjectMemberRole)
					return err
				})
				if err != nil {
					t.Fatal(err)
				}
			case "session":
				mustQueryExec(t, db, `DELETE FROM sessions WHERE id=$1`, actor.CredentialID)
			case "pat":
				mustQueryExec(t, db, `DELETE FROM personal_access_tokens WHERE id=$1`, actor.CredentialID)
			case "oauth":
				_, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
					_, err := scope.CredentialFamilyDAO().RevokeFamily(ctx, grant, time.Now())
					return err
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			close(proceed)
			err := testutil.ReceiveQueryResult(t, ctx, done)
			var fault *model.Fault
			want := "unauthenticated"
			if cause == "admin" {
				want = "forbidden"
			}
			if !errors.As(err, &fault) || fault.Code != want {
				t.Fatalf("revoked actor admitted: %v", err)
			}
			var valid bool
			if err := db.Pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM team_members WHERE team_id=$1 AND user_id=$2) AND EXISTS(SELECT FROM teams t JOIN team_members m ON m.team_id=t.id WHERE t.personal_user_id=$2 AND m.user_id=$2 AND m.role='admin')`, team.ID, target.ID).Scan(&valid); err != nil || !valid {
				t.Fatalf("partial target/join %t %v", valid, err)
			}
			if after := authorizationReceiverRow(t, ctx, db, "users", "id", target.ID); after != before {
				t.Fatalf("completed target changed: %s %s", before, after)
			}
		})
	}
}

func TestDirectMemberScopeRechecksExpiryAfterTargetMemberWait(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential, model.OAuthCredential} {
		t.Run(string(kind), func(t *testing.T) {
			db, actor, team := storeTeamFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			var grantID string
			actor, grantID = directMemberPrincipal(t, db, actor, kind)
			target, _, _ := testAuthRecords(t, db)
			mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, target.ID)
			before := readStoreTeam(t, db, target.ID, team.ID).Membership
			expires := time.Now().UTC().Add(2 * time.Second)
			table := map[model.CredentialKind]string{model.SessionCredential: "sessions", model.PATCredential: "personal_access_tokens", model.OAuthCredential: "oauth_access_tokens"}[kind]
			mustQueryExec(t, db, `UPDATE `+table+` SET expires_at=$2 WHERE id=$1`, actor.CredentialID, expires)
			holder, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err := holder.Exec(ctx, `SELECT user_id FROM team_members WHERE team_id=$1 AND user_id=$2 FOR UPDATE`, team.ID, target.ID); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := directMembers(db).AddMember(ctx, actor, team.ID, directMemberInput(actor, target.UniAuthID, model.ProjectMemberRole))
				done <- err
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT team_id::text,user_id::text,role,version,created_at,updated_at FROM team_members", holder.Conn().PgConn().PID())
			// A queued revocation must not prevent compatible Session admission from
			// sharing the credential held by the member operation.
			revocation := make(chan error, 1)
			mutationSQL, mutationID := `DELETE FROM `+table+` WHERE id=$1`, actor.CredentialID
			if kind == model.OAuthCredential {
				mutationSQL, mutationID = `UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1`, grantID
			}
			go func() { _, err := db.Pool.Exec(ctx, mutationSQL, mutationID); revocation <- err }()
			testutil.WaitForQueryLock(t, db.Pool, mutationSQL)
			c, err := db.WriteSession(ctx, func(scope store.SessionScope) error {
				if kind == model.OAuthCredential {
					return scope.SessionDAO().LockOAuthCredential(ctx, actor, []store.OAuthBinding{{Resource: directMemberResource, Scope: coreoauth.APIScope, ClientID: coreoauth.APIClientID}}, time.Now())
				}
				return scope.SessionDAO().LockCredential(ctx, actor, time.Now())
			})
			if err != nil || c.Outcome != store.TransactionCommitted {
				t.Fatalf("compatible Session credential reader blocked behind revocation: %#v %v", c, err)
			}
			for {
				var expired bool
				if err := db.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expires).Scan(&expired); err != nil {
					t.Fatal(err)
				}
				if expired {
					break
				}
				if err := testutil.WaitThreadClock(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = testutil.ReceiveQueryResult(t, ctx, done)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
				t.Fatalf("expired actor admitted: %v", err)
			}
			if after := readStoreTeam(t, db, target.ID, team.ID).Membership; after != before {
				t.Fatalf("membership changed: %#v %#v", before, after)
			}
			if err := testutil.ReceiveQueryResult(t, ctx, revocation); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDirectMemberScopeEligibilityFailureRollsBackMembershipButRetainsAccount(t *testing.T) {
	db, actor, team := storeTeamFixture(t)
	ctx := t.Context()
	target, _, _ := testAuthRecords(t, db)
	project, subscription := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Orphaned subscribed Project','https://example.test/project')`, project)
	mustQueryExec(t, db, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now())`, subscription, uuid.NewString(), project, target.ID)
	before := authorizationReceiverRow(t, ctx, db, "users", "id", target.ID)
	result, err := directMembers(db).AddMember(ctx, actor, team.ID, directMemberInput(actor, target.UniAuthID, model.ProjectMemberRole))
	var failure *store.TransactionError
	if result != (coreteam.DirectMemberResult{}) || !errors.As(err, &failure) || failure.Outcome != store.TransactionNotCommitted {
		t.Fatalf("eligibility failure %#v %v", result, err)
	}
	var valid bool
	if err := db.Pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM team_members WHERE team_id=$1 AND user_id=$2) AND EXISTS(SELECT FROM webhook_subscriptions WHERE id=$3 AND authorization_state='active' AND authorization_epoch=1)`, team.ID, target.ID, subscription).Scan(&valid); err != nil || !valid {
		t.Fatalf("partial cross-DAO commit %t %v", valid, err)
	}
	if after := authorizationReceiverRow(t, ctx, db, "users", "id", target.ID); after != before {
		t.Fatalf("completed account changed: %s %s", before, after)
	}
}

func TestDirectMemberScopeLostFinalCommitAcknowledgementReturnsUnknown(t *testing.T) {
	db, actor, team := storeTeamFixture(t)
	ctx := t.Context()
	var armed, lost atomic.Bool
	config := db.Pool.Config().Copy()
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
	lossy := &Store{Pool: pool}
	identity := identityservice.New(db, nil, "")
	targetID := ""
	service := teamservice.NewDirectMembers(lossy, func(ctx context.Context, input model.User) (model.User, error) {
		user, err := identity.EnsureUser(ctx, input)
		if err == nil {
			targetID = user.ID
			armed.Store(true)
		}
		return user, err
	}, directMemberResource)
	result, err := service.AddMember(ctx, actor, team.ID, directMemberInput(actor, "github:"+uuid.NewString(), model.ProjectMemberRole))
	var failure *store.TransactionError
	if result != (coreteam.DirectMemberResult{}) || !lost.Load() || !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown || !failure.CommitAttempted {
		t.Fatalf("unknown final receipt %#v lost=%t error=%v", result, lost.Load(), err)
	}
	actual := readStoreTeam(t, db, targetID, team.ID).Membership
	if actual.UserID != targetID || actual.Role != model.ProjectMemberRole || actual.Version < 1 {
		t.Fatalf("durable join %#v", actual)
	}
}

func TestDirectMemberScopeExpiryDuringEligibilityWaitRollsBackNewMembership(t *testing.T) {
	db, actor, team := storeTeamFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	actor, _ = directMemberPrincipal(t, db, actor, model.OAuthCredential)
	target, _, _ := testAuthRecords(t, db)
	project, subscription := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Team-owned Project','https://example.test/project')`, project)
	mustQueryExec(t, db, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team.ID)
	mustQueryExec(t, db, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'confirmation_required',1,now(),now())`, subscription, uuid.NewString(), project, target.ID)
	before := authorizationReceiverRow(t, ctx, db, "webhook_subscriptions", "id", subscription)
	expires := time.Now().UTC().Add(2 * time.Second)
	mustQueryExec(t, db, `UPDATE oauth_access_tokens SET expires_at=$2 WHERE id=$1`, actor.CredentialID, expires)
	holder, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err := holder.Exec(ctx, `SELECT id FROM webhook_subscriptions WHERE id=$1 FOR UPDATE`, subscription); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := directMembers(db).AddMember(ctx, actor, team.ID, directMemberInput(actor, target.UniAuthID, model.ProjectMemberRole))
		done <- err
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT s.id::text,s.project_id::text", holder.Conn().PgConn().PID())
	for {
		var expired bool
		if err := db.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expires).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	err = testutil.ReceiveQueryResult(t, ctx, done)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
		t.Fatalf("expiry during eligibility wait admitted: %v", err)
	}
	var absent bool
	if err := db.Pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM team_members WHERE team_id=$1 AND user_id=$2)`, team.ID, target.ID).Scan(&absent); err != nil || !absent {
		t.Fatalf("new membership survived expired API admission: %t %v", absent, err)
	}
	if after := authorizationReceiverRow(t, ctx, db, "webhook_subscriptions", "id", subscription); after != before {
		t.Fatalf("eligibility changed: %s %s", before, after)
	}
}
