package project

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
)

type projectEligibilityFailure struct {
	cause   error
	changes *[]store.WebhookEligibilityChange
}

func (d projectEligibilityFailure) RefreshAffected(_ context.Context, change store.WebhookEligibilityChange) error {
	*d.changes = append(*d.changes, change)
	return d.cause
}

type projectEligibilityScope struct {
	store.ProjectWriteScope
	failure projectEligibilityFailure
}

func (s projectEligibilityScope) WebhookEligibilityDAO() store.WebhookEligibilityDAO {
	return s.failure
}

type deletionEligibilityScope struct {
	store.ProjectDeletionScope
	failure projectEligibilityFailure
}

func (s deletionEligibilityScope) WebhookEligibilityDAO() store.WebhookEligibilityDAO {
	return s.failure
}

type projectEligibilityStore struct {
	*postgres.Store
	failure projectEligibilityFailure
}

func (s projectEligibilityStore) WriteProject(ctx context.Context, id string, op func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.Store.WriteProject(ctx, id, func(scope store.ProjectWriteScope) error {
		return op(projectEligibilityScope{ProjectWriteScope: scope, failure: s.failure})
	})
}

func (s projectEligibilityStore) WriteProjectDeletion(ctx context.Context, id string, op func(store.ProjectDeletionScope) error) (store.Completion, error) {
	return s.Store.WriteProjectDeletion(ctx, id, func(scope store.ProjectDeletionScope) error {
		return op(deletionEligibilityScope{ProjectDeletionScope: scope, failure: s.failure})
	})
}

func TestProjectWebhookRefreshFailureRollsBackGrantChanges(t *testing.T) {
	for _, operation := range []string{"role", "remove", "set grant", "remove grant", "invitation"} {
		t.Run(operation, func(t *testing.T) {
			f := newMembershipFixture(t)
			actor, member := f.user(t), f.user(t)
			project := f.project(t, actor, "Webhook access")
			ctx := context.Background()
			invite := f.invite(t, actor, project.ID)
			var before model.ProjectGrant
			if operation != "invitation" {
				if _, err := f.memberships.AcceptInvitation(ctx, member, invite.Secret, member.UserID); err != nil {
					t.Fatal(err)
				}
				before = f.member(t, member, project.ID).Grant
			}
			cause := &model.Fault{Code: "forbidden", Message: "injected eligibility failure"}
			changes := []store.WebhookEligibilityChange{}
			broken := NewMemberships(projectEligibilityStore{Store: f.database, failure: projectEligibilityFailure{cause: cause, changes: &changes}})
			var err error
			switch operation {
			case "role":
				_, err = broken.SetRole(ctx, actor, project.ID, member.UserID, coreproject.SetProjectMemberRole{Version: before.Version, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID})
			case "remove":
				err = broken.Remove(ctx, actor, project.ID, member.UserID, coreproject.RemoveProjectMember{Version: before.Version, ExpectedUserID: actor.UserID})
			case "set grant":
				_, err = broken.SetGrant(ctx, actor, project.ID, member.UserID, coreproject.SetProjectGrant{Version: &before.Version, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID})
			case "remove grant":
				_, err = broken.RemoveGrant(ctx, actor, project.ID, member.UserID, coreproject.RemoveProjectMember{Version: before.Version, ExpectedUserID: actor.UserID})
			case "invitation":
				_, err = broken.AcceptInvitation(ctx, member, invite.Secret, member.UserID)
			}
			if !errors.Is(err, cause) || !reflect.DeepEqual(changes, []store.WebhookEligibilityChange{{ProjectIDs: []string{project.ID}}}) {
				t.Fatalf("refresh was lost: %#v %v", changes, err)
			}
			if operation == "invitation" {
				var grants, consumed int
				if err := f.database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2), (SELECT count(*) FROM project_invitations WHERE id=$3 AND consumed_at IS NOT NULL)`, project.ID, member.UserID, invite.Invitation.ID).Scan(&grants, &consumed); err != nil || grants != 0 || consumed != 0 {
					t.Fatalf("invitation effects escaped rollback: %d %d %v", grants, consumed, err)
				}
			} else if current := f.member(t, member, project.ID).Grant; current != before {
				t.Fatalf("grant change escaped rollback: %#v", current)
			}
			changes = nil
			_, err = broken.SetRole(ctx, actor, project.ID, member.UserID, coreproject.SetProjectMemberRole{Version: before.Version + 1, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID})
			if err == nil || len(changes) != 0 {
				t.Fatalf("refused grant write invoked refresh: %#v %v", changes, err)
			}
		})
	}
}

func TestProjectWebhookRefreshFailureRollsBackLifecycle(t *testing.T) {
	for _, operation := range []string{"transfer", "delete"} {
		t.Run(operation, func(t *testing.T) {
			projects, database, actor, project := createDeletionFixture(t)
			ctx := context.Background()
			cause := errors.New("injected eligibility failure")
			changes := []store.WebhookEligibilityChange{}
			broken := NewProjects(projectEligibilityStore{Store: database, failure: projectEligibilityFailure{cause: cause, changes: &changes}}, projects.engine)
			var err error
			if operation == "delete" {
				_, err = broken.Delete(ctx, actor, project.ID)
			} else {
				other := servicePrincipal(t, database)
				target := newTestTeam(t, teamservice.NewTeams(database), other, "Target")
				preview, e := projects.TransferPreview(ctx, actor, project.ID, target.ID)
				if e != nil {
					t.Fatal(e)
				}
				_, err = broken.Transfer(ctx, actor, project.ID, transferInput(preview, actor))
			}
			if !errors.Is(err, cause) || !reflect.DeepEqual(changes, []store.WebhookEligibilityChange{{ProjectIDs: []string{project.ID}}}) {
				t.Fatalf("refresh was lost: %#v %v", changes, err)
			}
			current, err := projects.Get(ctx, actor, project.ID)
			if err != nil || current.Ownership != project.Ownership {
				t.Fatalf("Project lifecycle escaped rollback: %#v %v", current, err)
			}
		})
	}
}

func seedWebhookAccess(t *testing.T, database *postgres.Store, owner webhookmodel.Owner, projectID string) string {
	t.Helper()
	subscriptionID := uuid.NewString()
	_, err := database.Pool.Exec(context.Background(), `WITH endpoint AS (
		INSERT INTO webhook_endpoints(id,owner_kind,owner_id,name,enabled,config_version,destination_revision,destination_kind,adapter_version,destination_origin,encrypted_destination,active_key_id,created_at,updated_at)
		VALUES($1,$2,$3,'ACL fixture',false,1,1,'http',1,'https://receiver.example',$4,$7,statement_timestamp(),statement_timestamp()) RETURNING id),
		signing AS (INSERT INTO webhook_signing_keys(id,endpoint_id,encrypted_secret,created_at)
		SELECT $7,id,$4,statement_timestamp() FROM endpoint),
		subscription AS (INSERT INTO webhook_subscriptions(id,endpoint_id,owner_kind,owner_id,project_id,authorization_state,authorization_epoch,created_at,updated_at)
		SELECT $5,id,$2,$3,$6,'active',1,statement_timestamp(),statement_timestamp() FROM endpoint RETURNING id)
		INSERT INTO webhook_bindings(id,subscription_id,event_type,created_at)
		SELECT $8,id,'task.paused',statement_timestamp() FROM subscription`, uuid.NewString(), owner.Kind, owner.ID, []byte{0}, subscriptionID, projectID, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return subscriptionID
}

func assertWebhookAccess(t *testing.T, database *postgres.Store, id string, wantState webhookmodel.AuthorizationState, wantEpoch int64) {
	t.Helper()
	var state webhookmodel.AuthorizationState
	var epoch int64
	if err := database.Pool.QueryRow(context.Background(), `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, id).Scan(&state, &epoch); err != nil || state != wantState || epoch != wantEpoch {
		t.Fatalf("subscription eligibility: %s/%d, want %s/%d: %v", state, epoch, wantState, wantEpoch, err)
	}
}

func TestWebhookAuthorizationPreservesContinuousGrantAndRemembersRevocation(t *testing.T) {
	f := newMembershipFixture(t)
	actor, member := f.user(t), f.user(t)
	ctx := context.Background()
	teams := teamservice.NewTeams(f.database)
	team := newTestTeam(t, teams, actor, "Webhook sources")
	invite, err := teams.CreateInvitation(ctx, actor, team.ID, actor.UserID)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := teams.AcceptInvitation(ctx, member, invite.Secret, member.UserID)
	if err != nil {
		t.Fatal(err)
	}
	project, err := f.projects.Create(ctx, actor, coreproject.CreateProject{TeamID: &team.ID, Name: "Webhook sources", RepoURL: "https://example.com/source.git", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	subscription := seedWebhookAccess(t, f.database, webhookmodel.Owner{Kind: webhookmodel.PersonalOwner, ID: member.UserID}, project.ID)
	grant, err := f.memberships.SetGrant(ctx, actor, project.ID, member.UserID, coreproject.SetProjectGrant{Role: model.ProjectMemberRole, ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	assertWebhookAccess(t, f.database, subscription, webhookmodel.AuthorizationActive, 1)
	if _, err = teams.RemoveMember(ctx, actor, team.ID, member.UserID, coreteam.ChangeTeamMember{Version: joined.Membership.Version, ExpectedUserID: actor.UserID}); err != nil {
		t.Fatal(err)
	}
	assertWebhookAccess(t, f.database, subscription, webhookmodel.AuthorizationActive, 1)
	if _, err = f.memberships.RemoveGrant(ctx, actor, project.ID, member.UserID, coreproject.RemoveProjectMember{Version: grant.Grant.Version, ExpectedUserID: actor.UserID}); err != nil {
		t.Fatal(err)
	}
	assertWebhookAccess(t, f.database, subscription, webhookmodel.AuthorizationConfirmationRequired, 2)
	projectInvite := f.invite(t, actor, project.ID)
	if _, err = f.memberships.AcceptInvitation(ctx, member, projectInvite.Secret, member.UserID); err != nil {
		t.Fatal(err)
	}
	assertWebhookAccess(t, f.database, subscription, webhookmodel.AuthorizationConfirmationRequired, 2)
	teamInvite, err := teams.CreateInvitation(ctx, actor, team.ID, actor.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = teams.AcceptInvitation(ctx, member, teamInvite.Secret, member.UserID); err != nil {
		t.Fatal(err)
	}
	assertWebhookAccess(t, f.database, subscription, webhookmodel.AuthorizationConfirmationRequired, 2)
}

func TestWebhookSharedOwnerSurvivesAdministratorRemoval(t *testing.T) {
	f := newMembershipFixture(t)
	actor, otherAdmin := f.user(t), f.user(t)
	ctx := context.Background()
	teams := teamservice.NewTeams(f.database)
	team := newTestTeam(t, teams, actor, "Webhook owners")
	invite, err := teams.CreateInvitation(ctx, actor, team.ID, actor.UserID)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := teams.AcceptInvitation(ctx, otherAdmin, invite.Secret, otherAdmin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = teams.SetMemberRole(ctx, actor, team.ID, otherAdmin.UserID, coreteam.ChangeTeamMember{Version: joined.Membership.Version, Role: model.ProjectAdmin, ExpectedUserID: actor.UserID}); err != nil {
		t.Fatal(err)
	}
	project, err := f.projects.Create(ctx, actor, coreproject.CreateProject{TeamID: &team.ID, Name: "Webhook owners", RepoURL: "https://example.com/owner.git", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	creatorGrant := f.member(t, actor, project.ID).Grant
	if _, err = f.memberships.RemoveGrant(ctx, actor, project.ID, actor.UserID, coreproject.RemoveProjectMember{Version: creatorGrant.Version, ExpectedUserID: actor.UserID}); err != nil {
		t.Fatal(err)
	}
	personal := seedWebhookAccess(t, f.database, webhookmodel.Owner{Kind: webhookmodel.PersonalOwner, ID: actor.UserID}, project.ID)
	shared := seedWebhookAccess(t, f.database, webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: team.ID}, project.ID)
	if _, err = teams.RemoveMember(ctx, otherAdmin, team.ID, actor.UserID, coreteam.ChangeTeamMember{Version: team.Membership.Version, ExpectedUserID: otherAdmin.UserID}); err != nil {
		t.Fatal(err)
	}
	assertWebhookAccess(t, f.database, personal, webhookmodel.AuthorizationConfirmationRequired, 2)
	assertWebhookAccess(t, f.database, shared, webhookmodel.AuthorizationActive, 1)
	invite, err = teams.CreateInvitation(ctx, otherAdmin, team.ID, otherAdmin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = teams.AcceptInvitation(ctx, actor, invite.Secret, actor.UserID); err != nil {
		t.Fatal(err)
	}
	assertWebhookAccess(t, f.database, personal, webhookmodel.AuthorizationConfirmationRequired, 2)
	assertWebhookAccess(t, f.database, shared, webhookmodel.AuthorizationActive, 1)
}

func TestWebhookProjectTransferAndDeletePreserveRevocation(t *testing.T) {
	projects, database, actor, _ := createDeletionFixture(t)
	ctx := context.Background()
	teams := teamservice.NewTeams(database)
	source := newTestTeam(t, teams, actor, "Source")
	target := newTestTeam(t, teams, actor, "Target")
	project, err := projects.Create(ctx, actor, coreproject.CreateProject{TeamID: &source.ID, Name: "Webhook transfer", RepoURL: "https://example.com/transfer.git", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	personal := seedWebhookAccess(t, database, webhookmodel.Owner{Kind: webhookmodel.PersonalOwner, ID: actor.UserID}, project.ID)
	shared := seedWebhookAccess(t, database, webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: source.ID}, project.ID)
	preview, err := projects.TransferPreview(ctx, actor, project.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = projects.Transfer(ctx, actor, project.ID, transferInput(preview, actor)); err != nil {
		t.Fatal(err)
	}
	assertWebhookAccess(t, database, personal, webhookmodel.AuthorizationActive, 1)
	assertWebhookAccess(t, database, shared, webhookmodel.AuthorizationConfirmationRequired, 2)
	preview, err = projects.TransferPreview(ctx, actor, project.ID, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = projects.Transfer(ctx, actor, project.ID, transferInput(preview, actor)); err != nil {
		t.Fatal(err)
	}
	assertWebhookAccess(t, database, personal, webhookmodel.AuthorizationActive, 1)
	assertWebhookAccess(t, database, shared, webhookmodel.AuthorizationConfirmationRequired, 2)
	if _, err = projects.Delete(ctx, actor, project.ID); err != nil {
		t.Fatal(err)
	}
	assertWebhookAccess(t, database, personal, webhookmodel.AuthorizationConfirmationRequired, 2)
	assertWebhookAccess(t, database, shared, webhookmodel.AuthorizationConfirmationRequired, 2)
}
