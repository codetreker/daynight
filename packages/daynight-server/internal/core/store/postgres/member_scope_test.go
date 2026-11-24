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
	"github.com/jackc/pgx/v5/pgconn"
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
	holder, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err = holder.Exec(ctx, `SELECT id FROM webhook_subscriptions WHERE id=$1 FOR UPDATE`, subscription); err != nil {
		t.Fatal(err)
	}
	expires := testutil.ArmCredentialExpiry(t, ctx, db.Pool, "oauth_access_tokens", actor.CredentialID, 2)
	done := make(chan error, 1)
	go func() {
		_, err := directMembers(db).AddExistingMember(ctx, actor, team.ID, target.ID, actor.UserID)
		done <- err
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT s.id::text,s.project_id::text", holder.Conn().PgConn().PID())
	testutil.WaitForCredentialExpiry(t, ctx, db.Pool, expires)
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

// Resolution uses the actual credential and Team transaction and persists no business changes.
func TestMemberResolutionScopeAuthorizationAndReadOnly(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, actor, team := storeTeamFixture(t)
	ctx := t.Context()
	admin, _, _ := testAuthRecords(t, db)
	member, memberActor, _ := testAuthRecords(t, db)
	outsider, _, _ := testAuthRecords(t, db)
	mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')`, team.ID, admin.ID, member.ID)
	service := directMembers(db)
	input := func(p model.Principal, external string) coreteam.ResolveTeamMember {
		return coreteam.ResolveTeamMember{ExpectedUserID: p.UserID, ExternalUserID: external}
	}
	snapshot := func() string {
		t.Helper()
		var value string
		err := db.Pool.QueryRow(ctx, `SELECT json_build_array(
 (SELECT json_agg(row_to_json(u) ORDER BY u.id) FROM users u),
 (SELECT json_agg(row_to_json(t) ORDER BY t.id) FROM teams t),
 (SELECT json_agg(row_to_json(m) ORDER BY m.team_id,m.user_id) FROM team_members m),
 (SELECT count(*) FROM sessions), (SELECT count(*) FROM personal_access_tokens),
 (SELECT count(*) FROM oauth_grants), (SELECT count(*) FROM oauth_access_tokens),
 (SELECT count(*) FROM oauth_refresh_tokens))::text`).Scan(&value)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	unchanged := func(before string) {
		t.Helper()
		if snapshot() != before {
			t.Fatal("resolution changed users, Teams, memberships or credential counts")
		}
	}
	for _, target := range []model.User{admin, member} {
		before := snapshot()
		want := readStoreTeam(t, db, target.ID, team.ID).Membership
		got, err := service.ResolveMember(ctx, actor, team.ID, input(actor, target.UniAuthID))
		if err != nil || got == nil || *got != want {
			t.Fatalf("existing member: got %#v, want %#v, error %v", got, want, err)
		}
		unchanged(before)
	}
	for _, external := range []string{outsider.UniAuthID, "missing:" + uuid.NewString()} {
		before := snapshot()
		got, err := service.ResolveMember(ctx, actor, team.ID, input(actor, external))
		if err != nil || got != nil {
			t.Fatalf("absent mapping: %#v %v", got, err)
		}
		unchanged(before)
	}
	var personalID string
	if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM teams WHERE personal_user_id=$1`, actor.UserID).Scan(&personalID); err != nil {
		t.Fatal(err)
	}
	issuer := actor
	issuer.Kind = "issuer"
	wrong := input(actor, member.UniAuthID)
	wrong.ExpectedUserID = uuid.NewString()
	for _, tc := range []struct {
		name, team, code string
		principal        model.Principal
		input            coreteam.ResolveTeamMember
	}{
		{"member", team.ID, "forbidden", memberActor, input(memberActor, admin.UniAuthID)},
		{"wrong actor", team.ID, "identity_mismatch", actor, wrong},
		{"issuer", team.ID, "unauthenticated", issuer, input(issuer, member.UniAuthID)},
		{"foreign Team", outsider.PersonalTeam.ID, "not_found", actor, input(actor, member.UniAuthID)},
		{"personal Team", personalID, "personal_team_immutable", actor, input(actor, member.UniAuthID)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := snapshot()
			got, err := service.ResolveMember(ctx, tc.principal, tc.team, tc.input)
			var fault *model.Fault
			if got != nil || !errors.As(err, &fault) || fault.Code != tc.code {
				t.Fatalf("refusal: %#v %v, want %s", got, err, tc.code)
			}
			unchanged(before)
		})
	}
	before := snapshot()
	got, err := service.ResolveMember(ctx, actor, uuid.NewString(), input(actor, member.UniAuthID))
	if got != nil || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Team: %#v %v", got, err)
	}
	unchanged(before)
	mustQueryExec(t, db, `DELETE FROM sessions WHERE id=$1`, actor.CredentialID)
	before = snapshot()
	got, err = service.ResolveMember(ctx, actor, team.ID, input(actor, member.UniAuthID))
	var fault *model.Fault
	if got != nil || !errors.As(err, &fault) || fault.Code != "unauthenticated" {
		t.Fatalf("revoked credential: %#v %v", got, err)
	}
	unchanged(before)
}

func TestMemberResolutionScopeObservesChangesDuringTeamLockWait(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, change := range []string{"admin", "credential", "membership"} {
		t.Run(change, func(t *testing.T) {
			db, actor, team := storeTeamFixture(t)
			target, _, _ := testAuthRecords(t, db)
			other, _, _ := testAuthRecords(t, db)
			mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'admin')`, team.ID, target.ID, other.ID)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			tx, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := tx.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
				t.Fatal(err)
			}
			type outcome struct {
				member *model.TeamMember
				err    error
			}
			done := make(chan outcome, 1)
			go func() {
				member, err := directMembers(db).ResolveMember(ctx, actor, team.ID, coreteam.ResolveTeamMember{ExpectedUserID: actor.UserID, ExternalUserID: target.UniAuthID})
				done <- outcome{member, err}
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text FROM teams WHERE", tx.Conn().PgConn().PID())
			switch change {
			case "admin":
				_, err = tx.Exec(ctx, `UPDATE team_members SET role='member',version=nextval('team_member_versions') WHERE team_id=$1 AND user_id=$2`, team.ID, actor.UserID)
			case "credential":
				_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, actor.CredentialID)
			case "membership":
				_, err = tx.Exec(ctx, `UPDATE team_members SET role='admin',version=nextval('team_member_versions') WHERE team_id=$1 AND user_id=$2`, team.ID, target.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var result outcome
			select {
			case result = <-done:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if change == "membership" {
				want := readStoreTeam(t, db, target.ID, team.ID).Membership
				if result.err != nil || result.member == nil || *result.member != want || want.Role != model.ProjectAdmin {
					t.Fatalf("current membership: %#v %v, want %#v", result.member, result.err, want)
				}
				return
			}
			var fault *model.Fault
			want := "forbidden"
			if change == "credential" {
				want = "unauthenticated"
			}
			if result.member != nil || !errors.As(result.err, &fault) || fault.Code != want {
				t.Fatalf("changed authorization: %#v %v, want %s", result.member, result.err, want)
			}
		})
	}
}

func membershipFixture(t *testing.T) (*Store, model.Principal, model.Principal, model.Project) {
	t.Helper()
	s := isolatedStore(t)
	admin, member, project := testutil.ProjectMembershipFixture(t, s)
	return s, admin, member, project
}

func newStoredInvitation(project model.Project, creator model.Principal, label string) model.ProjectInvitation {
	return testutil.ProjectInvitation(project, creator, label)
}

func TestMembershipStorageFailureRollsBackProjectCreation(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, admin, _, project := membershipFixture(t)
	ctx := t.Context()
	mustQueryExec(t, s, `CREATE FUNCTION reject_member() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'test member rollback'; END $$;
		CREATE TRIGGER reject_member BEFORE INSERT ON project_grants FOR EACH ROW EXECUTE FUNCTION reject_member()`)
	id := uuid.NewString()
	completion, err := s.WriteProjectCreation(ctx, admin.UserID, func(dao store.ProjectCreationDAO) error {
		_, _, err := dao.InsertProject(ctx, id, "Rollback", "https://example.com/rollback", "example.com/rollback", project.Ownership.TeamID)
		return err
	})
	var databaseError *store.Error
	var cause *pgconn.PgError
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &databaseError) || !errors.As(err, &cause) || cause.Code != "P0001" || cause.Message != "test member rollback" {
		t.Fatalf("initial administrator failure lost its rollback outcome or cause: %+v %v", completion, err)
	}
	var row, ownership, grant bool
	err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1),
		EXISTS(SELECT 1 FROM project_ownership WHERE project_id=$1),
		EXISTS(SELECT 1 FROM project_grants WHERE project_id=$1)`, id).Scan(&row, &ownership, &grant)
	if err != nil || row || ownership || grant {
		t.Fatalf("failed creation left project=%t ownership=%t grant=%t: %v", row, ownership, grant, err)
	}
	mustQueryExec(t, s, `DROP TRIGGER reject_member ON project_grants; DROP FUNCTION reject_member()`)
}

func TestMembershipStorageOperationalFailures(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, _, _, project := membershipFixture(t)
	ctx := t.Context()
	s.Close()
	connection, closedPoolError := s.Pool.Acquire(ctx)
	if closedPoolError == nil {
		connection.Release()
		t.Fatal("closed pool allowed acquiring a connection")
	}
	completion, err := s.WriteProject(ctx, project.ID, func(store.ProjectWriteScope) error {
		t.Fatal("closed pool entered project write callback")
		return nil
	})
	var databaseError *store.Error
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &databaseError) || !errors.Is(err, closedPoolError) {
		t.Fatalf("closed project write pool lost its outcome or cause: %+v %v", completion, err)
	}
}
