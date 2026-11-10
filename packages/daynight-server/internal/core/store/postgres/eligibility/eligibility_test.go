package eligibility_test

import (
	"context"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/eligibility"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func TestEligibilityReadsSourcesAndRefreshesLockedSubscriptions(t *testing.T) {
	ctx := context.Background()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	user, team, otherTeam, project, personal, shared := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'Owner'),($2,'Other')`, []any{team, otherTeam}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','https://example.test/a')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
		{`INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now()),($5,$6,$3,'team',$7,'active',1,now(),now())`, []any{personal, uuid.NewString(), project, user, shared, uuid.NewString(), team}},
	}
	for _, q := range statements {
		if _, err = tx.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	dao := eligibility.New(tx)
	personalOwner := webhook.Owner{Kind: "personal", ID: user}
	sharedOwner := webhook.Owner{Kind: "team", ID: team}
	if _, err = dao.ReadEligibility(ctx, webhook.Owner{Kind: "invalid", ID: user}, project, user); err == nil {
		t.Fatal("invalid owner was accepted")
	}
	for _, filter := range []store.WebhookEligibilityFilter{{}, {ProjectID: project, TeamID: team}, {TeamID: team}, {TeamID: team, TeamOwner: true, UserID: user}} {
		if _, err = dao.LockAffected(ctx, filter); err == nil {
			t.Fatalf("invalid filter accepted: %#v", filter)
		}
	}
	read := func(owner webhook.Owner, projectID, actor, want string, hasName bool) {
		t.Helper()
		got, err := dao.ReadEligibility(ctx, owner, projectID, actor)
		if err != nil || got.Status != want || (got.ProjectName != nil) != hasName {
			t.Fatalf("eligibility %#v, want %s name=%t: %v", got, want, hasName, err)
		}
		if hasName && *got.ProjectName != "Project" {
			t.Fatalf("name: %q", *got.ProjectName)
		}
	}
	read(personalOwner, project, user, "eligible", true)
	read(sharedOwner, project, user, "eligible", true)
	read(personalOwner, project, uuid.NewString(), "eligible", false)
	rows, err := dao.LockAffected(ctx, store.WebhookEligibilityFilter{ProjectID: project})
	if err != nil || len(rows) != 2 || rows[0].ID >= rows[1].ID {
		t.Fatalf("project lock: %#v %v", rows, err)
	}
	rows, err = dao.LockAffected(ctx, store.WebhookEligibilityFilter{TeamID: team, UserID: user})
	if err != nil || len(rows) != 1 || rows[0].ID != personal {
		t.Fatalf("team member lock: %#v %v", rows, err)
	}
	rows, err = dao.LockAffected(ctx, store.WebhookEligibilityFilter{ProjectID: project, UserID: user})
	if err != nil || len(rows) != 1 || rows[0].ID != personal {
		t.Fatalf("project user lock: %#v %v", rows, err)
	}
	rows, err = dao.LockAffected(ctx, store.WebhookEligibilityFilter{TeamID: team, TeamOwner: true})
	if err != nil || len(rows) != 1 || rows[0].ID != shared {
		t.Fatalf("team owner lock: %#v %v", rows, err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project, user); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team, user); err != nil {
		t.Fatal(err)
	}
	read(personalOwner, project, user, "eligible", true)
	if _, err = tx.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project, user); err != nil {
		t.Fatal(err)
	}
	read(personalOwner, project, user, "access_revoked", false)
	if err = dao.Revoke(ctx, personal, 1); err != nil {
		t.Fatal(err)
	}
	var state string
	var epoch int64
	if err = tx.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, personal).Scan(&state, &epoch); err != nil || state != "confirmation_required" || epoch != 2 {
		t.Fatalf("revocation: %s %d %v", state, epoch, err)
	}
	if err = dao.Revoke(ctx, personal, 1); err == nil {
		t.Fatal("repeated revoke succeeded")
	}
	if _, err = tx.Exec(ctx, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project, otherTeam); err != nil {
		t.Fatal(err)
	}
	read(sharedOwner, project, user, "owner_scope_changed", false)
	if _, err = tx.Exec(ctx, `UPDATE projects SET deleted_at=now() WHERE id=$1`, project); err != nil {
		t.Fatal(err)
	}
	read(personalOwner, project, user, "resource_unavailable", false)
	read(personalOwner, uuid.NewString(), user, "resource_unavailable", false)
	broken := uuid.NewString()
	if _, err = tx.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Broken','https://example.test/b')`, broken); err != nil {
		t.Fatal(err)
	}
	orphan := uuid.NewString()
	if _, err = tx.Exec(ctx, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now())`, orphan, uuid.NewString(), broken, user); err != nil {
		t.Fatal(err)
	}
	rows, err = dao.LockAffected(ctx, store.WebhookEligibilityFilter{TeamID: team, UserID: user})
	if err != nil || len(rows) != 1 || rows[0].ID != orphan || rows[0].ProjectID != broken || rows[0].Owner != personalOwner || rows[0].State != "active" || rows[0].Epoch != 1 {
		t.Fatalf("Team member filter omitted orphan subscription: %#v %v", rows, err)
	}
	if _, err = dao.ReadEligibility(ctx, rows[0].Owner, rows[0].ProjectID, user); err == nil || !strings.Contains(err.Error(), "ownership") {
		t.Fatalf("missing ownership was treated as revoked: %v", err)
	}
	if _, err = tx.Exec(ctx, `ALTER TABLE webhook_subscriptions ALTER COLUMN authorization_epoch DROP NOT NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE webhook_subscriptions SET authorization_epoch=NULL WHERE id=$1`, personal); err != nil {
		t.Fatal(err)
	}
	if _, err = dao.LockAffected(ctx, store.WebhookEligibilityFilter{ProjectID: project}); err == nil {
		t.Fatal("invalid epoch scan was accepted")
	}
	if _, err = tx.Exec(ctx, `ALTER TABLE webhook_subscriptions DROP CONSTRAINT webhook_subscriptions_authorization_epoch_check`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE webhook_subscriptions SET authorization_epoch=0 WHERE id=$1`, personal); err != nil {
		t.Fatal(err)
	}
	if _, err = dao.LockAffected(ctx, store.WebhookEligibilityFilter{ProjectID: project}); err == nil {
		t.Fatal("invalid epoch was accepted")
	}
	if _, err = dao.LockAffected(ctx, store.WebhookEligibilityFilter{ProjectID: "not-a-uuid"}); err == nil {
		t.Fatal("invalid database query was accepted")
	}
}
