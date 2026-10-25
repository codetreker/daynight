package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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

func (f *membershipFixture) user(t *testing.T) core.Principal {
	t.Helper()
	ctx := context.Background()
	secret := randomSecret("dnst_")
	credential := core.Session{ID: uuid.NewString(), TokenHash: secretHash(secret), CreatedAt: f.now, ExpiresAt: f.now.Add(SessionLifetime)}
	_, err := f.database.CreateIdentitySession(ctx, core.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}, credential)
	if err != nil {
		t.Fatal(err)
	}
	principal, err := f.database.Authenticate(ctx, core.SessionCredential, secretHash(secret), f.now)
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

func (f *membershipFixture) project(t *testing.T, p core.Principal, name string) core.Project {
	t.Helper()
	project, err := f.projects.Create(context.Background(), p, CreateProject{Name: name, RepoURL: "https://example.com/team/repo.git"})
	if err != nil {
		t.Fatal(err)
	}
	return project
}

func (f *membershipFixture) invite(t *testing.T, p core.Principal, projectID string) MintedInvitation {
	t.Helper()
	invitation, err := f.memberships.CreateInvitation(context.Background(), p, projectID)
	if err != nil {
		t.Fatal(err)
	}
	return invitation
}

func (f *membershipFixture) join(t *testing.T, admin, p core.Principal, projectID string) core.ProjectMember {
	t.Helper()
	invite := f.invite(t, admin, projectID)
	member, err := f.memberships.AcceptInvitation(context.Background(), p, invite.Secret)
	if err != nil {
		t.Fatal(err)
	}
	return member
}

func (f *membershipFixture) member(t *testing.T, p core.Principal, projectID string) core.ProjectMember {
	t.Helper()
	var member core.ProjectMember
	if err := f.database.ReadSnapshot(context.Background(), func(snapshot *store.Snapshot) error {
		var err error
		member, err = snapshot.ProjectMember(context.Background(), p, projectID)
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
	if m := f.member(t, alice, a.ID); m.Role != core.ProjectAdmin {
		t.Fatalf("creator: %#v", m)
	}
	var names []string
	request := PageRequest{Limit: 1}
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
	empty, err := f.projects.List(ctx, stranger, PageRequest{Limit: 1})
	if err != nil || empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("empty access: %#v %v", empty, err)
	}
	if _, err := f.database.Pool.Exec(ctx, `CREATE FUNCTION reject_initial_admin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected admin insertion failure'; END $$; CREATE TRIGGER reject_initial_admin BEFORE INSERT ON project_members FOR EACH ROW EXECUTE FUNCTION reject_initial_admin()`); err != nil {
		t.Fatal(err)
	}
	_, err = f.projects.Create(ctx, alice, CreateProject{Name: "Must roll back", RepoURL: "host:repo"})
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
	for _, principal := range []core.Principal{owner, member} {
		members, err := f.memberships.List(ctx, principal, p.ID)
		if err != nil || len(members) != 2 {
			t.Fatalf("member list: %#v %v", members, err)
		}
	}
	_, err := f.memberships.List(ctx, outsider, p.ID)
	requireFault(t, err, "not_found")
	_, err = f.memberships.SetRole(ctx, member, p.ID, owner.UserID, f.member(t, owner, p.ID).Version, core.ProjectMemberRole)
	requireFault(t, err, "forbidden")
	_, err = f.memberships.SetRole(ctx, outsider, p.ID, member.UserID, joined.Version, core.ProjectAdmin)
	requireFault(t, err, "not_found")
	unchanged, err := f.memberships.SetRole(ctx, owner, p.ID, member.UserID, joined.Version, core.ProjectMemberRole)
	if err != nil || unchanged.Version != joined.Version {
		t.Fatalf("same role: %#v %v", unchanged, err)
	}
	promoted, err := f.memberships.SetRole(ctx, owner, p.ID, member.UserID, joined.Version, core.ProjectAdmin)
	if err != nil || promoted.Version <= joined.Version {
		t.Fatalf("promotion: %#v %v", promoted, err)
	}
	_, err = f.memberships.SetRole(ctx, owner, p.ID, member.UserID, joined.Version, core.ProjectMemberRole)
	requireFault(t, err, "version_conflict")
	requireFault(t, f.memberships.Remove(ctx, owner, p.ID, member.UserID, joined.Version), "version_conflict")
	if err := f.memberships.Remove(ctx, owner, p.ID, member.UserID, promoted.Version); err != nil {
		t.Fatal(err)
	}
	rejoined := f.join(t, owner, member, p.ID)
	if rejoined.Version <= promoted.Version {
		t.Fatal("rejoin reused an observed version")
	}
	_, err = f.memberships.SetRole(ctx, owner, p.ID, member.UserID, joined.Version, core.ProjectAdmin)
	requireFault(t, err, "version_conflict")
	requireFault(t, f.memberships.Remove(ctx, owner, p.ID, member.UserID, promoted.Version), "version_conflict")
	if f.member(t, member, p.ID).Role != core.ProjectMemberRole {
		t.Fatal("stale observation changed rejoined member")
	}
	if err := f.memberships.Remove(ctx, owner, p.ID, member.UserID, rejoined.Version); err != nil {
		t.Fatal(err)
	}
	_, err = f.memberships.List(ctx, member, p.ID)
	requireFault(t, err, "not_found")
	_, err = f.memberships.CreateInvitation(ctx, member, p.ID)
	requireFault(t, err, "not_found")
	ownerMember := f.member(t, owner, p.ID)
	_, err = f.memberships.SetRole(ctx, owner, p.ID, owner.UserID, ownerMember.Version, core.ProjectMemberRole)
	requireFault(t, err, "last_admin")
	requireFault(t, f.memberships.Remove(ctx, owner, p.ID, owner.UserID, ownerMember.Version), "last_admin")
	requireFault(t, f.memberships.Remove(ctx, owner, p.ID, member.UserID, rejoined.Version), "not_found")
	_, err = f.memberships.List(ctx, owner, uuid.NewString())
	requireFault(t, err, "not_found")
	legacy, err := f.database.CreateProject(ctx, uuid.NewString(), "Legacy", "host:repo")
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.memberships.List(ctx, owner, legacy.ID)
	requireFault(t, err, "not_found")
}

func TestMembershipConcurrentLastAdministratorChanges(t *testing.T) {
	for _, remove := range []bool{false, true} {
		t.Run(fmt.Sprint("remove=", remove), func(t *testing.T) {
			f := newMembershipFixture(t)
			a, b := f.user(t), f.user(t)
			p := f.project(t, a, "Admin race")
			bm := f.join(t, a, b, p.ID)
			bm, err := f.memberships.SetRole(context.Background(), a, p.ID, b.UserID, bm.Version, core.ProjectAdmin)
			if err != nil {
				t.Fatal(err)
			}
			am := f.member(t, a, p.ID)
			results := competeTaskWrites(t, f.database, p.ID,
				func(ctx context.Context) (core.Task, error) {
					if remove {
						return core.Task{}, f.memberships.Remove(ctx, a, p.ID, a.UserID, am.Version)
					}
					_, err := f.memberships.SetRole(ctx, a, p.ID, a.UserID, am.Version, core.ProjectMemberRole)
					return core.Task{}, err
				},
				func(ctx context.Context) (core.Task, error) {
					if remove {
						return core.Task{}, f.memberships.Remove(ctx, b, p.ID, b.UserID, bm.Version)
					}
					_, err := f.memberships.SetRole(ctx, b, p.ID, b.UserID, bm.Version, core.ProjectMemberRole)
					return core.Task{}, err
				})
			assertOneTaskWinner(t, results, "last_admin")
			var admins int
			if err := f.database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM project_members WHERE project_id=$1 AND role='admin'`, p.ID).Scan(&admins); err != nil || admins != 1 {
				t.Fatalf("admin invariant: %d %v", admins, err)
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
	if !validSecret(invitation.Secret, invitationPrefix) || invitation.Invitation.TokenHash != nil || !invitation.Invitation.ExpiresAt.Equal(f.now.Add(InvitationLifetime)) {
		t.Fatalf("mint: %#v", invitation)
	}
	var hash []byte
	if err := f.database.Pool.QueryRow(ctx, `SELECT token_hash FROM project_invitations WHERE id=$1`, invitation.Invitation.ID).Scan(&hash); err != nil || !bytes.Equal(hash, secretHash(invitation.Secret)) {
		t.Fatalf("secret hash: %x %v", hash, err)
	}
	for i := 0; i < 2; i++ {
		inspection, err := f.memberships.InspectInvitation(ctx, member, invitation.Secret)
		if err != nil || inspection.ProjectID != p.ID || inspection.ProjectName != p.Name || inspection.Member != nil {
			t.Fatalf("inspect: %#v %v", inspection, err)
		}
	}
	_, err := f.memberships.List(ctx, member, p.ID)
	requireFault(t, err, "not_found")
	existing, err := f.memberships.AcceptInvitation(ctx, owner, invitation.Secret)
	if err != nil || existing.Role != core.ProjectAdmin {
		t.Fatalf("existing admin: %#v %v", existing, err)
	}
	active, err := f.memberships.ListInvitations(ctx, owner, p.ID)
	if err != nil || len(active) != 1 || active[0].TokenHash != nil {
		t.Fatalf("existing member consumed: %#v %v", active, err)
	}
	joined, err := f.memberships.AcceptInvitation(ctx, member, invitation.Secret)
	if err != nil || joined.Role != core.ProjectMemberRole {
		t.Fatalf("accept: %#v %v", joined, err)
	}
	_, err = f.memberships.AcceptInvitation(ctx, other, invitation.Secret)
	requireFault(t, err, "invitation_unavailable")
	_, err = f.memberships.InspectInvitation(ctx, member, invitation.Secret)
	requireFault(t, err, "invitation_unavailable")
	_, err = f.memberships.CreateInvitation(ctx, member, p.ID)
	requireFault(t, err, "forbidden")
	_, err = f.memberships.ListInvitations(ctx, member, p.ID)
	requireFault(t, err, "forbidden")
	requireFault(t, f.memberships.RevokeInvitation(ctx, member, p.ID, invitation.Invitation.ID), "forbidden")
	active, err = f.memberships.ListInvitations(ctx, owner, p.ID)
	if err != nil || len(active) != 0 {
		t.Fatalf("consumed list: %#v %v", active, err)
	}
	replacement := f.invite(t, owner, p.ID)
	promoted, err := f.memberships.SetRole(ctx, owner, p.ID, member.UserID, joined.Version, core.ProjectAdmin)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.memberships.Remove(ctx, member, p.ID, owner.UserID, f.member(t, owner, p.ID).Version); err != nil {
		t.Fatal(err)
	}
	inspection, err := f.memberships.InspectInvitation(ctx, member, replacement.Secret)
	if err != nil || inspection.Member == nil || inspection.Member.Version != promoted.Version {
		t.Fatalf("member inspection: %#v %v", inspection, err)
	}
	if _, err := f.memberships.AcceptInvitation(ctx, other, replacement.Secret); err != nil {
		t.Fatalf("creator departure revoked project invitation: %v", err)
	}
	revoked := f.invite(t, member, p.ID)
	for i := 0; i < 2; i++ {
		if err := f.memberships.RevokeInvitation(ctx, member, p.ID, revoked.Invitation.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.memberships.RevokeInvitation(ctx, member, p.ID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	_, err = f.memberships.AcceptInvitation(ctx, owner, revoked.Secret)
	requireFault(t, err, "invitation_unavailable")
	expiring := f.invite(t, member, p.ID)
	f.now = expiring.Invitation.ExpiresAt
	_, err = f.memberships.InspectInvitation(ctx, owner, expiring.Secret)
	requireFault(t, err, "invitation_unavailable")
	_, err = f.memberships.AcceptInvitation(ctx, owner, expiring.Secret)
	requireFault(t, err, "invitation_unavailable")
	for _, secret := range []string{"bad", randomSecret(invitationPrefix)} {
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
		func(ctx context.Context) (core.Task, error) {
			_, err := f.memberships.AcceptInvitation(ctx, a, invitation.Secret)
			return core.Task{}, err
		},
		func(ctx context.Context) (core.Task, error) {
			_, err := f.memberships.AcceptInvitation(ctx, b, invitation.Secret)
			return core.Task{}, err
		})
	assertOneTaskWinner(t, results, "invitation_unavailable")
	var newMembers int
	if err := f.database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM project_members WHERE project_id=$1 AND role='member'`, p.ID).Scan(&newMembers); err != nil || newMembers != 1 {
		t.Fatalf("concurrent admission: %d %v", newMembers, err)
	}
	newcomer := f.user(t)
	retry := f.invite(t, admin, p.ID)
	ctx := context.Background()
	if _, err := f.database.Pool.Exec(ctx, `CREATE FUNCTION reject_invitation_consumption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected invitation consumption failure'; END $$; CREATE TRIGGER reject_invitation_consumption BEFORE UPDATE ON project_invitations FOR EACH ROW EXECUTE FUNCTION reject_invitation_consumption()`); err != nil {
		t.Fatal(err)
	}
	_, err := f.memberships.AcceptInvitation(ctx, newcomer, retry.Secret)
	requireIdentityOperationalError(t, err)
	_, err = f.memberships.List(ctx, newcomer, p.ID)
	requireFault(t, err, "not_found")
	inspection, err := f.memberships.InspectInvitation(ctx, newcomer, retry.Secret)
	if err != nil || inspection.Member != nil {
		t.Fatalf("failed consume retained membership: %#v %v", inspection, err)
	}
	if _, err := f.database.Pool.Exec(ctx, `DROP TRIGGER reject_invitation_consumption ON project_invitations`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.memberships.AcceptInvitation(ctx, newcomer, retry.Secret); err != nil {
		t.Fatalf("rollback consumed invitation: %v", err)
	}
}

func TestMembershipRejectsMissingPrincipalsAndInvalidInputs(t *testing.T) {
	ctx := context.Background()
	memberships := NewMemberships(nil)
	projects := NewProjects(nil)
	id := uuid.NewString()
	principals := []core.Principal{{}, {UserID: id}, {UserID: id, Kind: "unknown"}, {UserID: "invalid", CredentialID: uuid.NewString(), Kind: core.SessionCredential}, {UserID: id, CredentialID: "invalid", Kind: core.SessionCredential}}
	for _, p := range principals {
		_, err := RequireProjectRead(ctx, nil, p, id)
		requireFault(t, err, "unauthenticated")
		_, err = RequireProjectWrite(ctx, nil, p)
		requireFault(t, err, "unauthenticated")
		_, err = memberships.List(ctx, p, id)
		requireFault(t, err, "unauthenticated")
		_, err = memberships.SetRole(ctx, p, id, id, 1, core.ProjectAdmin)
		requireFault(t, err, "unauthenticated")
		requireFault(t, memberships.Remove(ctx, p, id, id, 1), "unauthenticated")
		_, err = memberships.CreateInvitation(ctx, p, id)
		requireFault(t, err, "unauthenticated")
		_, err = memberships.ListInvitations(ctx, p, id)
		requireFault(t, err, "unauthenticated")
		requireFault(t, memberships.RevokeInvitation(ctx, p, id, id), "unauthenticated")
		_, err = memberships.InspectInvitation(ctx, p, "invalid")
		requireFault(t, err, "unauthenticated")
		_, err = memberships.AcceptInvitation(ctx, p, "invalid")
		requireFault(t, err, "unauthenticated")
		_, err = projects.Create(ctx, p, CreateProject{})
		requireFault(t, err, "unauthenticated")
		_, err = projects.List(ctx, p, PageRequest{})
		requireFault(t, err, "unauthenticated")
	}
	p := core.Principal{UserID: id, CredentialID: uuid.NewString(), Kind: core.SessionCredential}
	for _, call := range []func() error{
		func() error { _, err := memberships.List(ctx, p, "bad"); return err },
		func() error { _, err := RequireProjectRead(ctx, nil, p, "bad"); return err },
		func() error { _, err := memberships.CreateInvitation(ctx, p, "bad"); return err },
		func() error { _, err := memberships.SetRole(ctx, p, id, "bad", 1, core.ProjectAdmin); return err },
		func() error { _, err := memberships.SetRole(ctx, p, id, id, 0, core.ProjectAdmin); return err },
		func() error { _, err := memberships.SetRole(ctx, p, id, id, 1, "owner"); return err },
		func() error { return memberships.Remove(ctx, p, id, id, 0) },
		func() error { return memberships.RevokeInvitation(ctx, p, id, "bad") },
		func() error {
			_, err := projects.Create(ctx, p, CreateProject{Name: "", RepoURL: "host:repo"})
			return err
		},
		func() error { _, err := projects.List(ctx, p, PageRequest{Limit: 0}); return err },
	} {
		requireFault(t, call(), "invalid_input")
	}
}

func TestMembershipPATAndOperationalFailurePropagation(t *testing.T) {
	f := newMembershipFixture(t)
	admin := f.user(t)
	p := f.project(t, admin, "PAT")
	ctx := context.Background()
	identity := NewIdentity(f.database, nil, "")
	identity.now = func() time.Time { return f.now }
	token, err := identity.CreatePAT(ctx, admin, CreatePAT{Name: "Automation"})
	if err != nil {
		t.Fatal(err)
	}
	pat, err := identity.Authenticate(ctx, core.PATCredential, token.Secret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.memberships.List(ctx, pat, p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.memberships.CreateInvitation(ctx, pat, p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.projects.Create(ctx, pat, CreateProject{Name: "PAT project", RepoURL: "host:repo"}); err != nil {
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
		func() error { _, err := f.memberships.CreateInvitation(ctx, admin, p.ID); return err },
		func() error { _, err := f.memberships.InspectInvitation(ctx, admin, invitation.Secret); return err },
		func() error {
			_, err := f.projects.Create(ctx, admin, CreateProject{Name: "Failure", RepoURL: "host:repo"})
			return err
		},
		func() error { _, err := f.projects.List(ctx, admin, PageRequest{Limit: 1}); return err },
	}
	for _, call := range calls {
		requireIdentityOperationalError(t, call())
	}
}
