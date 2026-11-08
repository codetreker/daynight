package project

import (
	"bytes"
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/jackc/pgx/v5/pgxpool"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/google/uuid"
)

func TestWebhookGrantRevocationAndRollback(t *testing.T) {
	f := newMembershipFixture(t)
	owner, target := f.user(t), f.user(t)
	project := f.project(t, owner, "Subscriptions")
	grant := f.join(t, owner, target, project.ID).Grant
	ctx := context.Background()
	id := uuid.NewString()
	_, err := f.database.Pool.Exec(ctx, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now())`, id, uuid.NewString(), project.ID, target.UserID)
	if err != nil {
		t.Fatal(err)
	}
	state := func() (string, int64) {
		t.Helper()
		var value string
		var epoch int64
		if err := f.database.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, id).Scan(&value, &epoch); err != nil {
			t.Fatal(err)
		}
		return value, epoch
	}
	_, err = f.database.Pool.Exec(ctx, `CREATE FUNCTION reject_webhook_refresh() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected refresh failure'; END $$; CREATE TRIGGER reject_webhook_refresh BEFORE UPDATE ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION reject_webhook_refresh()`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.memberships.RemoveGrant(ctx, owner, project.ID, target.UserID, coreproject.RemoveProjectMember{Version: grant.Version, ExpectedUserID: owner.UserID})
	if err == nil {
		t.Fatal("refresh failure did not roll back grant")
	}
	var count int
	if err := f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, target.UserID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("grant rollback: count=%d err=%v", count, err)
	}
	if s, e := state(); s != "active" || e != 1 {
		t.Fatalf("rollback: %s %d", s, e)
	}
	if _, err = f.database.Pool.Exec(ctx, `DROP TRIGGER reject_webhook_refresh ON webhook_subscriptions`); err != nil {
		t.Fatal(err)
	}
	if _, err = f.memberships.RemoveGrant(ctx, owner, project.ID, target.UserID, coreproject.RemoveProjectMember{Version: grant.Version, ExpectedUserID: owner.UserID}); err != nil {
		t.Fatal(err)
	}
	if s, e := state(); s != "confirmation_required" || e != 2 {
		t.Fatalf("revocation: %s %d", s, e)
	}
	f.join(t, owner, target, project.ID)
	if s, e := state(); s != "confirmation_required" || e != 2 {
		t.Fatalf("grant restoration changed proof: %s %d", s, e)
	}
}

type heldEligibility struct {
	store.WebhookEligibilityDAO
	locked  chan struct{}
	release chan struct{}
}

func (d heldEligibility) LockAffected(ctx context.Context, filter store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	rows, err := d.WebhookEligibilityDAO.LockAffected(ctx, filter)
	if err != nil {
		return nil, err
	}
	close(d.locked)
	select {
	case <-d.release:
		return rows, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

type heldProjectScope struct {
	store.ProjectWriteScope
	locked, release chan struct{}
}

func (s heldProjectScope) EligibilityDAO() store.WebhookEligibilityDAO {
	return heldEligibility{s.ProjectWriteScope.EligibilityDAO(), s.locked, s.release}
}

type heldProjectStore struct {
	*postgres.Store
	locked, release chan struct{}
}

func (s heldProjectStore) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.Store.WriteProject(ctx, id, func(scope store.ProjectWriteScope) error { return work(heldProjectScope{scope, s.locked, s.release}) })
}

func TestWebhookContinuousGrantBeforeMemberRemoval(t *testing.T) {
	f := newMembershipFixture(t)
	owner, target := f.user(t), f.user(t)
	teams := teamservice.NewTeams(f.database)
	team := newTestTeam(t, teams, owner, "Continuity")
	p, err := f.projects.Create(context.Background(), owner, coreproject.CreateProject{ExpectedUserID: owner.UserID, Name: "Continuity", RepoURL: "https://example.com/a/b", TeamID: &team.ID})
	if err != nil {
		t.Fatal(err)
	}
	invite, err := teams.CreateInvitation(context.Background(), owner, team.ID, owner.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = teams.AcceptInvitation(context.Background(), target, invite.Secret, target.UserID); err != nil {
		t.Fatal(err)
	}
	member, err := teams.Member(context.Background(), owner, team.ID, target.UserID)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"main","keys":{"main":"` + key + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	webhook := &webhookservice.Service{DB: f.database, Keys: keys, ConfigurationExpansionAvailable: true}
	name, enabled := "Continuity", true
	request := webhookservice.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: target.UserID, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhookservice.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/path"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: p.ID, EventTypes: []string{"task.created"}}}}
	if _, err = webhook.Mutate(ctx, target, wm.Owner{Kind: "personal", ID: target.UserID}, request); err != nil {
		t.Fatal(err)
	}
	var id, binding string
	if err = f.database.Pool.QueryRow(ctx, `SELECT s.id::text,b.id::text FROM webhook_subscriptions s JOIN webhook_bindings b ON b.subscription_id=s.id AND b.deleted_at IS NULL WHERE s.project_id=$1 AND s.owner_kind='personal' AND s.owner_id=$2 AND s.deleted_at IS NULL`, p.ID, target.UserID).Scan(&id, &binding); err != nil {
		t.Fatal(err)
	}
	// A one-connection pool fixes the blocker backend identity for the actual
	// SetGrant transaction. A different pool observes the waiting Team mutation.
	cfg, err := pgxpool.ParseConfig(f.database.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 1
	blockerPool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer blockerPool.Close()
	var blocker int32
	if err = blockerPool.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	locked, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	memberships := NewMemberships(heldProjectStore{&postgres.Store{Pool: blockerPool}, locked, release})
	grantResult := make(chan error, 1)
	go func() {
		_, err := memberships.SetGrant(ctx, owner, p.ID, target.UserID, coreproject.SetProjectGrant{Role: model.ProjectMemberRole, ExpectedUserID: owner.UserID})
		grantResult <- err
	}()
	select {
	case <-locked:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	removeResult := make(chan error, 1)
	go func() {
		_, err := teams.RemoveMember(ctx, owner, team.ID, target.UserID, coreteam.ChangeTeamMember{Version: member.Version, ExpectedUserID: owner.UserID})
		removeResult <- err
	}()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	var waiter int32
	for {
		var waiters []int32
		err = f.database.Pool.QueryRow(ctx, `SELECT coalesce(array_agg(pid),ARRAY[]::integer[]) FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM webhook_subscriptions s%'`, blocker).Scan(&waiters)
		if err != nil {
			t.Fatal(err)
		}
		if len(waiters) == 1 {
			waiter = waiters[0]
			break
		}
		if len(waiters) > 1 {
			t.Fatalf("unexpected waiters %v on backend %d", waiters, blocker)
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("membership removal did not block on grant transaction")
		}
	}
	close(release)
	select {
	case err = <-grantResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case err = <-removeResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var state, actualBinding string
	var epoch int64
	var memberPresent, grantPresent bool
	if err = f.database.Pool.QueryRow(ctx, `SELECT s.authorization_state,s.authorization_epoch,b.id::text,EXISTS(SELECT 1 FROM team_members WHERE team_id=$2 AND user_id=$3),EXISTS(SELECT 1 FROM project_grants WHERE project_id=$4 AND user_id=$3) FROM webhook_subscriptions s JOIN webhook_bindings b ON b.subscription_id=s.id AND b.event_type='task.created' AND b.deleted_at IS NULL WHERE s.id=$1 AND s.deleted_at IS NULL`, id, team.ID, target.UserID, p.ID).Scan(&state, &epoch, &actualBinding, &memberPresent, &grantPresent); err != nil {
		t.Fatal(err)
	}
	if state != "active" || epoch != 1 || actualBinding != binding || memberPresent || !grantPresent {
		t.Fatalf("continuous access lost: state=%s epoch=%d binding=%s original=%s member=%t grant=%t", state, epoch, actualBinding, binding, memberPresent, grantPresent)
	}
	t.Logf("T02-A03 blocker=%d waiter=%d state=%s epoch=%d binding=%s member=%t grant=%t", blocker, waiter, state, epoch, binding, memberPresent, grantPresent)
}

func TestWebhookTransferAndTeamDeletionRetainInvalidation(t *testing.T) {
	projects, db, _, actor := projectService(t)
	ctx := context.Background()
	teams := teamservice.NewTeams(db)
	source := newTestTeam(t, teams, actor, "Source")
	target := newTestTeam(t, teams, actor, "Target")
	p, err := projects.Create(ctx, actor, coreproject.CreateProject{ExpectedUserID: actor.UserID, Name: "Project", RepoURL: "https://example.com/a/b", TeamID: &source.ID})
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'team',$4,'active',1,now(),now())`, id, uuid.NewString(), p.ID, source.ID); err != nil {
		t.Fatal(err)
	}
	preview, err := projects.TransferPreview(ctx, actor, p.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `CREATE FUNCTION fail_refresh() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected refresh failure'; END $$; CREATE TRIGGER fail_refresh BEFORE UPDATE ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION fail_refresh()`); err != nil {
		t.Fatal(err)
	}
	if _, err = projects.Transfer(ctx, actor, p.ID, transferInput(preview, actor)); err == nil {
		t.Fatal("expected transfer rollback")
	}
	var teamID, state string
	var epoch int64
	if err = db.Pool.QueryRow(ctx, `SELECT o.team_id::text,s.authorization_state,s.authorization_epoch FROM project_ownership o JOIN webhook_subscriptions s ON s.project_id=o.project_id WHERE s.id=$1`, id).Scan(&teamID, &state, &epoch); err != nil {
		t.Fatal(err)
	}
	if teamID != source.ID || state != "active" || epoch != 1 {
		t.Fatalf("transfer rollback: %s %s %d", teamID, state, epoch)
	}
	if _, err = db.Pool.Exec(ctx, `DROP TRIGGER fail_refresh ON webhook_subscriptions`); err != nil {
		t.Fatal(err)
	}
	if _, err = projects.Transfer(ctx, actor, p.ID, transferInput(preview, actor)); err != nil {
		t.Fatal(err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, id).Scan(&state, &epoch); err != nil || state != "confirmation_required" || epoch != 2 {
		t.Fatalf("transfer: %s %d %v", state, epoch, err)
	}
	// Exercise Team deletion against a retained historical subscription whose
	// project is no longer owned by that Team, including a failed refresh.
	if _, err = db.Pool.Exec(ctx, `UPDATE webhook_subscriptions SET authorization_state='active' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `CREATE TRIGGER fail_refresh BEFORE UPDATE ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION fail_refresh()`); err != nil {
		t.Fatal(err)
	}
	input := coreteam.ChangeTeam{Name: *source.Name, Version: source.Version, ExpectedUserID: actor.UserID}
	if err = teams.Delete(ctx, actor, source.ID, input); err == nil {
		t.Fatal("expected Team deletion rollback")
	}
	var exists bool
	if err = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM teams WHERE id=$1)`, source.ID).Scan(&exists); err != nil || !exists {
		t.Fatalf("team deletion rollback: %t %v", exists, err)
	}
	if _, err = db.Pool.Exec(ctx, `DROP TRIGGER fail_refresh ON webhook_subscriptions`); err != nil {
		t.Fatal(err)
	}
	if err = teams.Delete(ctx, actor, source.ID, input); err != nil {
		t.Fatal(err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, id).Scan(&state, &epoch); err != nil || state != "confirmation_required" || epoch != 3 {
		t.Fatalf("team deletion: %s %d %v", state, epoch, err)
	}
}

func TestWebhookProjectDeletionRollsBackOnScanAndWriteFailures(t *testing.T) {
	projects, db, actor, p := createDeletionFixture(t)
	ctx := context.Background()
	id := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now())`, id, uuid.NewString(), p.ID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `ALTER TABLE webhook_subscriptions RENAME TO inaccessible_webhook_subscriptions`); err != nil {
		t.Fatal(err)
	}
	_, err := projects.Delete(ctx, actor, p.ID)
	if err == nil {
		t.Fatal("expected scan failure")
	}
	if _, err = db.Pool.Exec(ctx, `ALTER TABLE inaccessible_webhook_subscriptions RENAME TO webhook_subscriptions`); err != nil {
		t.Fatal(err)
	}
	var live bool
	if err = db.Pool.QueryRow(ctx, `SELECT deleted_at IS NULL FROM projects WHERE id=$1`, p.ID).Scan(&live); err != nil || !live {
		t.Fatalf("scan failure rollback: %t %v", live, err)
	}
	if _, err = db.Pool.Exec(ctx, `CREATE FUNCTION fail_refresh() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected refresh failure'; END $$; CREATE TRIGGER fail_refresh BEFORE UPDATE ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION fail_refresh()`); err != nil {
		t.Fatal(err)
	}
	if _, err = projects.Delete(ctx, actor, p.ID); err == nil {
		t.Fatal("expected write failure")
	}
	if err = db.Pool.QueryRow(ctx, `SELECT deleted_at IS NULL FROM projects WHERE id=$1`, p.ID).Scan(&live); err != nil || !live {
		t.Fatalf("write failure rollback: %t %v", live, err)
	}
	if _, err = db.Pool.Exec(ctx, `DROP TRIGGER fail_refresh ON webhook_subscriptions`); err != nil {
		t.Fatal(err)
	}
	if _, err = projects.Delete(ctx, actor, p.ID); err != nil {
		t.Fatal(err)
	}
	var state string
	var epoch int64
	if err = db.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, id).Scan(&state, &epoch); err != nil || state != "confirmation_required" || epoch != 2 {
		t.Fatalf("deletion: %s %d %v", state, epoch, err)
	}
}
