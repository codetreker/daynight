package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/google/uuid"
)

func TestRegisteredMemberConcurrentAddsConvergeAndPreserveAdmin(t *testing.T) {
	db, actor, team := storeTeamFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	target, _, _ := testAuthRecords(t, db)
	holder, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err = holder.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		result coreteam.ExistingMemberResult
		err    error
	}
	results := make(chan outcome, 2)
	for range 2 {
		go func() {
			result, err := directMembers(db).AddExistingMember(ctx, actor, team.ID, target.ID, actor.UserID)
			results <- outcome{result, err}
		}()
	}
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text FROM teams WHERE", holder.Conn().PgConn().PID())
	if err = holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	first, second := <-results, <-results
	if first.err != nil || second.err != nil || first.result.Added == second.result.Added || !reflect.DeepEqual(first.result.Membership, second.result.Membership) {
		t.Fatalf("convergence: %+v %+v", first, second)
	}
	actual := readStoreTeam(t, db, target.ID, team.ID)
	if actual.Membership != first.result.Membership.Membership || actual.Membership.Role != model.ProjectMemberRole || actual.Version != team.Version {
		t.Fatalf("persisted: %+v", actual)
	}
	var count int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, target.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("count %d: %v", count, err)
	}
	mustQueryExec(t, db, `UPDATE team_members SET role='admin' WHERE team_id=$1 AND user_id=$2`, team.ID, target.ID)
	before := readStoreTeam(t, db, target.ID, team.ID).Membership
	got, err := directMembers(db).AddExistingMember(ctx, actor, team.ID, target.ID, actor.UserID)
	if err != nil || got.Added || got.Membership.Membership != before || before.Role != model.ProjectAdmin {
		t.Fatalf("admin changed: %+v %v", got, err)
	}
	if after := readStoreTeam(t, db, target.ID, team.ID).Membership; after != before {
		t.Fatalf("admin mutation: %+v %+v", before, after)
	}
}

func TestRegisteredMemberRechecksActorAfterTeamLockWait(t *testing.T) {
	for _, cause := range []string{"admin", "session"} {
		t.Run(cause, func(t *testing.T) {
			db, actor, team := storeTeamFixture(t)
			target, _, _ := testAuthRecords(t, db)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			holder, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err = holder.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := directMembers(db).AddExistingMember(ctx, actor, team.ID, target.ID, actor.UserID)
				done <- err
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text FROM teams WHERE", holder.Conn().PgConn().PID())
			if cause == "admin" {
				_, err = holder.Exec(ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, team.ID, actor.UserID)
			} else {
				_, err = holder.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, actor.CredentialID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			err = testutil.ReceiveQueryResult(t, ctx, done)
			var fault *model.Fault
			want := "unauthenticated"
			if cause == "admin" {
				want = "forbidden"
			}
			if !errors.As(err, &fault) || fault.Code != want {
				t.Fatalf("revoked actor admitted: %v", err)
			}
			var absent bool
			if err = db.Pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM team_members WHERE team_id=$1 AND user_id=$2)`, team.ID, target.ID).Scan(&absent); err != nil || !absent {
				t.Fatalf("membership created %v %v", absent, err)
			}
		})
	}
}

func TestRegisteredMemberEligibilityFailureRollsBackJoin(t *testing.T) {
	db, actor, team := storeTeamFixture(t)
	ctx := t.Context()
	target, _, _ := testAuthRecords(t, db)
	project, subscription := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Orphaned subscribed Project','https://example.test/project')`, project)
	mustQueryExec(t, db, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now())`, subscription, uuid.NewString(), project, target.ID)
	before := authorizationReceiverRow(t, ctx, db, "users", "id", target.ID)
	result, err := directMembers(db).AddExistingMember(ctx, actor, team.ID, target.ID, actor.UserID)
	var failure *store.TransactionError
	if result != (coreteam.ExistingMemberResult{}) || !errors.As(err, &failure) || failure.Outcome != store.TransactionNotCommitted {
		t.Fatalf("eligibility failure %+v %v", result, err)
	}
	var valid bool
	if err = db.Pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM team_members WHERE team_id=$1 AND user_id=$2) AND EXISTS(SELECT FROM webhook_subscriptions WHERE id=$3 AND authorization_state='active' AND authorization_epoch=1)`, team.ID, target.ID, subscription).Scan(&valid); err != nil || !valid {
		t.Fatalf("partial commit %v %v", valid, err)
	}
	if after := authorizationReceiverRow(t, ctx, db, "users", "id", target.ID); after != before {
		t.Fatalf("user changed: %s %s", before, after)
	}
}

func TestRegisteredMemberExpiryDuringEligibilityWaitRollsBackJoin(t *testing.T) {
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
	if _, err = holder.Exec(ctx, `SELECT id FROM webhook_subscriptions WHERE id=$1 FOR UPDATE`, subscription); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := directMembers(db).AddExistingMember(ctx, actor, team.ID, target.ID, actor.UserID)
		done <- err
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT s.id::text,s.project_id::text", holder.Conn().PgConn().PID())
	for {
		var expired bool
		if err = db.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expires).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		if err = testutil.WaitThreadClock(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err = holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	err = testutil.ReceiveQueryResult(t, ctx, done)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
		t.Fatalf("expired credential admitted: %v", err)
	}
	var absent bool
	if err = db.Pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM team_members WHERE team_id=$1 AND user_id=$2)`, team.ID, target.ID).Scan(&absent); err != nil || !absent {
		t.Fatalf("membership survived: %v %v", absent, err)
	}
	if after := authorizationReceiverRow(t, ctx, db, "webhook_subscriptions", "id", subscription); after != before {
		t.Fatalf("eligibility changed: %s %s", before, after)
	}
}

func TestRegisteredMemberMissingUserDoesNotInitializeOrRevokeTeamAccess(t *testing.T) {
	db, actor, team := storeTeamFixture(t)
	ctx := t.Context()
	target := uuid.NewString()
	before := readStoreTeam(t, db, actor.UserID, team.ID)
	var usersBefore, personalBefore, membersBefore int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM teams WHERE personal_user_id IS NOT NULL),(SELECT count(*) FROM team_members)`).Scan(&usersBefore, &personalBefore, &membersBefore); err != nil {
		t.Fatal(err)
	}
	result, err := directMembers(db).AddExistingMember(ctx, actor, team.ID, target, actor.UserID)
	var fault *model.Fault
	if result != (coreteam.ExistingMemberResult{}) || !errors.As(err, &fault) || fault.Code != "user_not_found" || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing target: %+v %v", result, err)
	}
	var usersAfter, personalAfter, membersAfter int
	var absent bool
	if err = db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM teams WHERE personal_user_id IS NOT NULL),(SELECT count(*) FROM team_members), NOT EXISTS(SELECT FROM users WHERE id=$1) AND NOT EXISTS(SELECT FROM teams WHERE personal_user_id=$1) AND NOT EXISTS(SELECT FROM team_members WHERE user_id=$1)`, target).Scan(&usersAfter, &personalAfter, &membersAfter, &absent); err != nil {
		t.Fatal(err)
	}
	if !absent || usersAfter != usersBefore || personalAfter != personalBefore || membersAfter != membersBefore {
		t.Fatalf("missing target changed data: absent=%v counts %d/%d/%d to %d/%d/%d", absent, usersBefore, personalBefore, membersBefore, usersAfter, personalAfter, membersAfter)
	}
	if after := readStoreTeam(t, db, actor.UserID, team.ID); !reflect.DeepEqual(after, before) {
		t.Fatalf("actor Team access changed: %+v %+v", before, after)
	}
}

func TestRegisteredMemberCancellationDuringEligibilityWaitRollsBackJoin(t *testing.T) {
	db, actor, team := storeTeamFixture(t)
	ctx, stop := context.WithTimeout(t.Context(), 15*time.Second)
	defer stop()
	target, _, _ := testAuthRecords(t, db)
	project, subscription := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Team-owned Project','https://example.test/project')`, project)
	mustQueryExec(t, db, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team.ID)
	mustQueryExec(t, db, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'confirmation_required',1,now(),now())`, subscription, uuid.NewString(), project, target.ID)
	before := authorizationReceiverRow(t, ctx, db, "webhook_subscriptions", "id", subscription)
	holder, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err = holder.Exec(ctx, `SELECT id FROM webhook_subscriptions WHERE id=$1 FOR UPDATE`, subscription); err != nil {
		t.Fatal(err)
	}
	request, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := directMembers(db).AddExistingMember(request, actor, team.ID, target.ID, actor.UserID)
		done <- err
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT s.id::text,s.project_id::text", holder.Conn().PgConn().PID())
	cancel()
	err = testutil.ReceiveQueryResult(t, ctx, done)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
	if err = holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var absent bool
	if err = db.Pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM team_members WHERE team_id=$1 AND user_id=$2)`, team.ID, target.ID).Scan(&absent); err != nil || !absent {
		t.Fatalf("membership survived: %v %v", absent, err)
	}
	if after := authorizationReceiverRow(t, ctx, db, "webhook_subscriptions", "id", subscription); after != before {
		t.Fatalf("eligibility changed: %s %s", before, after)
	}
}
