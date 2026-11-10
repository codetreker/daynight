package team

import (
	"bytes"
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

var fail = errors.New("dao failure")

func principal() model.Principal {
	return model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
}
func namedTeam(p model.Principal) model.Team {
	name := "Acme"
	id := uuid.NewString()
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return model.Team{
		TeamRef: model.TeamRef{ID: id, Name: &name, Kind: "ordinary"},
		Version: 1, CreatedAt: now, UpdatedAt: now.Add(time.Second),
		Membership: model.TeamMember{TeamID: id, UserID: p.UserID, Role: model.ProjectAdmin, Version: 1, CreatedAt: now, UpdatedAt: now.Add(time.Second)},
	}
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
	renameResult                                model.Team
	renameContext                               context.Context
	renameActor, renameName                     string
	renameCalls                                 int
	member                                      model.TeamMember
	roleResult, invitedMember                   model.TeamMember
	memberContext, roleContext, removeContext   context.Context
	memberID, changedMemberID, removedMemberID  string
	roleCalls                                   int
	invitation                                  model.TeamInvitation
	ref                                         model.TeamRef
	errs                                        map[string]error
	count                                       int64
	occupied, deleted, removed, consumed, added bool
	changedRole                                 model.ProjectRole
	revoke                                      bool
	acceptCalls                                 []string
	acceptContexts                              []context.Context
	lockedHash                                  []byte
	invitationMemberID, addedMemberID           string
	consumedInvitationID, consumedMemberID      string
	consumedAt                                  time.Time
}

func (f *writerFake) Team(context.Context, string) (model.Team, error) { return f.team, f.errs["team"] }
func (f *writerFake) Rename(ctx context.Context, actor, name string) (model.Team, error) {
	f.renameContext, f.renameActor, f.renameName = ctx, actor, name
	f.renameCalls++
	return f.renameResult, f.errs["rename"]
}
func (f *writerFake) HasProjects(context.Context) (bool, error) {
	return f.occupied, f.errs["projects"]
}
func (f *writerFake) Delete(context.Context) error { f.deleted = true; return f.errs["delete"] }
func (f *writerFake) Member(ctx context.Context, user string) (model.TeamMember, error) {
	f.memberContext, f.memberID = ctx, user
	return f.member, f.errs["member"]
}
func (f *writerFake) AdminCount(context.Context) (int64, error) { return f.count, f.errs["count"] }
func (f *writerFake) SetMemberRole(ctx context.Context, user string, role model.ProjectRole) (model.TeamMember, error) {
	f.roleContext, f.changedMemberID, f.changedRole = ctx, user, role
	f.roleCalls++
	return f.roleResult, f.errs["role"]
}
func (f *writerFake) RemoveMember(ctx context.Context, user string) error {
	f.removeContext, f.removedMemberID = ctx, user
	f.removed = true
	return f.errs["remove"]
}
func (f *writerFake) LockInvitation(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
	f.acceptCalls = append(f.acceptCalls, "lock")
	f.acceptContexts = append(f.acceptContexts, ctx)
	f.lockedHash = append([]byte(nil), hash...)
	return f.invitation, f.errs["lock"]
}
func (f *writerFake) CreateInvitation(_ context.Context, i model.TeamInvitation) error {
	f.invitation = i
	return f.errs["createInvite"]
}
func (f *writerFake) RevokeInvitation(context.Context, string, time.Time) (bool, error) {
	return f.revoke, f.errs["revoke"]
}
func (f *writerFake) InvitationTeam(ctx context.Context) (model.TeamRef, error) {
	f.acceptCalls = append(f.acceptCalls, "ref")
	f.acceptContexts = append(f.acceptContexts, ctx)
	return f.ref, f.errs["ref"]
}
func (f *writerFake) InvitationMember(ctx context.Context, user string) (model.TeamMember, error) {
	f.acceptCalls = append(f.acceptCalls, "member")
	f.acceptContexts = append(f.acceptContexts, ctx)
	f.invitationMemberID = user
	return f.member, f.errs["inviteMember"]
}
func (f *writerFake) AddInvitedMember(ctx context.Context, user string) (model.TeamMember, error) {
	f.acceptCalls = append(f.acceptCalls, "add")
	f.acceptContexts = append(f.acceptContexts, ctx)
	f.addedMemberID = user
	f.added = true
	return f.invitedMember, f.errs["add"]
}
func (f *writerFake) ConsumeInvitation(ctx context.Context, id, user string, now time.Time) error {
	f.acceptCalls = append(f.acceptCalls, "consume")
	f.acceptContexts = append(f.acceptContexts, ctx)
	f.consumedInvitationID, f.consumedMemberID, f.consumedAt = id, user, now
	f.consumed = true
	return f.errs["consume"]
}

type ruleReadDAO struct {
	store.TeamWriteDAO
	team             func(context.Context, string) (model.Team, error)
	member           func(context.Context, string) (model.TeamMember, error)
	adminCount       func(context.Context) (int64, error)
	lockInvitation   func(context.Context, []byte) (model.TeamInvitation, error)
	revokeInvitation func(context.Context, string, time.Time) (bool, error)
}

func (d *ruleReadDAO) Team(ctx context.Context, actor string) (model.Team, error) {
	return d.team(ctx, actor)
}
func (d *ruleReadDAO) Member(ctx context.Context, target string) (model.TeamMember, error) {
	return d.member(ctx, target)
}
func (d *ruleReadDAO) AdminCount(ctx context.Context) (int64, error) {
	return d.adminCount(ctx)
}
func (d *ruleReadDAO) LockInvitation(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
	return d.lockInvitation(ctx, hash)
}

type memberRefusalDAO struct {
	*ruleReadDAO
	t *testing.T
}

func (d *memberRefusalDAO) SetMemberRole(context.Context, string, model.ProjectRole) (model.TeamMember, error) {
	d.t.Helper()
	d.t.Fatal("unexpected SetMemberRole after membership refusal")
	return model.TeamMember{}, nil
}

func (d *memberRefusalDAO) RemoveMember(context.Context, string) error {
	d.t.Helper()
	d.t.Fatal("unexpected RemoveMember after membership refusal")
	return nil
}
func (d *ruleReadDAO) RevokeInvitation(ctx context.Context, id string, now time.Time) (bool, error) {
	return d.revokeInvitation(ctx, id, now)
}

type invitationReadDAO struct {
	store.TeamReader
	read func(context.Context, []byte) (model.TeamInvitation, error)
}

func (d *invitationReadDAO) TeamInvitation(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
	return d.read(ctx, hash)
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
		name     string
		actor    model.Principal
		id, user string
		in       ChangeTeamMember
		modes    []bool
		code     string
	}{
		{name: "identity mismatch", actor: p, id: id, user: id, in: ChangeTeamMember{Version: 1, Role: model.ProjectMemberRole, ExpectedUserID: other.UserID}, modes: []bool{false, true}, code: "identity_mismatch"},
		{name: "anonymous", actor: model.Principal{}, id: id, user: p.UserID, in: ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: p.UserID}, modes: []bool{false}, code: "unauthenticated"},
		{name: "invalid Team ID", actor: p, id: "invalid", user: p.UserID, in: ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: p.UserID}, modes: []bool{false, true}, code: "invalid_input"},
		{name: "invalid member ID", actor: p, id: id, user: "bad", in: ChangeTeamMember{Version: 1, ExpectedUserID: p.UserID}, modes: []bool{true}, code: "invalid_input"},
		{name: "noncanonical member ID", actor: p, id: id, user: strings.ToUpper("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), in: ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: p.UserID}, modes: []bool{false}, code: "invalid_input"},
		{name: "zero version", actor: p, id: id, user: p.UserID, in: ChangeTeamMember{Version: 0, Role: model.ProjectAdmin, ExpectedUserID: p.UserID}, modes: []bool{false, true}, code: "invalid_input"},
		{name: "empty role", actor: p, id: id, user: id, in: ChangeTeamMember{Version: 1, ExpectedUserID: p.UserID}, modes: []bool{false}, code: "invalid_input"},
		{name: "invalid role", actor: p, id: id, user: p.UserID, in: ChangeTeamMember{Version: 1, Role: "invalid", ExpectedUserID: p.UserID}, modes: []bool{false}, code: "invalid_input"},
	} {
		for _, remove := range tc.modes {
			operation := "set role"
			if remove {
				operation = "remove"
			}
			t.Run("member admission/"+tc.name+"/"+operation, func(t *testing.T) {
				teamID, userID, err := ValidateMemberChange(tc.actor, tc.id, tc.user, tc.in, remove)
				faultCode(t, err, tc.code)
				if teamID != "" || userID != "" {
					t.Fatalf("refusal returned IDs: Team=%q member=%q", teamID, userID)
				}
			})
		}
	}
	if teamID, userID, err := ValidateMemberChange(p, id, id, ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: p.UserID}, false); err != nil || teamID != id || userID != id {
		t.Fatalf("member admission: Team=%q member=%q error=%v", teamID, userID, err)
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
	ctx := t.Context()
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
	for _, tc := range []struct {
		name    string
		version int64
	}{{name: "ordinary", version: 1}, {name: "maximum", version: math.MaxInt64}} {
		t.Run("rename no-op "+tc.name, func(t *testing.T) {
			current := item
			current.Version = tc.version
			snapshot := current
			name := *current.Name
			snapshot.Name = &name
			reads := 0
			dao := &ruleReadDAO{team: func(gotCtx context.Context, actor string) (model.Team, error) {
				reads++
				if gotCtx != ctx || actor != p.UserID || reads != 1 {
					t.Fatalf("Team lookup: context=%v actor=%q calls=%d", gotCtx, actor, reads)
				}
				return snapshot, nil
			}}
			confirmed := ChangeTeam{Name: *current.Name, Version: tc.version, ExpectedUserID: p.UserID}
			same, err := Rename(ctx, dao, p, confirmed)
			if err != nil || !reflect.DeepEqual(same, current) || reads != 1 {
				t.Fatalf("no-op changed Team: %#v, %v; reads=%d", same, err, reads)
			}
		})
	}
	input.Name = " Renamed "
	storedName, expectedName := " Renamed ", " Renamed "
	w.renameResult = model.Team{
		TeamRef: model.TeamRef{ID: item.ID, Name: &storedName, Kind: "ordinary"},
		Version: 2, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt.Add(time.Second),
		Membership: item.Membership,
	}
	wantRenamed := w.renameResult
	wantRenamed.Name = &expectedName
	renamed, err := Rename(ctx, w, p, input)
	if err != nil || !reflect.DeepEqual(renamed, wantRenamed) || *renamed.Name != " Renamed " || !renamed.UpdatedAt.After(item.UpdatedAt) || !reflect.DeepEqual(renamed.Membership, item.Membership) {
		t.Fatalf("renamed Team: %#v %v; want %#v", renamed, err, wantRenamed)
	}
	if w.renameCalls != 1 || w.renameContext != ctx || w.renameActor != p.UserID || w.renameName != " Renamed " {
		t.Fatalf("rename invocation: context=%v actor=%q name=%q calls=%d", w.renameContext, w.renameActor, w.renameName, w.renameCalls)
	}
	memberTeam, personalTeam := item, item
	memberTeam.Membership.Role = model.ProjectMemberRole
	personalTeam.Kind, personalTeam.Name = "personal", nil
	exhausted := item
	exhausted.Version = math.MaxInt64
	oversized := strings.Repeat("a", 257)
	for _, tc := range []struct {
		name    string
		team    model.Team
		teamErr error
		in      ChangeTeam
		code    string
	}{
		{name: "read failure", team: item, teamErr: fail, in: ChangeTeam{Name: "New", Version: 1}},
		{name: "missing before name limit", teamErr: model.ErrNotFound, in: ChangeTeam{Name: oversized, Version: 1}},
		{name: "forbidden before name limit", team: memberTeam, in: ChangeTeam{Name: oversized, Version: 1}, code: "forbidden"},
		{name: "personal", team: personalTeam, in: ChangeTeam{Name: "New", Version: 1}, code: "personal_team_immutable"},
		{name: "version mismatch before name limit", team: item, in: ChangeTeam{Name: oversized, Version: 2}, code: "version_conflict"},
		{name: "version exhausted before name limit", team: exhausted, in: ChangeTeam{Name: oversized, Version: math.MaxInt64}, code: "version_exhausted"},
		{name: "name limit", team: item, in: ChangeTeam{Name: oversized, Version: 1}, code: "invalid_input"},
	} {
		t.Run("rename "+tc.name, func(t *testing.T) {
			reads := 0
			dao := &ruleReadDAO{team: func(gotCtx context.Context, actor string) (model.Team, error) {
				reads++
				if gotCtx != ctx || actor != p.UserID || reads != 1 {
					t.Fatalf("Team lookup: context=%v actor=%q calls=%d", gotCtx, actor, reads)
				}
				return tc.team, tc.teamErr
			}}
			got, err := Rename(ctx, dao, p, tc.in)
			if tc.teamErr != nil {
				if err != tc.teamErr {
					t.Fatalf("Team read error lost: %v; want %v", err, tc.teamErr)
				}
			} else {
				faultCode(t, err, tc.code)
			}
			if !reflect.DeepEqual(got, model.Team{}) || reads != 1 {
				t.Fatalf("rename refusal returned Team: %#v; reads=%d", got, reads)
			}
		})
	}
	for _, tc := range []struct {
		name    string
		team    model.Team
		teamErr error
		in      ChangeTeam
		code    string
	}{
		{name: "forbidden", team: memberTeam, in: ChangeTeam{Name: *item.Name, Version: 1}, code: "forbidden"},
		{name: "personal", team: personalTeam, in: ChangeTeam{Name: "Personal", Version: 1}, code: "personal_team_immutable"},
		{name: "version mismatch", team: item, in: ChangeTeam{Name: *item.Name, Version: 2}, code: "version_conflict"},
		{name: "name mismatch", team: item, in: ChangeTeam{Name: "New", Version: 1}, code: "version_conflict"},
		{name: "actor membership removed", teamErr: model.ErrNotFound, in: ChangeTeam{Name: *item.Name, Version: 1}},
	} {
		t.Run("delete "+tc.name, func(t *testing.T) {
			reads := 0
			dao := &ruleReadDAO{team: func(gotCtx context.Context, actor string) (model.Team, error) {
				reads++
				if gotCtx != ctx || actor != p.UserID || reads != 1 {
					t.Fatalf("Team lookup: context=%v actor=%q calls=%d", gotCtx, actor, reads)
				}
				return tc.team, tc.teamErr
			}}
			err := Delete(ctx, dao, p, tc.in)
			if tc.teamErr != nil {
				if err != tc.teamErr || !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("actor lookup error lost: %v; want %v", err, tc.teamErr)
				}
			} else {
				faultCode(t, err, tc.code)
			}
			if reads != 1 {
				t.Fatalf("Team reads=%d; want 1", reads)
			}
		})
	}
	input.Version = 1
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
	ctx := t.Context()
	p := principal()
	target := uuid.NewString()
	item := namedTeam(p)
	member := model.TeamMember{TeamID: item.ID, UserID: target, Role: model.ProjectAdmin, Version: 2, CreatedAt: item.CreatedAt.Add(time.Second), UpdatedAt: item.UpdatedAt.Add(time.Second)}
	in := ChangeTeamMember{Version: 2, Role: model.ProjectMemberRole, ExpectedUserID: p.UserID}
	personal, nonAdmin := item, item
	personal.Kind, personal.Name = "personal", nil
	nonAdmin.Membership.Role = model.ProjectMemberRole
	rejoined := model.TeamMember{TeamID: item.ID, UserID: target, Role: model.ProjectMemberRole, Version: 7, CreatedAt: member.CreatedAt.Add(time.Minute), UpdatedAt: member.UpdatedAt.Add(time.Minute)}
	for _, tc := range []struct {
		name       string
		modes      []bool
		team       model.Team
		teamErr    error
		target     string
		member     model.TeamMember
		memberErr  error
		version    int64
		removeRole model.ProjectRole
		count      int64
		countErr   error
		code       string
		cause      error
		calls      []string
	}{
		{name: "actor read failure", modes: []bool{false}, teamErr: fail, target: target, version: 2, cause: fail, calls: []string{"team"}},
		{name: "actor membership removed", modes: []bool{false, true}, teamErr: model.ErrNotFound, target: target, version: 2, cause: model.ErrNotFound, calls: []string{"team"}},
		{name: "personal member", modes: []bool{false}, team: personal, target: target, version: 2, code: "personal_team_immutable", calls: []string{"team"}},
		{name: "personal self", modes: []bool{false, true}, team: personal, target: p.UserID, version: item.Membership.Version, removeRole: model.ProjectMemberRole, code: "personal_team_immutable", calls: []string{"team"}},
		{name: "non-admin changes another member", modes: []bool{false, true}, team: nonAdmin, target: target, version: 2, code: "forbidden", calls: []string{"team"}},
		{name: "missing member", modes: []bool{false}, team: item, target: target, memberErr: model.ErrNotFound, version: 2, code: "not_found", cause: model.ErrNotFound, calls: []string{"team", "member"}},
		{name: "member read failure", modes: []bool{false}, team: item, target: target, memberErr: fail, version: 2, cause: fail, calls: []string{"team", "member"}},
		{name: "future version", modes: []bool{false}, team: item, target: target, member: member, version: 3, code: "version_conflict", calls: []string{"team", "member"}},
		{name: "stale rejoined version", modes: []bool{true}, team: item, target: target, member: rejoined, version: member.Version, code: "version_conflict", calls: []string{"team", "member"}},
		{name: "administrator count failure", modes: []bool{false}, team: item, target: target, member: member, version: 2, countErr: fail, cause: fail, calls: []string{"team", "member", "count"}},
		{name: "last administrator", modes: []bool{false, true}, team: item, target: p.UserID, member: item.Membership, version: item.Membership.Version, count: 1, code: "last_admin", calls: []string{"team", "member", "count"}},
	} {
		for _, remove := range tc.modes {
			operation := "set role"
			currentInput := ChangeTeamMember{Version: tc.version, Role: model.ProjectMemberRole, ExpectedUserID: p.UserID}
			if remove {
				operation, currentInput.Role = "remove", tc.removeRole
			}
			t.Run(tc.name+"/"+operation, func(t *testing.T) {
				var calls []string
				record := func(gotCtx context.Context, call string) {
					t.Helper()
					calls = append(calls, call)
					if gotCtx != ctx || len(calls) > len(tc.calls) || tc.calls[len(calls)-1] != call {
						t.Fatalf("unexpected DAO call: context=%v calls=%v; want %v", gotCtx, calls, tc.calls)
					}
				}
				dao := &ruleReadDAO{
					team: func(gotCtx context.Context, actor string) (model.Team, error) {
						record(gotCtx, "team")
						if actor != p.UserID {
							t.Fatalf("Team actor=%q; want %q", actor, p.UserID)
						}
						return tc.team, tc.teamErr
					},
					member: func(gotCtx context.Context, user string) (model.TeamMember, error) {
						record(gotCtx, "member")
						if user != tc.target {
							t.Fatalf("member target=%q; want %q", user, tc.target)
						}
						return tc.member, tc.memberErr
					},
					adminCount: func(gotCtx context.Context) (int64, error) {
						record(gotCtx, "count")
						return tc.count, tc.countErr
					},
				}
				result, err := ChangeMember(ctx, &memberRefusalDAO{ruleReadDAO: dao, t: t}, p, tc.target, currentInput, remove)
				if tc.code != "" {
					faultCode(t, err, tc.code)
				} else if err != tc.cause {
					t.Fatalf("DAO error lost: %v; want %v", err, tc.cause)
				}
				if tc.cause != nil && !errors.Is(err, tc.cause) {
					t.Fatalf("DAO error chain lost: %v; want %v", err, tc.cause)
				}
				if !reflect.DeepEqual(result, TeamMemberResult{}) || !reflect.DeepEqual(calls, tc.calls) {
					t.Fatalf("member refusal: result=%#v calls=%v; want %v", result, calls, tc.calls)
				}
			})
		}
	}
	w := &writerFake{team: item, member: member, count: 2, errs: map[string]error{}}
	w.errs["role"] = fail
	if _, err := ChangeMember(ctx, w, p, target, in, false); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "role")
	demoted := model.TeamMember{TeamID: item.ID, UserID: target, Role: model.ProjectMemberRole, Version: 3, CreatedAt: member.CreatedAt, UpdatedAt: member.UpdatedAt.Add(time.Second)}
	w.roleResult = demoted
	result, err := ChangeMember(ctx, w, p, target, in, false)
	adminRole := model.ProjectAdmin
	wantDemoted := TeamMemberResult{Membership: demoted, ActorRole: &adminRole}
	if err != nil || !reflect.DeepEqual(result, wantDemoted) || w.memberContext != ctx || w.memberID != target || w.roleContext != ctx || w.changedMemberID != target || w.changedRole != model.ProjectMemberRole {
		t.Fatalf("demoted membership: %#v %v; want %#v", result, err, wantDemoted)
	}
	w.member = demoted
	in.Version = demoted.Version
	in.Role = model.ProjectAdmin
	promotedMember := model.TeamMember{TeamID: item.ID, UserID: target, Role: model.ProjectAdmin, Version: 4, CreatedAt: member.CreatedAt, UpdatedAt: demoted.UpdatedAt.Add(time.Second)}
	w.roleResult = promotedMember
	promoted, err := ChangeMember(ctx, w, p, target, in, false)
	wantPromoted := TeamMemberResult{Membership: promotedMember, ActorRole: &adminRole}
	if err != nil || !reflect.DeepEqual(promoted, wantPromoted) || promoted.Membership.Version <= demoted.Version || w.roleContext != ctx || w.changedMemberID != target || w.changedRole != model.ProjectAdmin {
		t.Fatalf("promoted membership: %#v %v; want %#v", promoted, err, wantPromoted)
	}
	w.member = promotedMember
	in.Version = promotedMember.Version
	w.changedRole = ""
	w.roleCalls = 0
	result, err = ChangeMember(ctx, w, p, target, in, false)
	if err != nil || w.changedRole != "" || w.roleCalls != 0 || !reflect.DeepEqual(result, promoted) {
		t.Fatalf("no-op membership: %#v %v; want %#v; writes=%d", result, err, promoted, w.roleCalls)
	}
	w.errs["remove"] = fail
	if _, err = ChangeMember(ctx, w, p, target, in, true); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "remove")
	result, err = ChangeMember(ctx, w, p, target, in, true)
	if err != nil || !w.removed || !reflect.DeepEqual(result, wantPromoted) || w.removeContext != ctx || w.removedMemberID != target {
		t.Fatalf("removed membership: %#v %v; want %#v", result, err, wantPromoted)
	}
	w.team = item
	w.member = item.Membership
	in.Version = item.Membership.Version
	in.Role = model.ProjectMemberRole
	selfDemoted := model.TeamMember{TeamID: item.ID, UserID: p.UserID, Role: model.ProjectMemberRole, Version: 5, CreatedAt: item.Membership.CreatedAt, UpdatedAt: item.Membership.UpdatedAt.Add(2 * time.Second)}
	w.roleResult = selfDemoted
	demotedSelf, err := ChangeMember(ctx, w, p, p.UserID, in, false)
	memberRole := model.ProjectMemberRole
	wantSelfDemoted := TeamMemberResult{Membership: selfDemoted, ActorRole: &memberRole}
	if err != nil || !reflect.DeepEqual(demotedSelf, wantSelfDemoted) || w.memberContext != ctx || w.memberID != p.UserID || w.roleContext != ctx || w.changedMemberID != p.UserID || w.changedRole != model.ProjectMemberRole {
		t.Fatalf("self-demoted membership: %#v %v; want %#v", demotedSelf, err, wantSelfDemoted)
	}
	w.team.Membership = selfDemoted
	w.member = selfDemoted
	in.Version = selfDemoted.Version
	w.removed = false
	result, err = ChangeMember(ctx, w, p, p.UserID, in, true)
	wantRemovedSelf := TeamMemberResult{Membership: selfDemoted}
	if err != nil || !w.removed || result.ActorRole != nil || !reflect.DeepEqual(result, wantRemovedSelf) || !reflect.DeepEqual(result.Membership, demotedSelf.Membership) || w.memberContext != ctx || w.memberID != p.UserID || w.removeContext != ctx || w.removedMemberID != p.UserID {
		t.Fatalf("self-removed membership: %#v %v; want %#v", result, err, wantRemovedSelf)
	}
}

func TestInvitationRules(t *testing.T) {
	ctx := t.Context()
	p := principal()
	item := namedTeam(p)
	teamName := " Team "
	item.Name = &teamName
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
	wantStored := model.TeamInvitation{ID: minted.Invitation.ID, TeamID: item.ID, CreatedBy: p.UserID, TokenHash: secretutil.Hash(minted.Secret), CreatedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}
	wantMinted := wantStored
	wantMinted.TokenHash = nil
	if err != nil || !bytes.Equal(w.invitation.TokenHash, secretutil.Hash(minted.Secret)) || !reflect.DeepEqual(w.invitation, wantStored) || !reflect.DeepEqual(minted.Invitation, wantMinted) || !minted.Invitation.CreatedAt.Equal(now) || minted.Invitation.ExpiresAt.Sub(minted.Invitation.CreatedAt) != 7*24*time.Hour {
		t.Fatalf("minted invitation: %#v %v; stored=%#v", minted, err, w.invitation)
	}
	if err := ValidateInvitation(p, minted.Secret); err != nil {
		t.Fatal(err)
	}
	personal := item
	personal.Kind, personal.Name = "personal", nil
	for _, tc := range []struct {
		name    string
		team    model.Team
		teamErr error
		changed bool
		code    string
		calls   []string
	}{
		{name: "read failure", teamErr: fail, calls: []string{"team"}},
		{name: "personal", team: personal, code: "personal_team_immutable", calls: []string{"team"}},
		{name: "changed", team: item, changed: true, calls: []string{"team", "clock", "revoke"}},
		{name: "already revoked", team: item, changed: false, calls: []string{"team", "clock", "revoke"}},
	} {
		t.Run("revoke invitation/"+tc.name, func(t *testing.T) {
			var calls []string
			record := func(call string) {
				t.Helper()
				calls = append(calls, call)
				if len(calls) > len(tc.calls) || tc.calls[len(calls)-1] != call {
					t.Fatalf("unexpected revoke call: %v; want %v", calls, tc.calls)
				}
			}
			dao := &ruleReadDAO{
				team: func(gotCtx context.Context, actor string) (model.Team, error) {
					record("team")
					if gotCtx != ctx || actor != p.UserID {
						t.Fatalf("Team lookup: context=%v actor=%q", gotCtx, actor)
					}
					return tc.team, tc.teamErr
				},
				revokeInvitation: func(gotCtx context.Context, invitationID string, at time.Time) (bool, error) {
					record("revoke")
					if gotCtx != ctx || invitationID != id || !at.Equal(now) {
						t.Fatalf("revoke arguments: context=%v id=%q time=%v", gotCtx, invitationID, at)
					}
					return tc.changed, nil
				},
			}
			changed, err := RevokeInvitation(ctx, dao, p, id, func() time.Time {
				record("clock")
				return now
			})
			if tc.code != "" {
				faultCode(t, err, tc.code)
			} else if err != tc.teamErr {
				t.Fatalf("revoke error=%v; want %v", err, tc.teamErr)
			}
			if changed != tc.changed || !reflect.DeepEqual(calls, tc.calls) {
				t.Fatalf("revocation: changed=%v calls=%v; want %v %v", changed, calls, tc.changed, tc.calls)
			}
		})
	}
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
	available := w.invitation
	expired, consumed, revoked := available, available, available
	expired.ExpiresAt = now
	prior := now.Add(-time.Minute)
	consumer := principal()
	consumed.ConsumedAt, consumed.ConsumedBy = &prior, &consumer.UserID
	revoked.RevokedAt = &prior
	for _, tc := range []struct {
		name       string
		invitation model.TeamInvitation
		err        error
		code       string
		calls      []string
	}{
		{name: "missing", err: model.ErrNotFound, code: "invitation_unavailable", calls: []string{"read"}},
		{name: "read failure", err: fail, calls: []string{"read"}},
		{name: "expired", invitation: expired, code: "invitation_unavailable", calls: []string{"read", "clock"}},
		{name: "consumed", invitation: consumed, code: "invitation_unavailable", calls: []string{"read", "clock"}},
		{name: "revoked", invitation: revoked, code: "invitation_unavailable", calls: []string{"read", "clock"}},
		{name: "available", invitation: available, calls: []string{"read", "clock"}},
	} {
		t.Run("read invitation/"+tc.name, func(t *testing.T) {
			var calls []string
			record := func(call string) {
				t.Helper()
				calls = append(calls, call)
				if len(calls) > len(tc.calls) || tc.calls[len(calls)-1] != call {
					t.Fatalf("unexpected invitation read: %v; want %v", calls, tc.calls)
				}
			}
			dao := &invitationReadDAO{read: func(gotCtx context.Context, hash []byte) (model.TeamInvitation, error) {
				record("read")
				if gotCtx != ctx || !bytes.Equal(hash, secretutil.Hash(minted.Secret)) {
					t.Fatalf("invitation lookup: context=%v hash=%x", gotCtx, hash)
				}
				return tc.invitation, tc.err
			}}
			got, err := Invitation(ctx, dao, minted.Secret, func() time.Time {
				record("clock")
				return now
			})
			if tc.code != "" {
				faultCode(t, err, tc.code)
			} else if err != tc.err {
				t.Fatalf("invitation read error=%v; want %v", err, tc.err)
			}
			want := model.TeamInvitation{}
			if tc.code == "" && tc.err == nil {
				want = available
			}
			if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(calls, tc.calls) {
				t.Fatalf("invitation read: result=%#v calls=%v; want %#v %v", got, calls, want, tc.calls)
			}
		})
	}
	r.invitation = available
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
	previewName := " Team "
	wantTeam := model.TeamRef{ID: item.ID, Kind: "ordinary", Name: &previewName}
	r.inviteMemberErr = model.ErrNotFound
	preview, err := InspectInvitation(ctx, r, p, r.invitation)
	if err != nil || !reflect.DeepEqual(preview, TeamInvitationInspection{Team: wantTeam}) {
		t.Fatal(preview, err)
	}
	r.inviteMemberErr = fail
	if _, err = InspectInvitation(ctx, r, p, r.invitation); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	r.inviteMemberErr = nil
	r.member = item.Membership
	preview, err = InspectInvitation(ctx, r, p, r.invitation)
	wantMember := item.Membership
	if err != nil || !reflect.DeepEqual(preview, TeamInvitationInspection{Team: wantTeam, Membership: &wantMember}) || preview.Membership.UserID != p.UserID || preview.Membership.Role != model.ProjectAdmin {
		t.Fatalf("existing-member preview: %#v %v; want membership %#v", preview, err, wantMember)
	}
}

func TestInvitationAcceptanceRechecksAndFailures(t *testing.T) {
	ctx := t.Context()
	p := principal()
	item := namedTeam(p)
	now := time.Now().UTC()
	clock := func() time.Time { return now }
	w := &writerFake{
		invitation: model.TeamInvitation{ID: uuid.NewString(), TeamID: item.ID, CreatedBy: p.UserID, TokenHash: secretutil.Hash("token"), CreatedAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour)},
		ref:        model.TeamRef{ID: item.ID, Kind: "ordinary", Name: item.Name},
		member:     item.Membership,
		errs:       map[string]error{},
	}
	actor := p
	accept := func(want ...string) (TeamInvitationAcceptance, error) {
		t.Helper()
		w.acceptCalls, w.acceptContexts = nil, nil
		result, err := AcceptInvitation(ctx, w, actor, "token", clock)
		if !reflect.DeepEqual(w.acceptCalls, want) || err != nil && !reflect.DeepEqual(result, TeamInvitationAcceptance{}) {
			t.Fatalf("acceptance: result=%#v error=%v calls=%v; want %v", result, err, w.acceptCalls, want)
		}
		for i, call := range w.acceptCalls {
			if w.acceptContexts[i] != ctx {
				t.Fatalf("%s context changed: %v", call, w.acceptContexts[i])
			}
			switch call {
			case "lock":
				if !reflect.DeepEqual(w.lockedHash, secretutil.Hash("token")) {
					t.Fatalf("locked hash=%x", w.lockedHash)
				}
			case "member":
				if w.invitationMemberID != actor.UserID {
					t.Fatalf("invitation member=%q; want %q", w.invitationMemberID, actor.UserID)
				}
			case "add":
				if w.addedMemberID != actor.UserID {
					t.Fatalf("added member=%q; want %q", w.addedMemberID, actor.UserID)
				}
			case "consume":
				if w.consumedInvitationID != w.invitation.ID || w.consumedMemberID != actor.UserID || !w.consumedAt.Equal(now) {
					t.Fatalf("consumed invitation=%q member=%q at=%v", w.consumedInvitationID, w.consumedMemberID, w.consumedAt)
				}
			}
		}
		return result, err
	}
	w.errs["lock"] = model.ErrNotFound
	_, err := accept("lock")
	faultCode(t, err, "invitation_unavailable")
	w.errs["lock"] = fail
	if _, err = accept("lock"); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "lock")
	expired, consumed, revoked, expiresWhileLocked := w.invitation, w.invitation, w.invitation, w.invitation
	expired.ExpiresAt = now
	prior := now.Add(-time.Minute)
	consumed.ConsumedAt, consumed.ConsumedBy = &prior, &p.UserID
	revoked.RevokedAt = &prior
	expiresWhileLocked.ExpiresAt = now.Add(500 * time.Millisecond)
	for _, tc := range []struct {
		name       string
		invitation model.TeamInvitation
		lockedAt   time.Time
	}{
		{name: "expired", invitation: expired, lockedAt: now},
		{name: "consumed", invitation: consumed, lockedAt: now},
		{name: "revoked", invitation: revoked, lockedAt: now},
		{name: "expires while locking", invitation: expiresWhileLocked, lockedAt: now.Add(time.Second)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			current := now
			var calls []string
			dao := &ruleReadDAO{lockInvitation: func(gotCtx context.Context, hash []byte) (model.TeamInvitation, error) {
				calls = append(calls, "lock")
				if gotCtx != ctx || !reflect.DeepEqual(hash, secretutil.Hash("token")) || len(calls) != 1 {
					t.Fatalf("invitation lock: context=%v hash=%x calls=%v", gotCtx, hash, calls)
				}
				current = tc.lockedAt
				return tc.invitation, nil
			}}
			lockedClock := func() time.Time {
				if !reflect.DeepEqual(calls, []string{"lock"}) {
					t.Fatalf("clock sampled before invitation lock: %v", calls)
				}
				calls = append(calls, "clock")
				return current
			}
			result, err := AcceptInvitation(ctx, dao, p, "token", lockedClock)
			faultCode(t, err, "invitation_unavailable")
			if !reflect.DeepEqual(result, TeamInvitationAcceptance{}) || !reflect.DeepEqual(calls, []string{"lock", "clock"}) {
				t.Fatalf("unavailable invitation: result=%#v calls=%v", result, calls)
			}
		})
	}
	w.errs["ref"] = fail
	if _, err = accept("lock", "ref"); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "ref")
	w.ref.Kind = "personal"
	_, err = accept("lock", "ref")
	faultCode(t, err, "invitation_unavailable")
	w.ref.Kind = "ordinary"
	w.errs["inviteMember"] = fail
	if _, err = accept("lock", "ref", "member"); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "inviteMember")
	result, err := accept("lock", "ref", "member")
	wantExisting := TeamInvitationAcceptance{Team: item.TeamRef, Membership: item.Membership}
	if err != nil || result.Joined || result.Consumed || w.added || !reflect.DeepEqual(result, wantExisting) || result.Membership.Role != model.ProjectAdmin || result.Membership.UserID != p.UserID {
		t.Fatalf("existing-member acceptance: %#v %v; want %#v", result, err, wantExisting)
	}
	actor = principal()
	joinedMember := model.TeamMember{TeamID: item.ID, UserID: actor.UserID, Role: model.ProjectMemberRole, Version: 7, CreatedAt: now, UpdatedAt: now}
	w.member = model.TeamMember{}
	w.invitedMember = joinedMember
	w.errs["inviteMember"] = model.ErrNotFound
	w.errs["add"] = fail
	if _, err = accept("lock", "ref", "member", "add"); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "add")
	w.errs["consume"] = fail
	if _, err = accept("lock", "ref", "member", "add", "consume"); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	delete(w.errs, "consume")
	result, err = accept("lock", "ref", "member", "add", "consume")
	wantJoined := TeamInvitationAcceptance{Team: item.TeamRef, Membership: joinedMember, Joined: true, Consumed: true}
	if err != nil || !result.Joined || !result.Consumed || !w.consumed || !reflect.DeepEqual(result, wantJoined) || result.Membership.UserID != actor.UserID || result.Membership.Role != model.ProjectMemberRole {
		t.Fatalf("joining-member acceptance: %#v %v; want %#v", result, err, wantJoined)
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
