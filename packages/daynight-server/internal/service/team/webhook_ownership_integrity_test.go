package team_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
)

func TestTeamRemovalRollsBackForOrphanedSubscribedProject(t *testing.T) {
	_, db, _, admin := projectService(t)
	ctx := context.Background()
	teams := teamservice.NewTeams(db)
	member := servicePrincipal(t, db)
	team := newTestTeam(t, teams, admin, "eligibility")
	invite, err := teams.CreateInvitation(ctx, admin, team.ID, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := teams.AcceptInvitation(ctx, member, invite.Secret, member.UserID)
	if err != nil {
		t.Fatal(err)
	}
	project, endpoint, sub := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Project',$2)`, []any{project, "https://example.test/" + project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team.ID}},
		{`INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,configuration_schema_version,destination_origin,destination_envelope_version,destination_master_key_id,destination_nonce,destination_ciphertext,active_key_id,created_at,updated_at) VALUES($1,'personal',$2,'x',true,1,1,'http',1,1,'https://example.test',1,'key',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),$3,now(),now())`, []any{endpoint, member.UserID, uuid.NewString()}},
		{`INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now())`, []any{sub, endpoint, project, member.UserID}},
		{`INSERT INTO webhook_bindings(id,subscription_id,event_type,created_at) VALUES($1,$2,'task.created',now())`, []any{uuid.NewString(), sub}},
		{`DELETE FROM project_ownership WHERE project_id=$1`, []any{project}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	_, err = teams.RemoveMember(ctx, admin, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: joined.Membership.Version, ExpectedUserID: admin.UserID})
	cause := err
	for errors.Unwrap(cause) != nil {
		cause = errors.Unwrap(cause)
	}
	if cause == nil || !strings.Contains(cause.Error(), "ownership") {
		t.Fatalf("expected integrity failure, got %v", err)
	}
	var version, epoch int64
	var role, state string
	if err = db.Pool.QueryRow(ctx, `SELECT role,version FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, member.UserID).Scan(&role, &version); err != nil {
		t.Fatal(err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, sub).Scan(&state, &epoch); err != nil {
		t.Fatal(err)
	}
	if role != string(model.ProjectMemberRole) || version != joined.Membership.Version || state != "active" || epoch != 1 {
		t.Fatalf("rollback: role=%s version=%d state=%s epoch=%d", role, version, state, epoch)
	}
}
