package project

import (
	"context"
	"errors"
	"reflect"
	"testing"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func grantParticipant(t *testing.T, f *membershipFixture, project model.Project, p model.Principal, role model.ProjectRole) {
	t.Helper()
	_, err := f.database.Pool.Exec(context.Background(), `INSERT INTO team_members(team_id,user_id,role) VALUES ($1,$2,$3)`, project.Ownership.TeamID, p.UserID, role)
	if err != nil {
		t.Fatal(err)
	}
}

func TestProjectGrantsExistenceVersionsAndAccess(t *testing.T) {
	f := newMembershipFixture(t)
	owner, inherited, outsider := f.user(t), f.user(t), f.user(t)
	project := f.project(t, owner, "Grant")
	grantParticipant(t, f, project, inherited, model.ProjectMemberRole)
	ctx := context.Background()
	put := func(actor, target model.Principal, version *int64, role model.ProjectRole) (coreproject.SetGrantResult, error) {
		return f.memberships.SetGrant(ctx, actor, project.ID, target.UserID, coreproject.SetProjectGrant{Version: version, Role: role, ExpectedUserID: actor.UserID})
	}
	_, err := put(owner, outsider, nil, model.ProjectAdmin)
	requireFault(t, err, "not_found")
	created, err := put(owner, inherited, nil, model.ProjectAdmin)
	if err != nil || created.Grant.Role != model.ProjectAdmin || created.ActorAccess == nil || created.ActorAccess.Role != model.ProjectAdmin {
		t.Fatalf("created: %#v %v", created, err)
	}
	_, err = put(owner, inherited, nil, model.ProjectAdmin)
	requireFault(t, err, "version_conflict")
	noOp, err := put(owner, inherited, &created.Grant.Version, model.ProjectAdmin)
	if err != nil || !reflect.DeepEqual(noOp.Grant, created.Grant) {
		t.Fatalf("no-op: %#v %v", noOp, err)
	}
	updated, err := put(owner, inherited, &created.Grant.Version, model.ProjectMemberRole)
	if err != nil || updated.Grant.Version <= created.Grant.Version {
		t.Fatalf("updated: %#v %v", updated, err)
	}
	_, err = put(owner, inherited, &created.Grant.Version, model.ProjectMemberRole)
	requireFault(t, err, "version_conflict")
	removed, err := f.memberships.RemoveGrant(ctx, owner, project.ID, inherited.UserID, coreproject.RemoveProjectMember{Version: updated.Grant.Version, ExpectedUserID: owner.UserID})
	if err != nil || removed.ProjectID != project.ID || removed.UserID != inherited.UserID || removed.ActorAccess == nil {
		t.Fatalf("removed: %#v %v", removed, err)
	}
	_, err = put(owner, inherited, &updated.Grant.Version, model.ProjectAdmin)
	requireFault(t, err, "version_conflict")
	recreated, err := put(owner, inherited, nil, model.ProjectAdmin)
	if err != nil || recreated.Grant.Version <= updated.Grant.Version {
		t.Fatalf("recreated: %#v %v", recreated, err)
	}
	_, err = f.memberships.RemoveGrant(ctx, owner, project.ID, inherited.UserID, coreproject.RemoveProjectMember{Version: updated.Grant.Version, ExpectedUserID: owner.UserID})
	requireFault(t, err, "version_conflict")
	if actual := f.member(t, inherited, project.ID).Grant; !reflect.DeepEqual(actual, recreated.Grant) {
		t.Fatalf("ABA changed grant: %#v", actual)
	}

	ownerGrant := f.member(t, owner, project.ID).Grant
	demoted, err := put(owner, owner, &ownerGrant.Version, model.ProjectMemberRole)
	if err != nil || demoted.ActorAccess == nil || demoted.ActorAccess.Role != model.ProjectAdmin || demoted.ActorAccess.TeamRole == nil || *demoted.ActorAccess.TeamRole != model.ProjectAdmin {
		t.Fatalf("owner inherited admin: %#v %v", demoted, err)
	}
	result, err := f.memberships.RemoveGrant(ctx, owner, project.ID, owner.UserID, coreproject.RemoveProjectMember{Version: demoted.Grant.Version, ExpectedUserID: owner.UserID})
	if err != nil || result.ActorAccess == nil || result.ActorAccess.Role != model.ProjectAdmin || result.ActorAccess.DirectGrant != nil {
		t.Fatalf("owner remove: %#v %v", result, err)
	}
	_, err = f.memberships.RemoveGrant(ctx, owner, project.ID, inherited.UserID, coreproject.RemoveProjectMember{Version: recreated.Grant.Version, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1`, project.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("zero grants: %d %v", count, err)
	}
}

func TestGrantActorLosesAccessAndIdentityGuard(t *testing.T) {
	f := newMembershipFixture(t)
	owner, admin := f.user(t), f.user(t)
	project := f.project(t, owner, "Loss")
	joined := f.join(t, owner, admin, project.ID).Grant
	promoted, err := f.memberships.SetGrant(context.Background(), owner, project.ID, admin.UserID, coreproject.SetProjectGrant{Version: &joined.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	before := f.member(t, admin, project.ID).Grant
	_, err = f.memberships.RemoveGrant(context.Background(), admin, project.ID, admin.UserID, coreproject.RemoveProjectMember{Version: promoted.Grant.Version, ExpectedUserID: owner.UserID})
	requireFault(t, err, "identity_mismatch")
	_, err = f.memberships.SetGrant(context.Background(), admin, project.ID, admin.UserID, coreproject.SetProjectGrant{Version: &before.Version, Role: model.ProjectMemberRole, ExpectedUserID: owner.UserID})
	requireFault(t, err, "identity_mismatch")
	if actual := f.member(t, admin, project.ID).Grant; !reflect.DeepEqual(actual, before) {
		t.Fatalf("identity mismatch wrote grant: %#v", actual)
	}
	removed, err := f.memberships.RemoveGrant(context.Background(), admin, project.ID, admin.UserID, coreproject.RemoveProjectMember{Version: before.Version, ExpectedUserID: admin.UserID})
	if err != nil || removed.ActorAccess != nil {
		t.Fatalf("success with lost access: %#v %v", removed, err)
	}
	_, err = f.memberships.SetGrant(context.Background(), admin, project.ID, admin.UserID, coreproject.SetProjectGrant{Role: model.ProjectAdmin, ExpectedUserID: admin.UserID})
	requireFault(t, err, "not_found")
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = f.memberships.SetGrant(cancelled, owner, project.ID, owner.UserID, coreproject.SetProjectGrant{Role: model.ProjectAdmin, ExpectedUserID: owner.UserID})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	_, err = f.memberships.SetGrant(context.Background(), owner, project.ID, uuid.NewString(), coreproject.SetProjectGrant{Version: new(int64), Role: model.ProjectAdmin, ExpectedUserID: owner.UserID})
	requireFault(t, err, "invalid_input")
}

func TestGrantCompetingCreateAndReplace(t *testing.T) {
	f := newMembershipFixture(t)
	owner, target := f.user(t), f.user(t)
	project := f.project(t, owner, "Race")
	grantParticipant(t, f, project, target, model.ProjectMemberRole)
	var version *int64
	for _, create := range []bool{true, false} {
		role := model.ProjectAdmin
		if !create {
			role = model.ProjectMemberRole
		}
		operation := func(ctx context.Context) (model.Task, error) {
			_, err := f.memberships.SetGrant(ctx, owner, project.ID, target.UserID, coreproject.SetProjectGrant{Version: version, Role: role, ExpectedUserID: owner.UserID})
			return model.Task{}, err
		}
		results := competeTaskWrites(t, f.database, project.ID, operation, operation)
		success, conflict := 0, 0
		for _, result := range results {
			if result.err == nil {
				success++
			} else {
				var fault *model.Fault
				if errors.As(result.err, &fault) && fault.Code == "version_conflict" {
					conflict++
				} else {
					t.Fatal(result.err)
				}
			}
		}
		if success != 1 || conflict != 1 {
			t.Fatalf("create=%v success=%d conflicts=%d", create, success, conflict)
		}
		grant := f.member(t, target, project.ID).Grant
		version = &grant.Version
	}
}

func TestGrantIdentityCheckPrecedesDomainStore(t *testing.T) {
	principal := model.Principal{Kind: model.SessionCredential, CredentialID: uuid.NewString(), UserID: uuid.NewString()}
	memberships := NewMemberships(nil)
	other := uuid.NewString()
	_, err := memberships.SetGrant(context.Background(), principal, uuid.NewString(), uuid.NewString(), coreproject.SetProjectGrant{Role: model.ProjectAdmin, ExpectedUserID: other})
	requireFault(t, err, "identity_mismatch")
	_, err = memberships.RemoveGrant(context.Background(), principal, uuid.NewString(), uuid.NewString(), coreproject.RemoveProjectMember{Version: 1, ExpectedUserID: other})
	requireFault(t, err, "identity_mismatch")
}

func TestGrantSelfDemotionReturnsRemainingMemberAccess(t *testing.T) {
	f := newMembershipFixture(t)
	owner, external := f.user(t), f.user(t)
	project := f.project(t, owner, "Demotion")
	joined := f.join(t, owner, external, project.ID).Grant
	promoted, err := f.memberships.SetGrant(context.Background(), owner, project.ID, external.UserID, coreproject.SetProjectGrant{Version: &joined.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	result, err := f.memberships.SetGrant(context.Background(), external, project.ID, external.UserID, coreproject.SetProjectGrant{Version: &promoted.Grant.Version, Role: model.ProjectMemberRole, ExpectedUserID: external.UserID})
	if err != nil || result.ActorAccess == nil || result.ActorAccess.Role != model.ProjectMemberRole || result.ActorAccess.DirectGrant == nil || result.ActorAccess.DirectGrant.Version != result.Grant.Version {
		t.Fatalf("remaining access: %#v %v", result, err)
	}
	_, err = f.memberships.SetGrant(context.Background(), external, project.ID, owner.UserID, coreproject.SetProjectGrant{Role: model.ProjectMemberRole, ExpectedUserID: external.UserID})
	requireFault(t, err, "forbidden")
}

func TestRemoveGrantRejectsInvalidInputBeforeDomainStore(t *testing.T) {
	memberships := NewMemberships(nil)
	principal := model.Principal{Kind: model.SessionCredential, CredentialID: uuid.NewString(), UserID: uuid.NewString()}
	_, err := memberships.RemoveGrant(context.Background(), model.Principal{}, uuid.NewString(), uuid.NewString(), coreproject.RemoveProjectMember{Version: 1, ExpectedUserID: principal.UserID})
	requireFault(t, err, "unauthenticated")
	_, err = memberships.RemoveGrant(context.Background(), principal, uuid.NewString(), uuid.NewString(), coreproject.RemoveProjectMember{Version: 0, ExpectedUserID: principal.UserID})
	requireFault(t, err, "invalid_input")
	_, err = memberships.RemoveGrant(context.Background(), principal, "invalid project", uuid.NewString(), coreproject.RemoveProjectMember{Version: 1, ExpectedUserID: principal.UserID})
	requireFault(t, err, "invalid_input")
}

func TestRemoveGrantDatabaseFailureRollsBack(t *testing.T) {
	f := newMembershipFixture(t)
	owner := f.user(t)
	project := f.project(t, owner, "Delete failure")
	before := f.member(t, owner, project.ID).Grant
	ctx := context.Background()
	_, err := f.database.Pool.Exec(ctx, `CREATE FUNCTION reject_grant_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected delete failure'; END $$; CREATE TRIGGER reject_grant_delete BEFORE DELETE ON project_grants FOR EACH ROW EXECUTE FUNCTION reject_grant_delete()`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.memberships.RemoveGrant(ctx, owner, project.ID, owner.UserID, coreproject.RemoveProjectMember{Version: before.Version, ExpectedUserID: owner.UserID})
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "P0001" {
		t.Fatalf("delete failure lost cause: %v", err)
	}
	if actual := f.member(t, owner, project.ID).Grant; !reflect.DeepEqual(actual, before) {
		t.Fatalf("failed delete changed grant: %#v", actual)
	}
}
