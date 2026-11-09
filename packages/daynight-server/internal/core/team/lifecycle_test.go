package team

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

var fail = errors.New("dao failure")

func principal() model.Principal {
	return model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
}
func namedTeam(p model.Principal) model.Team {
	name := "Acme"
	return model.Team{ID: uuid.NewString(), Name: &name, Kind: "ordinary", Version: 1, CreatedAt: time.Now().UTC(), Membership: model.TeamMember{UserID: p.UserID, Role: model.ProjectAdmin, Version: 1}}
}
func faultCode(t *testing.T, err error, want string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != want {
		t.Fatalf("want %s, got %v", want, err)
	}
}

type creationFake struct {
	name, id string
	err      error
}

func (f *creationFake) InsertTeam(_ context.Context, id, name string) (model.Team, error) {
	f.id, f.name = id, name
	return model.Team{ID: id, Name: &name}, f.err
}

type readerFake struct {
	store.TeamReader
	team            model.Team
	teamErr         error
	page            store.TeamPage
	pageErr         error
	members         []model.TeamMemberProfile
	memberErr       error
	invitation      model.TeamInvitation
	invitationErr   error
	ref             model.TeamRef
	refErr          error
	member          model.TeamMember
	inviteMemberErr error
	listErr         error
}

func (f *readerFake) Team(context.Context, string, string) (model.Team, error) {
	return f.team, f.teamErr
}
func (f *readerFake) Teams(context.Context, string, store.Page) (store.TeamPage, error) {
	return f.page, f.pageErr
}
func (f *readerFake) TeamMembers(context.Context, string) ([]model.TeamMemberProfile, error) {
	return f.members, f.memberErr
}
func (f *readerFake) TeamInvitation(context.Context, []byte) (model.TeamInvitation, error) {
	return f.invitation, f.invitationErr
}
func (f *readerFake) TeamInvitations(context.Context, string, time.Time) ([]model.TeamInvitation, error) {
	return []model.TeamInvitation{f.invitation}, f.listErr
}
func (f *readerFake) InvitationTeam(context.Context, string) (model.TeamRef, error) {
	return f.ref, f.refErr
}
func (f *readerFake) InvitationTeamMember(context.Context, string, string) (model.TeamMember, error) {
	return f.member, f.inviteMemberErr
}

type writerFake struct {
	store.TeamWriteDAO
	team                                        model.Team
	member                                      model.TeamMember
	invitation                                  model.TeamInvitation
	ref                                         model.TeamRef
	errs                                        map[string]error
	count                                       int64
	occupied, deleted, removed, consumed, added bool
	changedRole                                 model.ProjectRole
	revoke                                      bool
}

func (f *writerFake) Team(context.Context, string) (model.Team, error) { return f.team, f.errs["team"] }
func (f *writerFake) Rename(_ context.Context, _ string, name string) (model.Team, error) {
	v := f.team
	v.Name = &name
	v.Version++
	return v, f.errs["rename"]
}
func (f *writerFake) HasProjects(context.Context) (bool, error) {
	return f.occupied, f.errs["projects"]
}
func (f *writerFake) Delete(context.Context) error { f.deleted = true; return f.errs["delete"] }
func (f *writerFake) Member(context.Context, string) (model.TeamMember, error) {
	return f.member, f.errs["member"]
}
func (f *writerFake) AdminCount(context.Context) (int64, error) { return f.count, f.errs["count"] }
func (f *writerFake) SetMemberRole(_ context.Context, _ string, role model.ProjectRole) (model.TeamMember, error) {
	f.changedRole = role
	v := f.member
	v.Role = role
	v.Version++
	return v, f.errs["role"]
}
func (f *writerFake) RemoveMember(context.Context, string) error {
	f.removed = true
	return f.errs["remove"]
}
func (f *writerFake) LockInvitation(context.Context, []byte) (model.TeamInvitation, error) {
	return f.invitation, f.errs["lock"]
}
func (f *writerFake) CreateInvitation(_ context.Context, i model.TeamInvitation) error {
	f.invitation = i
	return f.errs["createInvite"]
}
func (f *writerFake) RevokeInvitation(context.Context, string, time.Time) (bool, error) {
	return f.revoke, f.errs["revoke"]
}
func (f *writerFake) InvitationTeam(context.Context) (model.TeamRef, error) {
	return f.ref, f.errs["ref"]
}
func (f *writerFake) InvitationMember(context.Context, string) (model.TeamMember, error) {
	return f.member, f.errs["inviteMember"]
}
func (f *writerFake) AddInvitedMember(context.Context, string) (model.TeamMember, error) {
	f.added = true
	return f.member, f.errs["add"]
}
func (f *writerFake) ConsumeInvitation(context.Context, string, string, time.Time) error {
	f.consumed = true
	return f.errs["consume"]
}

func TestValidationContracts(t *testing.T) {
	p := principal()
	id := uuid.NewString()
	other := principal()
	for _, name := range []string{"", " ", "x\x00", string([]byte{0xff})} {
		faultCode(t, ValidateName(name), "invalid_input")
	}
	if err := ValidateName("  名😀 "); err != nil {
		t.Fatal(err)
	}
	faultCode(t, RequireActor(model.Principal{}, p.UserID), "unauthenticated")
	faultCode(t, RequireActor(p, "bad"), "invalid_input")
	faultCode(t, RequireActor(p, other.UserID), "identity_mismatch")
	if err := RequireActor(p, p.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := CanonicalID(strings.ToUpper(id)); err == nil {
		t.Fatal("noncanonical Team ID accepted")
	}
	if got, err := CanonicalID(id); err != nil || got != id {
		t.Fatal(got, err)
	}
	faultCode(t, ValidateCreate(p, CreateTeam{Name: "ok", ExpectedUserID: other.UserID}), "identity_mismatch")
	faultCode(t, ValidateCreate(p, CreateTeam{Name: "", ExpectedUserID: p.UserID}), "invalid_input")
	if err := ValidateCreate(p, CreateTeam{Name: "ok", ExpectedUserID: p.UserID}); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateRead(model.Principal{}, id); err == nil {
		t.Fatal("anonymous read")
	}
	if _, err := ValidateRead(p, id); err != nil {
		t.Fatal(err)
	}
	input := ChangeTeam{Name: "Acme", Version: 1, ExpectedUserID: p.UserID}
	for _, tc := range []struct {
		id string
		in ChangeTeam
	}{{id, ChangeTeam{Name: "Acme", Version: 1, ExpectedUserID: other.UserID}}, {"bad", input}, {id, ChangeTeam{Name: "Acme", Version: 0, ExpectedUserID: p.UserID}}, {id, ChangeTeam{Name: "", Version: 1, ExpectedUserID: p.UserID}}} {
		if _, err := ValidateChange(p, tc.id, tc.in); err == nil {
			t.Fatal(tc)
		}
	}
	if _, err := ValidateChange(p, id, input); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		id, user string
		in       ChangeTeamMember
		remove   bool
	}{{id, id, ChangeTeamMember{Version: 1, ExpectedUserID: other.UserID}, true}, {"bad", id, ChangeTeamMember{Version: 1, ExpectedUserID: p.UserID}, true}, {id, "bad", ChangeTeamMember{Version: 1, ExpectedUserID: p.UserID}, true}, {id, id, ChangeTeamMember{ExpectedUserID: p.UserID}, true}, {id, id, ChangeTeamMember{Version: 1, ExpectedUserID: p.UserID}, false}} {
		if _, _, err := ValidateMemberChange(p, tc.id, tc.user, tc.in, tc.remove); err == nil {
			t.Fatal(tc)
		}
	}
	if _, _, err := ValidateMemberChange(p, id, id, ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: p.UserID}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateInvitationWrite(p, "bad", p.UserID); err == nil {
		t.Fatal("bad id")
	}
	if _, err := ValidateInvitationWrite(p, id, other.UserID); err == nil {
		t.Fatal("mismatch")
	}
	if _, _, err := ValidateInvitationRevoke(p, id, "bad", p.UserID); err == nil {
		t.Fatal("bad invitation")
	}
	if _, _, err := ValidateInvitationRevoke(p, "bad", id, p.UserID); err == nil {
		t.Fatal("bad team")
	}
	if _, _, err := ValidateInvitationRevoke(p, id, id, p.UserID); err != nil {
		t.Fatal(err)
	}
}

func TestNameAdmissionBoundaries(t *testing.T) {
	for _, name := range []string{strings.Repeat("a", 256), strings.Repeat("😀", 256)} {
		if err := ValidateName(name); err != nil {
			t.Fatalf("valid name rejected: %v", err)
		}
	}
	for _, name := range []string{strings.Repeat("a", 257), strings.Repeat("😀", 256) + "a"} {
		faultCode(t, ValidateName(name), "invalid_input")
		_, err := Create(context.Background(), nil, CreateTeam{Name: name})
		faultCode(t, err, "invalid_input")
	}
}
func TestTeamLifecycleDAO(t *testing.T) {
	ctx := context.Background()
	p := principal()
	item := namedTeam(p)
	f := &creationFake{}
	created, err := Create(ctx, f, CreateTeam{Name: "Acme"})
	if err != nil || created.ID != f.id || f.name != "Acme" {
		t.Fatal(created, err)
	}
	f.err = fail
	if _, err = Create(ctx, f, CreateTeam{}); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	r := &readerFake{team: item, page: store.TeamPage{Items: []model.Team{item}, HasMore: true}}
	got, err := Get(ctx, r, p, item.ID)
	if err != nil || got.ID != item.ID {
		t.Fatal(got, err)
	}
	r.teamErr = model.ErrNotFound
	_, err = Get(ctx, r, p, item.ID)
	faultCode(t, err, "not_found")
	if _, err = Members(ctx, r, p, item.ID); err == nil {
		t.Fatal("missing team")
	}
	r.teamErr = nil
	r.members = []model.TeamMemberProfile{{Membership: item.Membership}}
	members, err := Members(ctx, r, p, item.ID)
	if err != nil || len(members) != 1 {
		t.Fatal(members, err)
	}
	page, err := List(ctx, r, p, model.PageRequest{Limit: 1})
	if err != nil || page.NextCursor == nil || len(page.Items) != 1 {
		t.Fatal(page, err)
	}
	if _, err = List(ctx, r, model.Principal{}, model.PageRequest{}); err == nil {
		t.Fatal("anonymous list")
	}
	if _, err = List(ctx, r, p, model.PageRequest{Limit: -1}); err == nil {
		t.Fatal("invalid page")
	}
	r.pageErr = fail
	if _, err = List(ctx, r, p, model.PageRequest{Limit: 1}); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	w := &writerFake{team: item, errs: map[string]error{}}
	input := ChangeTeam{Name: *item.Name, Version: 1, ExpectedUserID: p.UserID}
	same, err := Rename(ctx, w, p, input)
	if err != nil || same.Version != 1 {
		t.Fatal(same, err)
	}
	input.Name = "New"
	renamed, err := Rename(ctx, w, p, input)
	if err != nil || *renamed.Name != "New" {
		t.Fatal(renamed, err)
	}
	w.team.Version = math.MaxInt64
	input.Version = math.MaxInt64
	_, err = Rename(ctx, w, p, input)
	faultCode(t, err, "version_exhausted")
	w.team = item
	input.Version = 1
	w.errs["team"] = fail
	if _, err = Rename(ctx, w, p, input); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "team")
	w.team.Membership.Role = model.ProjectMemberRole
	_, err = Rename(ctx, w, p, input)
	faultCode(t, err, "forbidden")
	w.team = item
	w.team.Kind = "personal"
	_, err = Rename(ctx, w, p, input)
	faultCode(t, err, "personal_team_immutable")
	w.team = item
	input.Version = 2
	_, err = Rename(ctx, w, p, input)
	faultCode(t, err, "version_conflict")
	input.Version = 1
	faultCode(t, Delete(ctx, w, p, input), "version_conflict")
	input.Name = "Acme"
	w.errs["projects"] = fail
	if err = Delete(ctx, w, p, input); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "projects")
	w.occupied = true
	faultCode(t, Delete(ctx, w, p, input), "team_not_empty")
	w.occupied = false
	if err = Delete(ctx, w, p, input); err != nil || !w.deleted {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		tx   *store.TransactionError
		code string
	}{{&store.TransactionError{CleanupFailed: true}, "internal_error"}, {&store.TransactionError{CommitAttempted: true, Outcome: store.TransactionUnknown}, "write_outcome_unknown"}, {&store.TransactionError{Phase: "commit", Outcome: store.TransactionNotCommitted}, "internal_error"}, {&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}, "not_found"}} {
		f, ok := WriteFault(tc.tx)
		if !ok || f.Code != tc.code {
			t.Fatal(f, ok)
		}
	}
	if _, ok := WriteFault(fail); ok {
		t.Fatal("unexpected classification")
	}
	if _, ok := WriteFault(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fail}); ok {
		t.Fatal("unexpected classification")
	}
}

func TestMemberAuthorizationAndMutation(t *testing.T) {
	ctx := context.Background()
	p := principal()
	target := uuid.NewString()
	item := namedTeam(p)
	member := model.TeamMember{UserID: target, Role: model.ProjectAdmin, Version: 2}
	in := ChangeTeamMember{Version: 2, Role: model.ProjectMemberRole, ExpectedUserID: p.UserID}
	w := &writerFake{team: item, member: member, count: 2, errs: map[string]error{}}
	w.errs["team"] = fail
	if _, err := ChangeMember(ctx, w, p, target, in, false); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "team")
	w.team.Kind = "personal"
	_, err := ChangeMember(ctx, w, p, target, in, false)
	faultCode(t, err, "personal_team_immutable")
	w.team = item
	w.team.Membership.Role = model.ProjectMemberRole
	_, err = ChangeMember(ctx, w, p, target, in, false)
	faultCode(t, err, "forbidden")
	w.team = item
	w.errs["member"] = model.ErrNotFound
	_, err = ChangeMember(ctx, w, p, target, in, false)
	faultCode(t, err, "not_found")
	w.errs["member"] = fail
	if _, err = ChangeMember(ctx, w, p, target, in, false); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "member")
	in.Version = 3
	_, err = ChangeMember(ctx, w, p, target, in, false)
	faultCode(t, err, "version_conflict")
	in.Version = 2
	w.errs["count"] = fail
	if _, err = ChangeMember(ctx, w, p, target, in, false); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "count")
	w.count = 1
	_, err = ChangeMember(ctx, w, p, target, in, false)
	faultCode(t, err, "last_admin")
	w.count = 2
	w.errs["role"] = fail
	if _, err = ChangeMember(ctx, w, p, target, in, false); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "role")
	result, err := ChangeMember(ctx, w, p, target, in, false)
	if err != nil || result.Membership.Role != model.ProjectMemberRole || *result.ActorRole != model.ProjectAdmin {
		t.Fatal(result, err)
	}
	in.Role = model.ProjectAdmin
	w.changedRole = ""
	result, err = ChangeMember(ctx, w, p, target, in, false)
	if err != nil || w.changedRole != "" || result.Membership.Version != 2 {
		t.Fatal(result, err)
	}
	w.errs["remove"] = fail
	if _, err = ChangeMember(ctx, w, p, target, in, true); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "remove")
	result, err = ChangeMember(ctx, w, p, target, in, true)
	if err != nil || !w.removed || result.ActorRole == nil {
		t.Fatal(result, err)
	}
	w.team.Membership.Role = model.ProjectMemberRole
	w.member.Role = model.ProjectMemberRole
	result, err = ChangeMember(ctx, w, p, p.UserID, in, true)
	if err != nil || result.ActorRole != nil {
		t.Fatal(result, err)
	}
	w.team = item
	w.member = member
	in.Role = model.ProjectMemberRole
	result, err = ChangeMember(ctx, w, p, p.UserID, in, false)
	if err != nil || *result.ActorRole != model.ProjectMemberRole {
		t.Fatal(result, err)
	}
}

func TestInvitationRules(t *testing.T) {
	ctx := context.Background()
	p := principal()
	item := namedTeam(p)
	now := time.Now().UTC()
	clock := func() time.Time { return now }
	w := &writerFake{team: item, errs: map[string]error{}, revoke: true}
	r := &readerFake{team: item}
	id := uuid.NewString()
	faultCode(t, ValidateInvitation(model.Principal{}, "bad"), "unauthenticated")
	faultCode(t, ValidateInvitation(p, "bad"), "invitation_unavailable")
	w.errs["team"] = fail
	if _, err := CreateInvitation(ctx, w, p, item.ID, clock); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	if _, err := RevokeInvitation(ctx, w, p, id, clock); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "team")
	w.team.Membership.Role = model.ProjectMemberRole
	_, err := CreateInvitation(ctx, w, p, item.ID, clock)
	faultCode(t, err, "forbidden")
	w.team = item
	w.team.Kind = "personal"
	_, err = CreateInvitation(ctx, w, p, item.ID, clock)
	faultCode(t, err, "personal_team_immutable")
	w.team = item
	w.errs["createInvite"] = fail
	if _, err = CreateInvitation(ctx, w, p, item.ID, clock); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "createInvite")
	minted, err := CreateInvitation(ctx, w, p, item.ID, clock)
	if err != nil || minted.Invitation.TokenHash != nil || len(w.invitation.TokenHash) == 0 || !minted.Invitation.ExpiresAt.Equal(now.Add(invitationLifetime)) {
		t.Fatal(minted, err)
	}
	if err := ValidateInvitation(p, minted.Secret); err != nil {
		t.Fatal(err)
	}
	changed, err := RevokeInvitation(ctx, w, p, id, clock)
	if err != nil || !changed {
		t.Fatal(changed, err)
	}
	w.team.Kind = "personal"
	_, err = RevokeInvitation(ctx, w, p, id, clock)
	faultCode(t, err, "personal_team_immutable")
	w.team = item
	r.teamErr = fail
	if _, err = ListInvitations(ctx, r, p, item.ID, clock); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	r.teamErr = nil
	r.team.Kind = "personal"
	_, err = ListInvitations(ctx, r, p, item.ID, clock)
	faultCode(t, err, "personal_team_immutable")
	r.team = item
	r.invitation = w.invitation
	list, err := ListInvitations(ctx, r, p, item.ID, clock)
	if err != nil || len(list) != 1 {
		t.Fatal(list, err)
	}
	r.invitationErr = model.ErrNotFound
	_, err = Invitation(ctx, r, minted.Secret, clock)
	faultCode(t, err, "invitation_unavailable")
	r.invitationErr = fail
	if _, err = Invitation(ctx, r, minted.Secret, clock); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	r.invitationErr = nil
	r.invitation.ExpiresAt = now
	_, err = Invitation(ctx, r, minted.Secret, clock)
	faultCode(t, err, "invitation_unavailable")
	r.invitation = w.invitation
	if _, err = Invitation(ctx, r, minted.Secret, clock); err != nil {
		t.Fatal(err)
	}
	r.refErr = model.ErrNotFound
	_, err = InspectInvitation(ctx, r, p, r.invitation)
	faultCode(t, err, "invitation_unavailable")
	r.refErr = fail
	if _, err = InspectInvitation(ctx, r, p, r.invitation); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	r.refErr = nil
	r.ref = model.TeamRef{Kind: "personal"}
	_, err = InspectInvitation(ctx, r, p, r.invitation)
	faultCode(t, err, "invitation_unavailable")
	r.ref = model.TeamRef{ID: item.ID, Kind: "ordinary", Name: item.Name}
	r.inviteMemberErr = model.ErrNotFound
	preview, err := InspectInvitation(ctx, r, p, r.invitation)
	if err != nil || preview.Membership != nil {
		t.Fatal(preview, err)
	}
	r.inviteMemberErr = fail
	if _, err = InspectInvitation(ctx, r, p, r.invitation); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	r.inviteMemberErr = nil
	r.member = item.Membership
	preview, err = InspectInvitation(ctx, r, p, r.invitation)
	if err != nil || preview.Membership == nil {
		t.Fatal(preview, err)
	}
}

func TestInvitationAcceptanceRechecksAndFailures(t *testing.T) {
	ctx := context.Background()
	p := principal()
	item := namedTeam(p)
	now := time.Now().UTC()
	clock := func() time.Time { return now }
	w := &writerFake{invitation: model.TeamInvitation{ID: uuid.NewString(), ExpiresAt: now.Add(time.Hour)}, ref: model.TeamRef{ID: item.ID, Kind: "ordinary", Name: item.Name}, member: model.TeamMember{UserID: p.UserID, Role: model.ProjectMemberRole}, errs: map[string]error{}}
	w.errs["lock"] = model.ErrNotFound
	_, err := AcceptInvitation(ctx, w, p, "token", clock)
	faultCode(t, err, "invitation_unavailable")
	w.errs["lock"] = fail
	if _, err = AcceptInvitation(ctx, w, p, "token", clock); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "lock")
	w.invitation.ExpiresAt = now
	_, err = AcceptInvitation(ctx, w, p, "token", clock)
	faultCode(t, err, "invitation_unavailable")
	w.invitation.ExpiresAt = now.Add(time.Hour)
	w.errs["ref"] = fail
	if _, err = AcceptInvitation(ctx, w, p, "token", clock); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "ref")
	w.ref.Kind = "personal"
	_, err = AcceptInvitation(ctx, w, p, "token", clock)
	faultCode(t, err, "invitation_unavailable")
	w.ref.Kind = "ordinary"
	w.errs["inviteMember"] = fail
	if _, err = AcceptInvitation(ctx, w, p, "token", clock); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "inviteMember")
	result, err := AcceptInvitation(ctx, w, p, "token", clock)
	if err != nil || result.Joined || result.Consumed || w.added {
		t.Fatal(result, err)
	}
	w.errs["inviteMember"] = model.ErrNotFound
	w.errs["add"] = fail
	if _, err = AcceptInvitation(ctx, w, p, "token", clock); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "add")
	w.errs["consume"] = fail
	if _, err = AcceptInvitation(ctx, w, p, "token", clock); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "consume")
	result, err = AcceptInvitation(ctx, w, p, "token", clock)
	if err != nil || !result.Joined || !result.Consumed || !w.consumed {
		t.Fatal(result, err)
	}
}

func TestCreateReportsEntropyFailure(t *testing.T) {
	// This package's tests do not run in parallel while the UUID reader is replaced.
	uuid.SetRand(strings.NewReader(""))
	defer uuid.SetRand(nil)
	dao := &creationFake{}
	if _, err := Create(context.Background(), dao, CreateTeam{Name: "example"}); err == nil || !strings.Contains(err.Error(), "generate Team ID") || dao.id != "" {
		t.Fatalf("creation failed incorrectly: %v, id %q", err, dao.id)
	}
}

func TestListInvalidTimestampAndDeleteReadFailure(t *testing.T) {
	p := principal()
	item := namedTeam(p)
	item.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	r := &readerFake{page: store.TeamPage{Items: []model.Team{item}, HasMore: true}}
	if _, err := List(context.Background(), r, p, model.PageRequest{Limit: 1}); err == nil || !strings.Contains(err.Error(), "encode Team cursor") {
		t.Fatalf("invalid timestamp: %v", err)
	}
	w := &writerFake{team: item, errs: map[string]error{"team": fail}}
	if err := Delete(context.Background(), w, p, ChangeTeam{Name: "Acme", Version: 1, ExpectedUserID: p.UserID}); !errors.Is(err, fail) || w.deleted {
		t.Fatalf("delete read failure: %v", err)
	}
}
