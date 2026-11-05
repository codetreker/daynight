package project

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type membershipFixture struct {
	database    *store.Store
	projects    *Projects
	memberships *Memberships
	now         time.Time
}

func newMembershipFixture(t *testing.T) *membershipFixture {
	t.Helper()
	projects, database, _, _ := projectService(t)
	f := &membershipFixture{database: database, projects: projects, memberships: NewMemberships(database), now: time.Now().UTC().Truncate(time.Microsecond)}
	f.memberships.now = func() time.Time { return f.now }
	return f
}

func (f *membershipFixture) user(t *testing.T) model.Principal {
	t.Helper()
	secret := secretutil.Random("dnst_")
	credential := model.Session{ID: uuid.NewString(), TokenHash: secretutil.Hash(secret), CreatedAt: f.now, ExpiresAt: f.now.Add(identitycore.SessionLifetime)}
	principal := fixtureIdentitySession(t, f.database, model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}, credential)

	return principal
}

func (f *membershipFixture) project(t *testing.T, p model.Principal, name string) model.Project {
	t.Helper()
	project, err := f.projects.Create(context.Background(), p, coreproject.CreateProject{ExpectedUserID: p.UserID, Name: name, RepoURL: "https://example.com/team/repo.git"})
	if err != nil {
		t.Fatal(err)
	}
	return project
}

func (f *membershipFixture) invite(t *testing.T, p model.Principal, projectID string) coreproject.MintedInvitation {
	t.Helper()
	invitation, err := f.memberships.CreateInvitation(context.Background(), p, projectID, p.UserID)
	if err != nil {
		t.Fatal(err)
	}
	return invitation
}

func (f *membershipFixture) join(t *testing.T, admin, p model.Principal, projectID string) model.ProjectMember {
	t.Helper()
	invite := f.invite(t, admin, projectID)
	_, err := f.memberships.AcceptInvitation(context.Background(), p, invite.Secret, p.UserID)
	if err != nil {
		t.Fatal(err)
	}
	return f.member(t, p, projectID)
}

func (f *membershipFixture) member(t *testing.T, p model.Principal, projectID string) model.ProjectMember {
	t.Helper()
	var member model.ProjectMember
	if err := f.database.ReadSnapshot(context.Background(), func(snapshot store.SnapshotScope) error {
		var err error
		member, err = snapshot.ProjectDAO().DirectProjectMember(context.Background(), p.UserID, projectID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return member
}

func TestPrivateProjectsAtomicCreationAndMemberFilteredPagination(t *testing.T) {
	f := newMembershipFixture(t)
	alice, bob := f.user(t), f.user(t)
	ctx := context.Background()
	a := f.project(t, alice, "A")
	f.project(t, bob, "Hidden before B")
	b := f.project(t, alice, "B")
	f.project(t, bob, "Hidden after B")
	c := f.project(t, alice, "C")
	if m := f.member(t, alice, a.ID); m.Grant.Role != model.ProjectAdmin {
		t.Fatalf("creator: %#v", m)
	}
	var names []string
	request := model.PageRequest{Limit: 1}
	for i := 0; i < 3; i++ {
		page, err := f.projects.List(ctx, alice, request)
		if err != nil || len(page.Items) != 1 {
			t.Fatalf("page: %#v, %v", page, err)
		}
		names = append(names, page.Items[0].Name)
		request.Cursor = page.NextCursor
		if i < 2 && page.NextCursor == nil {
			t.Fatal("filtered page lost continuation")
		}
		if i == 2 && page.NextCursor != nil {
			t.Fatal("hidden projects leaked continuation")
		}
	}
	if !reflect.DeepEqual(names, []string{a.Name, b.Name, c.Name}) {
		t.Fatal(names)
	}
	stranger := f.user(t)
	empty, err := f.projects.List(ctx, stranger, model.PageRequest{Limit: 1})
	if err != nil || empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("empty access: %#v %v", empty, err)
	}
	if _, err := f.database.Pool.Exec(ctx, `CREATE FUNCTION reject_initial_admin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected admin insertion failure'; END $$; CREATE TRIGGER reject_initial_admin BEFORE INSERT ON project_grants FOR EACH ROW EXECUTE FUNCTION reject_initial_admin()`); err != nil {
		t.Fatal(err)
	}
	_, err = f.projects.Create(ctx, alice, coreproject.CreateProject{ExpectedUserID: alice.UserID, Name: "Must roll back", RepoURL: "host:repo"})
	requireIdentityOperationalError(t, err)
	var residual int
	if err := f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM projects WHERE name='Must roll back'`).Scan(&residual); err != nil || residual != 0 {
		t.Fatalf("partial private project: %d %v", residual, err)
	}
}

func TestMembershipRoleAuthorizationAndObservedVersions(t *testing.T) {
	f := newMembershipFixture(t)
	owner, member, outsider := f.user(t), f.user(t), f.user(t)
	p := f.project(t, owner, "Private")
	ctx := context.Background()
	joined := f.join(t, owner, member, p.ID)
	for _, principal := range []model.Principal{owner, member} {
		members, err := f.memberships.List(ctx, principal, p.ID)
		if err != nil || len(members) != 2 {
			t.Fatalf("member list: %#v %v", members, err)
		}
	}
	_, err := f.memberships.List(ctx, outsider, p.ID)
	requireFault(t, err, "not_found")
	_, err = f.memberships.SetRole(ctx, member, p.ID, owner.UserID, coreproject.SetProjectMemberRole{Version: f.member(t, owner, p.ID).Grant.Version, Role: model.ProjectMemberRole, ExpectedUserID: member.UserID})
	requireFault(t, err, "forbidden")
	_, err = f.memberships.SetRole(ctx, outsider, p.ID, member.UserID, coreproject.SetProjectMemberRole{Version: joined.Grant.Version, Role: model.ProjectAdmin, ExpectedUserID: outsider.UserID})
	requireFault(t, err, "not_found")
	unchanged, err := f.memberships.SetRole(ctx, owner, p.ID, member.UserID, coreproject.SetProjectMemberRole{Version: joined.Grant.Version, Role: model.ProjectMemberRole, ExpectedUserID: owner.UserID})
	if err != nil || !reflect.DeepEqual(unchanged, joined.Grant) {
		t.Fatalf("same role: %#v %v", unchanged, err)
	}
	promoted, err := f.memberships.SetRole(ctx, owner, p.ID, member.UserID, coreproject.SetProjectMemberRole{Version: joined.Grant.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID})
	if err != nil || promoted.Version <= joined.Grant.Version {
		t.Fatalf("promotion: %#v %v", promoted, err)
	}
	_, err = f.memberships.SetRole(ctx, owner, p.ID, member.UserID, coreproject.SetProjectMemberRole{Version: joined.Grant.Version, Role: model.ProjectMemberRole, ExpectedUserID: owner.UserID})
	requireFault(t, err, "version_conflict")
	requireFault(t, f.memberships.Remove(ctx, owner, p.ID, member.UserID, coreproject.RemoveProjectMember{Version: joined.Grant.Version, ExpectedUserID: owner.UserID}), "version_conflict")
	if err := f.memberships.Remove(ctx, owner, p.ID, member.UserID, coreproject.RemoveProjectMember{Version: promoted.Version, ExpectedUserID: owner.UserID}); err != nil {
		t.Fatal(err)
	}
	rejoined := f.join(t, owner, member, p.ID)
	if rejoined.Grant.Version <= promoted.Version {
		t.Fatal("rejoin reused an observed version")
	}
	_, err = f.memberships.SetRole(ctx, owner, p.ID, member.UserID, coreproject.SetProjectMemberRole{Version: joined.Grant.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID})
	requireFault(t, err, "version_conflict")
	requireFault(t, f.memberships.Remove(ctx, owner, p.ID, member.UserID, coreproject.RemoveProjectMember{Version: promoted.Version, ExpectedUserID: owner.UserID}), "version_conflict")
	if f.member(t, member, p.ID).Grant.Role != model.ProjectMemberRole {
		t.Fatal("stale observation changed rejoined member")
	}
	if err := f.memberships.Remove(ctx, owner, p.ID, member.UserID, coreproject.RemoveProjectMember{Version: rejoined.Grant.Version, ExpectedUserID: owner.UserID}); err != nil {
		t.Fatal(err)
	}
	_, err = f.memberships.List(ctx, member, p.ID)
	requireFault(t, err, "not_found")
	_, err = f.memberships.CreateInvitation(ctx, member, p.ID, member.UserID)
	requireFault(t, err, "not_found")
	ownerMember := f.member(t, owner, p.ID)
	demoted, err := f.memberships.SetRole(ctx, owner, p.ID, owner.UserID, coreproject.SetProjectMemberRole{Version: ownerMember.Grant.Version, Role: model.ProjectMemberRole, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.memberships.Remove(ctx, owner, p.ID, owner.UserID, coreproject.RemoveProjectMember{Version: demoted.Version, ExpectedUserID: owner.UserID}); err != nil {
		t.Fatal(err)
	}
	people, err := f.memberships.List(ctx, owner, p.ID)
	if err != nil || len(people) != 1 || people[0].UserID != owner.UserID || people[0].EffectiveRole != model.ProjectAdmin || people[0].DirectGrant != nil {
		t.Fatalf("inherited owner after final direct removal: %#v %v", people, err)
	}
	requireFault(t, f.memberships.Remove(ctx, owner, p.ID, member.UserID, coreproject.RemoveProjectMember{Version: rejoined.Grant.Version, ExpectedUserID: owner.UserID}), "not_found")
	_, err = f.memberships.List(ctx, owner, uuid.NewString())
	requireFault(t, err, "not_found")
	legacy := f.project(t, outsider, "Other private project")
	_, err = f.memberships.List(ctx, owner, legacy.ID)
	requireFault(t, err, "not_found")
}

func TestMembershipConcurrentDirectAdministratorChanges(t *testing.T) {
	for _, remove := range []bool{false, true} {
		t.Run(fmt.Sprint("remove=", remove), func(t *testing.T) {
			f := newMembershipFixture(t)
			a, b := f.user(t), f.user(t)
			p := f.project(t, a, "Admin race")
			bm := f.join(t, a, b, p.ID).Grant
			bm, err := f.memberships.SetRole(context.Background(), a, p.ID, b.UserID, coreproject.SetProjectMemberRole{Version: bm.Version, Role: model.ProjectAdmin, ExpectedUserID: a.UserID})
			if err != nil {
				t.Fatal(err)
			}
			am := f.member(t, a, p.ID)
			results := competeTaskWrites(t, f.database, p.ID,
				func(ctx context.Context) (model.Task, error) {
					if remove {
						return model.Task{}, f.memberships.Remove(ctx, a, p.ID, a.UserID, coreproject.RemoveProjectMember{Version: am.Grant.Version, ExpectedUserID: a.UserID})
					}
					_, err := f.memberships.SetRole(ctx, a, p.ID, a.UserID, coreproject.SetProjectMemberRole{Version: am.Grant.Version, Role: model.ProjectMemberRole, ExpectedUserID: a.UserID})
					return model.Task{}, err
				},
				func(ctx context.Context) (model.Task, error) {
					if remove {
						return model.Task{}, f.memberships.Remove(ctx, b, p.ID, b.UserID, coreproject.RemoveProjectMember{Version: bm.Version, ExpectedUserID: b.UserID})
					}
					_, err := f.memberships.SetRole(ctx, b, p.ID, b.UserID, coreproject.SetProjectMemberRole{Version: bm.Version, Role: model.ProjectMemberRole, ExpectedUserID: b.UserID})
					return model.Task{}, err
				})
			for _, result := range results {
				if result.err != nil {
					t.Fatalf("independent direct grants: %v", result.err)
				}
			}
			var admins int
			if err := f.database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM project_grants WHERE project_id=$1 AND role='admin'`, p.ID).Scan(&admins); err != nil || admins != 0 {
				t.Fatalf("direct admins remain: %d %v", admins, err)
			}
		})
	}
}

func TestInvitationsLifecycleAndProjectOwnership(t *testing.T) {
	f := newMembershipFixture(t)
	owner, other, member := f.user(t), f.user(t), f.user(t)
	p := f.project(t, owner, "Invited project")
	ctx := context.Background()
	invitation := f.invite(t, owner, p.ID)
	if !secretutil.Valid(invitation.Secret, "dninvite_") || invitation.Invitation.TokenHash != nil || !invitation.Invitation.ExpiresAt.Equal(f.now.Add(coreproject.InvitationLifetime)) {
		t.Fatalf("mint: %#v", invitation)
	}
	var hash []byte
	if err := f.database.Pool.QueryRow(ctx, `SELECT token_hash FROM project_invitations WHERE id=$1`, invitation.Invitation.ID).Scan(&hash); err != nil || !bytes.Equal(hash, secretutil.Hash(invitation.Secret)) {
		t.Fatalf("secret hash: %x %v", hash, err)
	}
	for i := 0; i < 2; i++ {
		inspection, err := f.memberships.InspectInvitation(ctx, member, invitation.Secret)
		if err != nil || inspection.ProjectID != p.ID || inspection.ProjectName != p.Name || inspection.DirectGrant != nil || inspection.Access != nil {
			t.Fatalf("inspect: %#v %v", inspection, err)
		}
	}
	_, err := f.memberships.List(ctx, member, p.ID)
	requireFault(t, err, "not_found")
	original := f.member(t, owner, p.ID)
	existing, err := f.memberships.AcceptInvitation(ctx, owner, invitation.Secret, owner.UserID)
	if err != nil || !reflect.DeepEqual(existing.DirectGrant, original.Grant) || !reflect.DeepEqual(existing.Access.DirectGrant, &original.Grant) || existing.Joined || existing.Consumed {
		t.Fatalf("existing admin: %#v %v", existing, err)
	}
	active, err := f.memberships.ListInvitations(ctx, owner, p.ID)
	if err != nil || len(active) != 1 || active[0].TokenHash != nil {
		t.Fatalf("existing member consumed: %#v %v", active, err)
	}
	joined, err := f.memberships.AcceptInvitation(ctx, member, invitation.Secret, member.UserID)
	if err != nil || joined.DirectGrant.Role != model.ProjectMemberRole || !joined.Joined || !joined.Consumed || !reflect.DeepEqual(joined.Access.DirectGrant, &joined.DirectGrant) {
		t.Fatalf("accept: %#v %v", joined, err)
	}
	_, err = f.memberships.AcceptInvitation(ctx, other, invitation.Secret, other.UserID)
	requireFault(t, err, "invitation_unavailable")
	_, err = f.memberships.InspectInvitation(ctx, member, invitation.Secret)
	requireFault(t, err, "invitation_unavailable")
	_, err = f.memberships.CreateInvitation(ctx, member, p.ID, member.UserID)
	requireFault(t, err, "forbidden")
	_, err = f.memberships.ListInvitations(ctx, member, p.ID)
	requireFault(t, err, "forbidden")
	requireFault(t, f.memberships.RevokeInvitation(ctx, member, p.ID, invitation.Invitation.ID, member.UserID), "forbidden")
	active, err = f.memberships.ListInvitations(ctx, owner, p.ID)
	if err != nil || len(active) != 0 {
		t.Fatalf("consumed list: %#v %v", active, err)
	}
	replacement := f.invite(t, owner, p.ID)
	promoted, err := f.memberships.SetRole(ctx, owner, p.ID, member.UserID, coreproject.SetProjectMemberRole{Version: joined.DirectGrant.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.memberships.Remove(ctx, member, p.ID, owner.UserID, coreproject.RemoveProjectMember{Version: f.member(t, owner, p.ID).Grant.Version, ExpectedUserID: member.UserID}); err != nil {
		t.Fatal(err)
	}
	inspection, err := f.memberships.InspectInvitation(ctx, member, replacement.Secret)
	if err != nil || inspection.DirectGrant == nil || inspection.DirectGrant.Version != promoted.Version {
		t.Fatalf("member inspection: %#v %v", inspection, err)
	}
	if _, err := f.memberships.AcceptInvitation(ctx, other, replacement.Secret, other.UserID); err != nil {
		t.Fatalf("creator departure revoked project invitation: %v", err)
	}
	revoked := f.invite(t, member, p.ID)
	for i := 0; i < 2; i++ {
		if err := f.memberships.RevokeInvitation(ctx, member, p.ID, revoked.Invitation.ID, member.UserID); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.memberships.RevokeInvitation(ctx, member, p.ID, uuid.NewString(), member.UserID); err != nil {
		t.Fatal(err)
	}
	_, err = f.memberships.AcceptInvitation(ctx, owner, revoked.Secret, owner.UserID)
	requireFault(t, err, "invitation_unavailable")
	expiring := f.invite(t, member, p.ID)
	f.now = expiring.Invitation.ExpiresAt
	_, err = f.memberships.InspectInvitation(ctx, owner, expiring.Secret)
	requireFault(t, err, "invitation_unavailable")
	_, err = f.memberships.AcceptInvitation(ctx, owner, expiring.Secret, owner.UserID)
	requireFault(t, err, "invitation_unavailable")
	for _, secret := range []string{"bad", secretutil.Random("dninvite_")} {
		_, err = f.memberships.InspectInvitation(ctx, owner, secret)
		requireFault(t, err, "invitation_unavailable")
	}
}

func TestInvitationConcurrentAcceptanceAndAtomicRollback(t *testing.T) {
	f := newMembershipFixture(t)
	admin, a, b := f.user(t), f.user(t), f.user(t)
	p := f.project(t, admin, "Accept race")
	invitation := f.invite(t, admin, p.ID)
	results := competeTaskWrites(t, f.database, p.ID,
		func(ctx context.Context) (model.Task, error) {
			_, err := f.memberships.AcceptInvitation(ctx, a, invitation.Secret, a.UserID)
			return model.Task{}, err
		},
		func(ctx context.Context) (model.Task, error) {
			_, err := f.memberships.AcceptInvitation(ctx, b, invitation.Secret, b.UserID)
			return model.Task{}, err
		})
	assertOneTaskWinner(t, results, "invitation_unavailable")
	var newMembers int
	if err := f.database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM project_grants WHERE project_id=$1 AND role='member'`, p.ID).Scan(&newMembers); err != nil || newMembers != 1 {
		t.Fatalf("concurrent admission: %d %v", newMembers, err)
	}
	newcomer := f.user(t)
	retry := f.invite(t, admin, p.ID)
	ctx := context.Background()
	if _, err := f.database.Pool.Exec(ctx, `CREATE FUNCTION reject_invitation_consumption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected invitation consumption failure'; END $$; CREATE TRIGGER reject_invitation_consumption BEFORE UPDATE ON project_invitations FOR EACH ROW EXECUTE FUNCTION reject_invitation_consumption()`); err != nil {
		t.Fatal(err)
	}
	_, err := f.memberships.AcceptInvitation(ctx, newcomer, retry.Secret, newcomer.UserID)
	requireIdentityOperationalError(t, err)
	_, err = f.memberships.List(ctx, newcomer, p.ID)
	requireFault(t, err, "not_found")
	inspection, err := f.memberships.InspectInvitation(ctx, newcomer, retry.Secret)
	if err != nil || inspection.DirectGrant != nil {
		t.Fatalf("failed consume retained membership: %#v %v", inspection, err)
	}
	if _, err := f.database.Pool.Exec(ctx, `DROP TRIGGER reject_invitation_consumption ON project_invitations`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.memberships.AcceptInvitation(ctx, newcomer, retry.Secret, newcomer.UserID); err != nil {
		t.Fatalf("rollback consumed invitation: %v", err)
	}
}

func TestInvitationRevokeCompetesWithAcceptance(t *testing.T) {
	f := newMembershipFixture(t)
	admin, recipient := f.user(t), f.user(t)
	p := f.project(t, admin, "Revoke race")
	invite := f.invite(t, admin, p.ID)
	results := competeTaskWrites(t, f.database, p.ID,
		func(ctx context.Context) (model.Task, error) {
			_, err := f.memberships.AcceptInvitation(ctx, recipient, invite.Secret, recipient.UserID)
			return model.Task{}, err
		},
		func(ctx context.Context) (model.Task, error) {
			return model.Task{}, f.memberships.RevokeInvitation(ctx, admin, p.ID, invite.Invitation.ID, admin.UserID)
		})
	successes := 0
	for _, result := range results {
		if result.err == nil {
			successes++
		} else {
			requireFault(t, result.err, "invitation_unavailable")
		}
	}
	var consumed, revoked *time.Time
	var count int
	err := f.database.Pool.QueryRow(context.Background(), `SELECT consumed_at,revoked_at,(SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2) FROM project_invitations WHERE id=$3`, p.ID, recipient.UserID, invite.Invitation.ID).Scan(&consumed, &revoked, &count)
	if err != nil {
		t.Fatal(err)
	}
	if successes == 2 {
		if consumed == nil || count != 1 {
			t.Fatalf("accept winner: %v %v %d", consumed, revoked, count)
		}
	} else {
		if successes != 1 || revoked == nil || consumed != nil || count != 0 {
			t.Fatalf("revoke winner: %v %v %d", consumed, revoked, count)
		}
	}
}

func TestMembershipRejectsMissingPrincipalsAndInvalidInputs(t *testing.T) {
	ctx := context.Background()
	memberships := NewMemberships(nil)
	projects := NewProjects(nil)
	id := uuid.NewString()
	principals := []model.Principal{{}, {UserID: id}, {UserID: id, Kind: "unknown"}, {UserID: "invalid", CredentialID: uuid.NewString(), Kind: model.SessionCredential}, {UserID: id, CredentialID: "invalid", Kind: model.SessionCredential}}
	for _, p := range principals {
		_, err := coreproject.RequireProjectRead(ctx, nil, p, id)
		requireFault(t, err, "unauthenticated")
		_, err = coreproject.RequireProjectWrite(ctx, nil, p)
		requireFault(t, err, "unauthenticated")
		_, err = memberships.List(ctx, p, id)
		requireFault(t, err, "unauthenticated")
		_, err = memberships.SetRole(ctx, p, id, id, coreproject.SetProjectMemberRole{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: p.UserID})
		requireFault(t, err, "unauthenticated")
		requireFault(t, memberships.Remove(ctx, p, id, id, coreproject.RemoveProjectMember{Version: 1, ExpectedUserID: p.UserID}), "unauthenticated")
		_, err = memberships.CreateInvitation(ctx, p, id, p.UserID)
		requireFault(t, err, "unauthenticated")
		_, err = memberships.ListInvitations(ctx, p, id)
		requireFault(t, err, "unauthenticated")
		requireFault(t, memberships.RevokeInvitation(ctx, p, id, id, p.UserID), "unauthenticated")
		_, err = memberships.InspectInvitation(ctx, p, "invalid")
		requireFault(t, err, "unauthenticated")
		_, err = memberships.AcceptInvitation(ctx, p, "invalid", p.UserID)
		requireFault(t, err, "unauthenticated")
		_, err = projects.Create(ctx, p, coreproject.CreateProject{ExpectedUserID: p.UserID})
		requireFault(t, err, "unauthenticated")
		_, err = projects.List(ctx, p, model.PageRequest{})
		requireFault(t, err, "unauthenticated")
	}
	p := model.Principal{UserID: id, CredentialID: uuid.NewString(), Kind: model.SessionCredential}
	for _, call := range []func() error{
		func() error { _, err := memberships.List(ctx, p, "bad"); return err },
		func() error { _, err := coreproject.RequireProjectRead(ctx, nil, p, "bad"); return err },
		func() error { _, err := memberships.CreateInvitation(ctx, p, "bad", p.UserID); return err },
		func() error {
			_, err := memberships.SetRole(ctx, p, id, "bad", coreproject.SetProjectMemberRole{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: p.UserID})
			return err
		},
		func() error {
			_, err := memberships.SetRole(ctx, p, id, id, coreproject.SetProjectMemberRole{Version: 0, Role: model.ProjectAdmin, ExpectedUserID: p.UserID})
			return err
		},
		func() error {
			_, err := memberships.SetRole(ctx, p, id, id, coreproject.SetProjectMemberRole{Version: 1, Role: "owner", ExpectedUserID: p.UserID})
			return err
		},
		func() error {
			return memberships.Remove(ctx, p, id, id, coreproject.RemoveProjectMember{Version: 0, ExpectedUserID: p.UserID})
		},
		func() error { return memberships.RevokeInvitation(ctx, p, id, "bad", p.UserID) },
		func() error {
			_, err := projects.Create(ctx, p, coreproject.CreateProject{ExpectedUserID: p.UserID, Name: "", RepoURL: "host:repo"})
			return err
		},
		func() error { _, err := projects.List(ctx, p, model.PageRequest{Limit: 0}); return err },
	} {
		requireFault(t, call(), "invalid_input")
	}
}

func TestMembershipPATAndOperationalFailurePropagation(t *testing.T) {
	f := newMembershipFixture(t)
	admin := f.user(t)
	p := f.project(t, admin, "PAT")
	ctx := context.Background()
	identity := identityservice.New(f.database, nil, "")
	token, err := identity.CreatePAT(ctx, admin, identitycore.CreatePAT{Name: "Automation"})
	if err != nil {
		t.Fatal(err)
	}
	pat, err := identity.Authenticate(ctx, model.PATCredential, token.Secret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.memberships.List(ctx, pat, p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.memberships.CreateInvitation(ctx, pat, p.ID, pat.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.projects.Create(ctx, pat, coreproject.CreateProject{ExpectedUserID: pat.UserID, Name: "PAT project", RepoURL: "host:repo"}); err != nil {
		t.Fatal(err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = f.memberships.List(canceled, admin, p.ID)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation hidden: %v", err)
	}
	invitation := f.invite(t, admin, p.ID)
	f.database.Close()
	calls := []func() error{
		func() error { _, err := f.memberships.List(ctx, admin, p.ID); return err },
		func() error { _, err := f.memberships.CreateInvitation(ctx, admin, p.ID, admin.UserID); return err },
		func() error { _, err := f.memberships.InspectInvitation(ctx, admin, invitation.Secret); return err },
		func() error {
			_, err := f.projects.Create(ctx, admin, coreproject.CreateProject{ExpectedUserID: admin.UserID, Name: "Failure", RepoURL: "host:repo"})
			return err
		},
		func() error { _, err := f.projects.List(ctx, admin, model.PageRequest{Limit: 1}); return err },
	}
	for _, call := range calls {
		requireIdentityOperationalError(t, call())
	}
}

func TestMembershipInheritedOwnerAcceptsIndependentGrantAndRejectsLargeStaleVersion(t *testing.T) {
	f := newMembershipFixture(t)
	owner, admin := f.user(t), f.user(t)
	project := f.project(t, owner, "Independent grants")
	ctx := context.Background()
	joined := f.join(t, owner, admin, project.ID)
	if _, err := f.memberships.SetRole(ctx, owner, project.ID, admin.UserID, coreproject.SetProjectMemberRole{Version: joined.Grant.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID}); err != nil {
		t.Fatal(err)
	}
	const high int64 = 9007199254741999
	if _, err := f.database.Pool.Exec(ctx, `UPDATE project_grants SET version=$3 WHERE project_id=$1 AND user_id=$2;`, project.ID, owner.UserID, high); err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.Pool.Exec(ctx, `SELECT setval('project_grant_versions',$1,true)`, high); err != nil {
		t.Fatal(err)
	}
	if err := f.memberships.Remove(ctx, admin, project.ID, owner.UserID, coreproject.RemoveProjectMember{Version: high, ExpectedUserID: admin.UserID}); err != nil {
		t.Fatal(err)
	}
	invitation := f.invite(t, admin, project.ID)
	inspection, err := f.memberships.InspectInvitation(ctx, owner, invitation.Secret)
	if err != nil || inspection.DirectGrant != nil || inspection.Access == nil || inspection.Access.Role != model.ProjectAdmin {
		t.Fatalf("inherited access treated as direct grant: %#v %v", inspection, err)
	}
	replacement, err := f.memberships.AcceptInvitation(ctx, owner, invitation.Secret, owner.UserID)
	if err != nil || replacement.DirectGrant.Version <= high || replacement.DirectGrant.Role != model.ProjectMemberRole || !replacement.Joined || !replacement.Consumed || replacement.Access.Role != model.ProjectAdmin || !reflect.DeepEqual(replacement.Access.DirectGrant, &replacement.DirectGrant) {
		t.Fatalf("independent replacement grant: %#v %v", replacement, err)
	}
	_, err = f.memberships.SetRole(ctx, admin, project.ID, owner.UserID, coreproject.SetProjectMemberRole{Version: high, Role: model.ProjectAdmin, ExpectedUserID: admin.UserID})
	requireFault(t, err, "version_conflict")
	requireFault(t, f.memberships.Remove(ctx, admin, project.ID, owner.UserID, coreproject.RemoveProjectMember{Version: high, ExpectedUserID: admin.UserID}), "version_conflict")
	if got := f.member(t, owner, project.ID); !reflect.DeepEqual(got.Grant, replacement.DirectGrant) {
		t.Fatalf("stale large version changed new grant: %#v", got)
	}
	_, err = f.memberships.AcceptInvitation(ctx, admin, invitation.Secret, admin.UserID)
	requireFault(t, err, "invitation_unavailable")
	people, err := f.memberships.List(ctx, owner, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, person := range people {
		if person.UserID == owner.UserID && (person.EffectiveRole != model.ProjectAdmin || person.DirectGrant == nil || person.DirectGrant.Role != model.ProjectMemberRole) {
			t.Fatalf("inherited maximum overwrote grant: %#v", person)
		}
	}
}
