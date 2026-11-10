package project

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

const memberUser = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const memberOther = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

var memberPrincipal = model.Principal{UserID: memberUser, CredentialID: memberOther, Kind: model.PATCredential}
var membershipErr = errors.New("database failure")

func membershipFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

type membershipDAO struct {
	store.ProjectWriteDAO
	contract     *projectInvitationContract
	failures     map[string]error
	calls        []string
	member       model.ProjectMember
	grant        model.ProjectGrant
	access       model.ProjectAccess
	invitation   model.ProjectInvitation
	project      model.Project
	participants []model.ProjectParticipant
}

type projectInvitationContract struct {
	t           *testing.T
	ctx         context.Context
	p           model.Principal
	project, id string
	hash        []byte
	now         time.Time
	plan        []string
}

func (d *membershipDAO) invitationContext(ctx context.Context) {
	if d.contract != nil {
		if ctx != d.contract.ctx {
			d.contract.t.Fatal("invitation changed context")
		}
	}
}
func (d *membershipDAO) invitationActor(ctx context.Context, user string) {
	d.invitationContext(ctx)
	if d.contract != nil {
		contractEqual(d.contract.t, user, d.contract.p.UserID)
	}
}
func (d *membershipDAO) invitationHash(ctx context.Context, hash []byte) {
	d.invitationContext(ctx)
	if d.contract != nil {
		contractEqual(d.contract.t, hash, d.contract.hash)
	}
}
func cloneProjectInvitation(v model.ProjectInvitation) model.ProjectInvitation {
	v.TokenHash = append([]byte(nil), v.TokenHash...)
	v.ConsumedBy = contractClonePointer(v.ConsumedBy)
	v.ConsumedAt = contractClonePointer(v.ConsumedAt)
	v.RevokedAt = contractClonePointer(v.RevokedAt)
	return v
}

func (d *membershipDAO) fail(op string) error {
	if d.contract != nil {
		i := len(d.calls)
		if i >= len(d.contract.plan) || d.contract.plan[i] != op {
			d.contract.t.Fatalf("unexpected invitation DAO %s at %d; want %v", op, i, d.contract.plan)
		}
	}
	d.calls = append(d.calls, op)
	return d.failures[op]
}
func (d *membershipDAO) expectInvitationCalls(next ...string) {
	if !slices.Equal(d.calls, d.contract.plan) {
		d.contract.t.Fatalf("invitation calls=%v; want %v", d.calls, d.contract.plan)
	}
	d.calls = nil
	d.contract.plan = slices.Clone(next)
}
func (d *membershipDAO) ProjectParticipants(_ context.Context, _ string) ([]model.ProjectParticipant, error) {
	return d.participants, d.fail("participants")
}
func (d *membershipDAO) DirectProjectMember(ctx context.Context, user string) (model.ProjectMember, error) {
	d.invitationActor(ctx, user)
	return d.member, d.fail("member")
}
func (d *membershipDAO) SetMemberRole(_ context.Context, _ string, role model.ProjectRole) (model.ProjectMember, error) {
	d.member.Grant.Role = role
	return d.member, d.fail("setRole")
}
func (d *membershipDAO) RemoveMember(_ context.Context, _ string) error { return d.fail("remove") }
func (d *membershipDAO) DirectGrant(_ context.Context, _ string) (model.ProjectGrant, error) {
	return d.grant, d.fail("grant")
}
func (d *membershipDAO) CreateGrant(_ context.Context, _ string, role model.ProjectRole) (model.ProjectGrant, error) {
	d.grant.Role = role
	return d.grant, d.fail("createGrant")
}
func (d *membershipDAO) ProjectAccess(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
	d.invitationContext(ctx)
	if d.contract != nil {
		contractEqual(d.contract.t, p, d.contract.p)
	}
	return contractCloneAccess(d.access), d.fail("access:" + p.UserID)
}
func (d *membershipDAO) AddInvitedMember(ctx context.Context, user string) (model.ProjectMember, error) {
	d.invitationActor(ctx, user)
	return d.member, d.fail("add")
}
func (d *membershipDAO) LockInvitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	d.invitationHash(ctx, hash)
	return cloneProjectInvitation(d.invitation), d.fail("lockInvitation")
}
func (d *membershipDAO) CreateInvitation(ctx context.Context, i model.ProjectInvitation) error {
	d.invitationContext(ctx)
	if d.contract != nil {
		contractEqual(d.contract.t, []string{i.ProjectID, i.CreatedBy}, []string{d.contract.project, d.contract.p.UserID})
	}
	d.invitation = cloneProjectInvitation(i)
	return d.fail("createInvitation")
}
func (d *membershipDAO) RevokeInvitation(ctx context.Context, id string, at time.Time) error {
	d.invitationContext(ctx)
	if d.contract != nil {
		contractEqual(d.contract.t, id, d.contract.id)
		contractEqual(d.contract.t, at, d.contract.now)
	}
	return d.fail("revoke")
}
func (d *membershipDAO) ConsumeInvitation(ctx context.Context, id, user string, at time.Time) error {
	d.invitationActor(ctx, user)
	if d.contract != nil {
		contractEqual(d.contract.t, id, d.contract.id)
		contractEqual(d.contract.t, at, d.contract.now)
	}
	return d.fail("consume")
}

type membershipReader struct {
	store.ProjectReader
	d *membershipDAO
}

func (d membershipReader) Project(ctx context.Context, id string) (model.Project, error) {
	d.d.invitationContext(ctx)
	if d.d.contract != nil {
		contractEqual(d.d.contract.t, id, d.d.contract.project)
	}
	return d.d.project, d.d.fail("project")
}
func (d membershipReader) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	d.d.invitationContext(ctx)
	if d.d.contract != nil {
		contractEqual(d.d.contract.t, p, d.d.contract.p)
		contractEqual(d.d.contract.t, id, d.d.contract.project)
	}
	return contractCloneAccess(d.d.access), d.d.fail("readAccess")
}
func (d membershipReader) Invitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	d.d.invitationHash(ctx, hash)
	return cloneProjectInvitation(d.d.invitation), d.d.fail("invitation")
}
func (d membershipReader) Invitations(ctx context.Context, id string, at time.Time) ([]model.ProjectInvitation, error) {
	d.d.invitationContext(ctx)
	if d.d.contract != nil {
		contractEqual(d.d.contract.t, id, d.d.contract.project)
		contractEqual(d.d.contract.t, at, d.d.contract.now)
	}
	return []model.ProjectInvitation{cloneProjectInvitation(d.d.invitation)}, d.d.fail("invitations")
}
func (d membershipReader) ProjectParticipants(ctx context.Context, id string) ([]model.ProjectParticipant, error) {
	return d.d.ProjectParticipants(ctx, id)
}

func TestMembershipInputValidation(t *testing.T) {
	if err := ValidateMemberActor(memberPrincipal, memberUser); err != nil {
		t.Fatal(err)
	}
	membershipFault(t, ValidateMemberActor(model.Principal{}, memberUser), "unauthenticated")
	if err := ValidateMemberActor(memberPrincipal, "bad"); err == nil {
		t.Fatal("accepted invalid actor")
	}
	membershipFault(t, ValidateMemberActor(memberPrincipal, strings.ToUpper(memberUser)), "invalid_input")
	membershipFault(t, ValidateMemberActor(memberPrincipal, memberOther), "identity_mismatch")
	if _, err := ValidateMemberMutation("bad", 1); err == nil {
		t.Fatal("accepted invalid user")
	}
	if _, err := ValidateMemberMutation(memberUser, 0); err == nil {
		t.Fatal("accepted zero version")
	}
	if id, err := ValidateMemberMutation(memberUser, 1); err != nil || id != memberUser {
		t.Fatalf("id %q, err %v", id, err)
	}
	if err := ValidateRole(model.ProjectMemberRole); err != nil {
		t.Fatal(err)
	}
	if err := ValidateRole("owner"); err == nil {
		t.Fatal("accepted invalid role")
	}
	zero := int64(0)
	input := SetProjectGrant{ExpectedUserID: memberUser, Role: model.ProjectAdmin}
	if _, err := ValidateSetGrant(memberPrincipal, memberOther, input); err != nil {
		t.Fatal(err)
	}
	bad := input
	bad.ExpectedUserID = memberOther
	if _, err := ValidateSetGrant(memberPrincipal, memberOther, bad); err == nil {
		t.Fatal("accepted changed actor")
	}
	if _, err := ValidateSetGrant(memberPrincipal, "bad", input); err == nil {
		t.Fatal("accepted invalid user")
	}
	bad = input
	bad.Version = &zero
	if _, err := ValidateSetGrant(memberPrincipal, memberOther, bad); err == nil {
		t.Fatal("accepted zero version")
	}
	bad = input
	bad.Role = "owner"
	if _, err := ValidateSetGrant(memberPrincipal, memberOther, bad); err == nil {
		t.Fatal("accepted invalid role")
	}
}

func TestMemberMutationVersionsAndFailures(t *testing.T) {
	ctx := context.Background()
	grant := model.ProjectGrant{Version: 2, Role: model.ProjectMemberRole}
	d := &membershipDAO{member: model.ProjectMember{Grant: grant}}
	input := SetProjectMemberRole{Version: 2, Role: model.ProjectMemberRole}
	got, err := SetRole(ctx, d, memberOther, input)
	if err != nil || got != grant || len(d.calls) != 1 {
		t.Fatalf("no-op %v %v %v", got, err, d.calls)
	}
	input.Role = model.ProjectAdmin
	got, err = SetRole(ctx, d, memberOther, input)
	if err != nil || got.Role != model.ProjectAdmin {
		t.Fatalf("role %v %v", got, err)
	}
	input.Version = 1
	_, err = SetRole(ctx, d, memberOther, input)
	membershipFault(t, err, "version_conflict")
	if err := Remove(ctx, d, memberOther, RemoveProjectMember{Version: 2}); err != nil {
		t.Fatal(err)
	}
	d.failures = map[string]error{"member": model.ErrNotFound}
	_, err = SetRole(ctx, d, memberOther, input)
	membershipFault(t, err, "not_found")
	d.failures["member"] = membershipErr
	if err := Remove(ctx, d, memberOther, RemoveProjectMember{Version: 2}); !errors.Is(err, membershipErr) {
		t.Fatalf("lost lookup error: %v", err)
	}
	d.failures = map[string]error{"remove": membershipErr}
	if err := Remove(ctx, d, memberOther, RemoveProjectMember{Version: 2}); !errors.Is(err, membershipErr) {
		t.Fatalf("lost remove error: %v", err)
	}
	d.failures = map[string]error{"setRole": membershipErr}
	input.Version = 2
	input.Role = model.ProjectMemberRole
	if _, err := SetRole(ctx, d, memberOther, input); !errors.Is(err, membershipErr) {
		t.Fatalf("lost update error: %v", err)
	}
	reader := membershipReader{d: &membershipDAO{participants: []model.ProjectParticipant{{UserID: memberUser}}}}
	access := model.ProjectAccess{Role: model.ProjectAdmin}
	result, err := ListParticipants(ctx, reader, "project", access)
	if err != nil || len(result.Items) != 1 || result.ActorAccess.Role != access.Role {
		t.Fatalf("participants %v %v", result, err)
	}
}

func TestGrantVersionAndAccessRules(t *testing.T) {
	ctx := context.Background()
	v := int64(2)
	grant := model.ProjectGrant{Version: v, Role: model.ProjectMemberRole}
	input := SetProjectGrant{Role: model.ProjectAdmin}
	t.Run("create for participant", func(t *testing.T) {
		d := &membershipDAO{grant: grant, failures: map[string]error{"grant": model.ErrNotFound}}
		r, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		if err != nil || r.Grant.Role != model.ProjectAdmin || r.ActorAccess == nil {
			t.Fatalf("result %v error %v", r, err)
		}
	})
	t.Run("existing grant conflicts with create", func(t *testing.T) {
		d := &membershipDAO{grant: grant}
		_, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		membershipFault(t, err, "version_conflict")
	})
	t.Run("nonparticipant rejected", func(t *testing.T) {
		d := &membershipDAO{failures: map[string]error{"grant": model.ErrNotFound, "access:" + memberOther: model.ErrNotFound}}
		_, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		membershipFault(t, err, "not_found")
	})
	t.Run("participant lookup error", func(t *testing.T) {
		d := &membershipDAO{failures: map[string]error{"grant": model.ErrNotFound, "access:" + memberOther: membershipErr}}
		_, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		if !errors.Is(err, membershipErr) {
			t.Fatal(err)
		}
	})
	t.Run("create failure", func(t *testing.T) {
		d := &membershipDAO{failures: map[string]error{"grant": model.ErrNotFound, "createGrant": membershipErr}}
		_, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		if !errors.Is(err, membershipErr) {
			t.Fatal(err)
		}
	})
	t.Run("replace and actor loses access", func(t *testing.T) {
		d := &membershipDAO{grant: grant, member: model.ProjectMember{Grant: grant}, failures: map[string]error{"access:" + memberUser: model.ErrNotFound}}
		input.Version = &v
		r, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		if err != nil || r.Grant.Role != model.ProjectAdmin || r.ActorAccess != nil {
			t.Fatalf("result %v error %v", r, err)
		}
	})
	t.Run("same role no update", func(t *testing.T) {
		d := &membershipDAO{grant: grant}
		input.Version = &v
		input.Role = model.ProjectMemberRole
		r, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		if err != nil || r.Grant != grant || len(d.calls) != 2 {
			t.Fatalf("result %v error %v calls %v", r, err, d.calls)
		}
	})
	t.Run("stale version", func(t *testing.T) {
		d := &membershipDAO{grant: grant}
		stale := int64(1)
		input.Version = &stale
		_, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		membershipFault(t, err, "version_conflict")
	})
	t.Run("missing replacement", func(t *testing.T) {
		d := &membershipDAO{failures: map[string]error{"grant": model.ErrNotFound}}
		input.Version = &v
		_, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		membershipFault(t, err, "version_conflict")
	})
	t.Run("database errors", func(t *testing.T) {
		d := &membershipDAO{failures: map[string]error{"grant": membershipErr}}
		_, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		if !errors.Is(err, membershipErr) {
			t.Fatal(err)
		}
		_, err = RemoveGrant(ctx, d, memberPrincipal, "p", memberOther, RemoveProjectMember{Version: v})
		if !errors.Is(err, membershipErr) {
			t.Fatal(err)
		}
	})
	t.Run("replace error", func(t *testing.T) {
		d := &membershipDAO{grant: grant, failures: map[string]error{"setRole": membershipErr}}
		input.Version = &v
		input.Role = model.ProjectAdmin
		_, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		if !errors.Is(err, membershipErr) {
			t.Fatal(err)
		}
	})
	t.Run("access error after write", func(t *testing.T) {
		d := &membershipDAO{grant: grant, failures: map[string]error{"access:" + memberUser: membershipErr}}
		input.Version = &v
		input.Role = model.ProjectMemberRole
		_, err := SetGrant(ctx, d, memberPrincipal, memberOther, input)
		if !errors.Is(err, membershipErr) {
			t.Fatal(err)
		}
	})
	t.Run("remove", func(t *testing.T) {
		d := &membershipDAO{grant: grant, failures: map[string]error{"access:" + memberUser: model.ErrNotFound}}
		r, err := RemoveGrant(ctx, d, memberPrincipal, "p", memberOther, RemoveProjectMember{Version: v})
		if err != nil || r.ActorAccess != nil || r.ProjectID != "p" || r.UserID != memberOther {
			t.Fatalf("result %v error %v", r, err)
		}
	})
	t.Run("remove conflict and failure", func(t *testing.T) {
		d := &membershipDAO{grant: grant}
		_, err := RemoveGrant(ctx, d, memberPrincipal, "p", memberOther, RemoveProjectMember{Version: 1})
		membershipFault(t, err, "version_conflict")
		d.failures = map[string]error{"remove": membershipErr}
		_, err = RemoveGrant(ctx, d, memberPrincipal, "p", memberOther, RemoveProjectMember{Version: v})
		if !errors.Is(err, membershipErr) {
			t.Fatal(err)
		}
	})
}

func TestInvitationCreationInspectionAndExpiry(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	p := contractPrincipal()
	value := contractProject("a7777777-7777-4777-8777-777777777777", "Invite Project", "https://example.test/owner/repo.git", "b8888888-8888-4888-8888-888888888888")
	token := "dninvite_" + strings.Repeat("C", 42) + "A"
	if err := ValidateInvitation(p, token); err != nil {
		t.Fatal(err)
	}
	membershipFault(t, ValidateInvitation(model.Principal{}, token), "unauthenticated")
	membershipFault(t, ValidateInvitation(p, "invalid"), "invitation_unavailable")
	invite := model.ProjectInvitation{ID: "c9999999-9999-4999-8999-999999999999", ProjectID: value.ID, CreatedBy: p.UserID, TokenHash: secretutil.Hash(token), CreatedAt: value.CreatedAt, ExpiresAt: now.Add(24 * time.Hour)}
	d := &membershipDAO{contract: &projectInvitationContract{t: t, ctx: ctx, p: p, project: value.ID, id: invite.ID, hash: secretutil.Hash(token), now: now}}
	d.expectInvitationCalls("createInvitation")
	t.Cleanup(func() { d.expectInvitationCalls() })
	minted, err := CreateInvitation(ctx, d, p, value.ID, clock)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := uuid.Parse(minted.Invitation.ID)
	if err != nil || parsed.Version() != 4 || parsed.Variant() != uuid.RFC4122 || parsed.String() != minted.Invitation.ID || !secretutil.Valid(minted.Secret, invitationPrefix) {
		t.Fatalf("invitation ID=%q %v", minted.Invitation.ID, err)
	}
	expected := model.ProjectInvitation{ID: minted.Invitation.ID, ProjectID: value.ID, CreatedBy: p.UserID, TokenHash: secretutil.Hash(minted.Secret), CreatedAt: now, ExpiresAt: now.Add(InvitationLifetime)}
	contractEqual(t, d.invitation, expected)
	expected.TokenHash = nil
	contractEqual(t, minted.Invitation, expected)
	d.failures = map[string]error{"createInvitation": membershipErr}
	d.expectInvitationCalls("createInvitation")
	if _, err = CreateInvitation(ctx, d, p, value.ID, clock); !errors.Is(err, membershipErr) {
		t.Fatal(err)
	}
	d.failures = nil
	d.invitation = cloneProjectInvitation(invite)
	reader := membershipReader{d: d}
	d.expectInvitationCalls("invitation")
	got, err := Invitation(ctx, reader, token, clock)
	if err != nil {
		t.Fatal(err)
	}
	contractEqual(t, got, invite)
	d.expectInvitationCalls("invitations")
	invitations, err := ListInvitations(ctx, reader, value.ID, clock)
	if err != nil {
		t.Fatal(err)
	}
	contractEqual(t, invitations, []model.ProjectInvitation{invite})
	d.expectInvitationCalls("revoke")
	if err := RevokeInvitation(ctx, d, invite.ID, clock); err != nil {
		t.Fatal(err)
	}
	d.invitation.ExpiresAt = now
	d.expectInvitationCalls("invitation")
	_, err = Invitation(ctx, reader, token, clock)
	membershipFault(t, err, "invitation_unavailable")
	d.failures = map[string]error{"invitation": model.ErrNotFound}
	d.expectInvitationCalls("invitation")
	_, err = Invitation(ctx, reader, token, clock)
	membershipFault(t, err, "invitation_unavailable")
	d.failures["invitation"] = membershipErr
	d.expectInvitationCalls("invitation")
	if _, err = Invitation(ctx, reader, token, clock); !errors.Is(err, membershipErr) {
		t.Fatal(err)
	}
	d.failures = nil
	d.project = value
	d.access = contractAccess(p, value)
	wantAccess := contractAccess(p, value)
	d.expectInvitationCalls("project", "readAccess")
	inspected, err := InspectInvitation(ctx, reader, p, cloneProjectInvitation(invite))
	if err != nil {
		t.Fatal(err)
	}
	contractEqual(t, inspected, InvitationInspection{ProjectID: value.ID, ProjectName: value.Name, DirectGrant: contractClonePointer(wantAccess.DirectGrant), Access: &wantAccess})
	member := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	d.contract.p = member
	d.failures = map[string]error{"readAccess": model.ErrNotFound}
	d.expectInvitationCalls("project", "readAccess")
	inspected, err = InspectInvitation(ctx, reader, member, cloneProjectInvitation(invite))
	if err != nil {
		t.Fatal(err)
	}
	contractEqual(t, inspected, InvitationInspection{ProjectID: value.ID, ProjectName: value.Name})
	d.failures["readAccess"] = membershipErr
	d.expectInvitationCalls("project", "readAccess")
	if _, err = InspectInvitation(ctx, reader, member, invite); !errors.Is(err, membershipErr) {
		t.Fatal(err)
	}
	d.failures = map[string]error{"project": model.ErrNotFound}
	d.expectInvitationCalls("project")
	_, err = InspectInvitation(ctx, reader, member, invite)
	membershipFault(t, err, "invitation_unavailable")
	d.failures["project"] = membershipErr
	d.expectInvitationCalls("project")
	if _, err = InspectInvitation(ctx, reader, member, invite); !errors.Is(err, membershipErr) {
		t.Fatal(err)
	}
}

func TestInvitationAcceptanceRechecksAndFailures(t *testing.T) {
	now := time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	admin := contractPrincipal()
	member := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	value := contractProject("a7777777-7777-4777-8777-777777777777", "Invite Project", "https://example.test/owner/repo.git", "b8888888-8888-4888-8888-888888888888")
	token := "dninvite_" + strings.Repeat("C", 42) + "A"
	invite := model.ProjectInvitation{ID: "c9999999-9999-4999-8999-999999999999", ProjectID: value.ID, CreatedBy: admin.UserID, TokenHash: secretutil.Hash(token), CreatedAt: value.CreatedAt, ExpiresAt: now.Add(24 * time.Hour)}
	newDAO := func(t *testing.T, p model.Principal) *membershipDAO {
		access := contractAccess(p, value)
		if p == member {
			access.Role = model.ProjectMemberRole
			access.DirectGrant.Role = model.ProjectMemberRole
		}
		d := &membershipDAO{contract: &projectInvitationContract{t: t, ctx: t.Context(), p: p, project: value.ID, id: invite.ID, hash: secretutil.Hash(token), now: now}, invitation: cloneProjectInvitation(invite), member: model.ProjectMember{Grant: *access.DirectGrant}, access: contractCloneAccess(access)}
		t.Cleanup(func() { d.expectInvitationCalls() })
		return d
	}
	t.Run("new member consumes", func(t *testing.T) {
		d := newDAO(t, member)
		d.expectInvitationCalls("lockInvitation", "member", "add", "consume", "access:"+member.UserID)
		d.failures = map[string]error{"member": model.ErrNotFound}
		wantAccess := contractCloneAccess(d.access)
		got, err := AcceptInvitation(t.Context(), d, member, value.ID, token, clock)
		want := InvitationAcceptance{ProjectID: value.ID, DirectGrant: *wantAccess.DirectGrant, Access: wantAccess, Joined: true, Consumed: true}
		if err != nil {
			t.Fatal(err)
		}
		contractEqual(t, got, want)
		contractEqual(t, d.calls, []string{"lockInvitation", "member", "add", "consume", "access:" + member.UserID})
	})
	t.Run("existing member leaves invite unused", func(t *testing.T) {
		d := newDAO(t, admin)
		d.expectInvitationCalls("lockInvitation", "member", "access:"+admin.UserID)
		wantAccess := contractCloneAccess(d.access)
		got, err := AcceptInvitation(t.Context(), d, admin, value.ID, token, clock)
		if err != nil {
			t.Fatal(err)
		}
		contractEqual(t, got, InvitationAcceptance{ProjectID: value.ID, DirectGrant: *wantAccess.DirectGrant, Access: wantAccess})
		contractEqual(t, d.calls, []string{"lockInvitation", "member", "access:" + admin.UserID})
	})
	t.Run("expired or revoked", func(t *testing.T) {
		d := newDAO(t, member)
		expired, revoked, consumed := cloneProjectInvitation(invite), cloneProjectInvitation(invite), cloneProjectInvitation(invite)
		expired.ExpiresAt = now
		revoked.RevokedAt = &now
		consumed.ConsumedAt = &now
		consumed.ConsumedBy = &member.UserID
		for _, unavailable := range []model.ProjectInvitation{expired, revoked, consumed} {
			d.invitation = unavailable
			d.expectInvitationCalls("lockInvitation")
			got, err := AcceptInvitation(t.Context(), d, member, value.ID, token, clock)
			membershipFault(t, err, "invitation_unavailable")
			contractEqual(t, got, InvitationAcceptance{})
			contractEqual(t, d.calls, []string{"lockInvitation"})
		}
	})
	t.Run("missing invite", func(t *testing.T) {
		d := newDAO(t, member)
		d.expectInvitationCalls("lockInvitation")
		d.failures = map[string]error{"lockInvitation": model.ErrNotFound}
		_, err := AcceptInvitation(t.Context(), d, member, value.ID, token, clock)
		membershipFault(t, err, "invitation_unavailable")
	})
	for _, step := range []string{"lockInvitation", "member", "add", "consume", "access:" + member.UserID} {
		t.Run("failure "+step, func(t *testing.T) {
			d := newDAO(t, member)
			plan := []string{"lockInvitation", "member"}
			if step == "add" || step == "consume" {
				plan = append(plan, "add", "consume")
			}
			if strings.HasPrefix(step, "access:") {
				plan = append(plan, step)
			}
			for i, op := range plan {
				if op == step {
					plan = plan[:i+1]
					break
				}
			}
			d.expectInvitationCalls(plan...)
			d.failures = map[string]error{step: membershipErr}
			if step == "add" || step == "consume" {
				d.failures["member"] = model.ErrNotFound
			}
			_, err := AcceptInvitation(t.Context(), d, member, value.ID, token, clock)
			if !errors.Is(err, membershipErr) {
				t.Fatalf("lost %s failure: %v", step, err)
			}
		})
	}
}
