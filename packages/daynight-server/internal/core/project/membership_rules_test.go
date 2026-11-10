package project

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
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
	failures     map[string]error
	calls        []string
	member       model.ProjectMember
	grant        model.ProjectGrant
	access       model.ProjectAccess
	invitation   model.ProjectInvitation
	project      model.Project
	participants []model.ProjectParticipant
}

func (d *membershipDAO) fail(op string) error { d.calls = append(d.calls, op); return d.failures[op] }
func (d *membershipDAO) ProjectParticipants(_ context.Context, _ string) ([]model.ProjectParticipant, error) {
	return d.participants, d.fail("participants")
}
func (d *membershipDAO) DirectProjectMember(_ context.Context, _ string) (model.ProjectMember, error) {
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
func (d *membershipDAO) ProjectAccess(_ context.Context, p model.Principal) (model.ProjectAccess, error) {
	return d.access, d.fail("access:" + p.UserID)
}
func (d *membershipDAO) AddInvitedMember(_ context.Context, _ string) (model.ProjectMember, error) {
	return d.member, d.fail("add")
}
func (d *membershipDAO) LockInvitation(_ context.Context, _ []byte) (model.ProjectInvitation, error) {
	return d.invitation, d.fail("lockInvitation")
}
func (d *membershipDAO) CreateInvitation(_ context.Context, i model.ProjectInvitation) error {
	d.invitation = i
	return d.fail("createInvitation")
}
func (d *membershipDAO) RevokeInvitation(_ context.Context, _ string, _ time.Time) error {
	return d.fail("revoke")
}
func (d *membershipDAO) ConsumeInvitation(_ context.Context, _, _ string, _ time.Time) error {
	return d.fail("consume")
}

type membershipReader struct {
	store.ProjectReader
	d *membershipDAO
}

func (d membershipReader) Project(_ context.Context, _ string) (model.Project, error) {
	return d.d.project, d.d.fail("project")
}
func (d membershipReader) ProjectAccess(_ context.Context, _ model.Principal, _ string) (model.ProjectAccess, error) {
	return d.d.access, d.d.fail("readAccess")
}
func (d membershipReader) Invitation(_ context.Context, _ []byte) (model.ProjectInvitation, error) {
	return d.d.invitation, d.d.fail("invitation")
}
func (d membershipReader) Invitations(_ context.Context, _ string, _ time.Time) ([]model.ProjectInvitation, error) {
	return []model.ProjectInvitation{d.d.invitation}, d.d.fail("invitations")
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
	ctx := context.Background()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	secret := secretutil.Random(invitationPrefix)
	if err := ValidateInvitation(memberPrincipal, secret); err != nil {
		t.Fatal(err)
	}
	membershipFault(t, ValidateInvitation(model.Principal{}, secret), "unauthenticated")
	membershipFault(t, ValidateInvitation(memberPrincipal, "invalid"), "invitation_unavailable")
	d := &membershipDAO{}
	minted, err := CreateInvitation(ctx, d, memberPrincipal, "p", clock)
	if err != nil || !bytes.Equal(d.invitation.TokenHash, secretutil.Hash(minted.Secret)) || minted.Invitation.TokenHash != nil || !minted.Invitation.ExpiresAt.Equal(now.Add(InvitationLifetime)) {
		t.Fatalf("minted %+v stored %+v error %v", minted, d.invitation, err)
	}
	d.failures = map[string]error{"createInvitation": membershipErr}
	if _, err = CreateInvitation(ctx, d, memberPrincipal, "p", clock); !errors.Is(err, membershipErr) {
		t.Fatal(err)
	}
	d.failures = nil
	d.invitation = model.ProjectInvitation{ID: "invite", ProjectID: "p", ExpiresAt: now.Add(time.Hour)}
	reader := membershipReader{d: d}
	if _, err = Invitation(ctx, reader, secret, clock); err != nil {
		t.Fatal(err)
	}
	if invitations, err := ListInvitations(ctx, reader, "p", clock); err != nil || len(invitations) != 1 {
		t.Fatalf("invitations %v %v", invitations, err)
	}
	if err := RevokeInvitation(ctx, d, "invite", clock); err != nil {
		t.Fatal(err)
	}
	d.invitation.ExpiresAt = now
	_, err = Invitation(ctx, reader, secret, clock)
	membershipFault(t, err, "invitation_unavailable")
	d.failures = map[string]error{"invitation": model.ErrNotFound}
	_, err = Invitation(ctx, reader, secret, clock)
	membershipFault(t, err, "invitation_unavailable")
	d.failures["invitation"] = membershipErr
	_, err = Invitation(ctx, reader, secret, clock)
	if !errors.Is(err, membershipErr) {
		t.Fatal(err)
	}
	d.failures = nil
	d.project = model.Project{ID: "p", Name: "Project"}
	d.access = model.ProjectAccess{DirectGrant: &model.ProjectGrant{Version: 1}}
	i := model.ProjectInvitation{ProjectID: "p"}
	inspected, err := InspectInvitation(ctx, reader, memberPrincipal, i)
	if err != nil || inspected.ProjectName != "Project" || inspected.DirectGrant == nil || inspected.Access == nil {
		t.Fatalf("inspection %+v %v", inspected, err)
	}
	d.failures = map[string]error{"readAccess": model.ErrNotFound}
	inspected, err = InspectInvitation(ctx, reader, memberPrincipal, i)
	if err != nil || inspected.Access != nil {
		t.Fatalf("outsider %+v %v", inspected, err)
	}
	d.failures["readAccess"] = membershipErr
	_, err = InspectInvitation(ctx, reader, memberPrincipal, i)
	if !errors.Is(err, membershipErr) {
		t.Fatal(err)
	}
	d.failures = map[string]error{"project": model.ErrNotFound}
	_, err = InspectInvitation(ctx, reader, memberPrincipal, i)
	membershipFault(t, err, "invitation_unavailable")
	d.failures["project"] = membershipErr
	_, err = InspectInvitation(ctx, reader, memberPrincipal, i)
	if !errors.Is(err, membershipErr) {
		t.Fatal(err)
	}
}

func TestInvitationAcceptanceRechecksAndFailures(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	secret := secretutil.Random(invitationPrefix)
	invite := model.ProjectInvitation{ID: "invite", ProjectID: "p", ExpiresAt: now.Add(time.Hour)}
	grant := model.ProjectGrant{Version: 1}
	t.Run("new member consumes", func(t *testing.T) {
		d := &membershipDAO{invitation: invite, member: model.ProjectMember{Grant: grant}, failures: map[string]error{"member": model.ErrNotFound}}
		r, err := AcceptInvitation(ctx, d, memberPrincipal, "p", secret, clock)
		if err != nil || !r.Joined || !r.Consumed || r.DirectGrant != grant {
			t.Fatalf("result %+v %v", r, err)
		}
	})
	t.Run("existing member leaves invite unused", func(t *testing.T) {
		d := &membershipDAO{invitation: invite, member: model.ProjectMember{Grant: grant}}
		r, err := AcceptInvitation(ctx, d, memberPrincipal, "p", secret, clock)
		if err != nil || r.Joined || r.Consumed {
			t.Fatalf("result %+v %v", r, err)
		}
	})
	t.Run("expired or revoked", func(t *testing.T) {
		d := &membershipDAO{invitation: invite}
		d.invitation.ExpiresAt = now
		_, err := AcceptInvitation(ctx, d, memberPrincipal, "p", secret, clock)
		membershipFault(t, err, "invitation_unavailable")
		d.invitation = invite
		d.invitation.RevokedAt = &now
		_, err = AcceptInvitation(ctx, d, memberPrincipal, "p", secret, clock)
		membershipFault(t, err, "invitation_unavailable")
	})
	t.Run("missing invite", func(t *testing.T) {
		d := &membershipDAO{failures: map[string]error{"lockInvitation": model.ErrNotFound}}
		_, err := AcceptInvitation(ctx, d, memberPrincipal, "p", secret, clock)
		membershipFault(t, err, "invitation_unavailable")
	})
	for _, step := range []string{"lockInvitation", "member", "add", "consume", "access:" + memberUser} {
		t.Run("failure "+step, func(t *testing.T) {
			d := &membershipDAO{invitation: invite, failures: map[string]error{step: membershipErr}}
			if step == "add" || step == "consume" {
				d.failures["member"] = model.ErrNotFound
			}
			_, err := AcceptInvitation(ctx, d, memberPrincipal, "p", secret, clock)
			if !errors.Is(err, membershipErr) {
				t.Fatalf("lost %s failure: %v", step, err)
			}
		})
	}
}
