package team

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

const teamFixtureActor = "11111111-1111-4111-8111-111111111111"
const teamFixtureID = "22222222-2222-4222-8222-222222222222"
const teamFixtureTarget = "33333333-3333-4333-8333-333333333333"
const teamFixtureInvitation = "44444444-4444-4444-8444-444444444444"

func fixturePointer[T any](value T) *T { return &value }
func clonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	return fixturePointer(*value)
}
func cloneTeam(value model.Team) model.Team { value.Name = clonePointer(value.Name); return value }
func cloneInvitation(value model.TeamInvitation) model.TeamInvitation {
	value.TokenHash = slices.Clone(value.TokenHash)
	value.ConsumedBy = clonePointer(value.ConsumedBy)
	value.ConsumedAt = clonePointer(value.ConsumedAt)
	value.RevokedAt = clonePointer(value.RevokedAt)
	return value
}
func cloneMemberProfiles(values []model.TeamMemberProfile) []model.TeamMemberProfile {
	result := slices.Clone(values)
	for i := range result {
		result[i].Profile.Name = clonePointer(result[i].Profile.Name)
		result[i].Profile.Email = clonePointer(result[i].Profile.Email)
		result[i].Profile.AvatarURL = clonePointer(result[i].Profile.AvatarURL)
	}
	return result
}
func fixtureTeam() model.Team {
	now := time.Date(2026, 11, 6, 18, 30, 0, 123456000, time.UTC)
	return model.Team{TeamRef: model.TeamRef{ID: teamFixtureID, Kind: "ordinary", Name: fixturePointer(" \t研发😀\u2003 ")}, Version: 9007199254740993, CreatedAt: now, UpdatedAt: now,
		Membership: model.TeamMember{TeamID: teamFixtureID, UserID: teamFixtureActor, Role: model.ProjectAdmin, Version: 9007199254740995, CreatedAt: now, UpdatedAt: now}}
}
func fixtureMember() model.TeamMemberProfile {
	m := fixtureTeam().Membership
	m.UserID = teamFixtureTarget
	m.Role = model.ProjectMemberRole
	return model.TeamMemberProfile{Membership: m, Profile: model.ProjectParticipantProfile{Name: fixturePointer("Member 😀"), Email: fixturePointer("member@example.test"), AvatarURL: fixturePointer("https://example.test/avatar")}}
}
func fixtureInvitation() model.TeamInvitation {
	return model.TeamInvitation{ID: teamFixtureInvitation, TeamID: teamFixtureID, CreatedBy: teamFixtureActor, TokenHash: []byte("declared hash"), CreatedAt: fixtureTeam().CreatedAt, ExpiresAt: fixtureTeam().CreatedAt.Add(7 * 24 * time.Hour)}
}
func teamFault(t *testing.T, err error, code string) {
	t.Helper()
	fault, classified := core.WriteFault(err)
	if !classified {
		_ = errors.As(err, &fault)
	}
	if fault == nil || fault.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}
func fixtureFault(code string) error {
	return &model.Fault{Code: code, Message: "declared lower refusal"}
}

type readerToken struct{ store.TeamReader }
type writerToken struct{ store.TeamWriteDAO }
type creatorToken struct{ store.TeamCreationDAO }
type eligibilityToken struct{ store.WebhookEligibilityDAO }
type fixtureSnapshot struct {
	store.SnapshotScope
	fixture *teamFixture
}

func (s *fixtureSnapshot) TeamDAO() store.TeamReader {
	s.fixture.take("reader")
	return s.fixture.readDAO
}

type fixtureWriteScope struct{ fixture *teamFixture }

func (s *fixtureWriteScope) TeamDAO() store.TeamWriteDAO {
	s.fixture.take("writer")
	return s.fixture.writeDAO
}
func (s *fixtureWriteScope) EligibilityDAO() store.WebhookEligibilityDAO {
	s.fixture.take("eligibility")
	return s.fixture.eligibilityDAO
}

type fixtureStore struct{ fixture *teamFixture }

func (s *fixtureStore) ReadSnapshot(ctx context.Context, callback func(store.SnapshotScope) error) error {
	f := s.fixture
	f.take("snapshot")
	f.sameContext(ctx)
	if f.runRead {
		actual := callback(f.snapshot)
		if actual != f.readCallbackError {
			f.t.Errorf("snapshot callback error=%v want=%v", actual, f.readCallbackError)
		}
	}
	f.take("snapshot_done")
	if f.cancelAfterRead != nil {
		f.cancelAfterRead()
	}
	return f.readError
}
func (s *fixtureStore) WriteTeam(ctx context.Context, id string, callback func(store.TeamWriteScope) error) (store.Completion, error) {
	f := s.fixture
	f.take("write")
	f.sameContext(ctx)
	if id != f.id {
		f.t.Errorf("locked TeamID=%q want=%q", id, f.id)
	}
	if f.runWrite {
		actual := callback(f.writeScope)
		if actual != f.writeCallbackError {
			f.t.Errorf("write callback error=%v want=%v", actual, f.writeCallbackError)
		}
	}
	f.take("write_done")
	return f.completion, f.writeError
}
func (s *fixtureStore) CreateTeam(ctx context.Context, id string, callback func(store.TeamCreationDAO) error) (store.Completion, error) {
	f := s.fixture
	f.take("create_scope")
	f.sameContext(ctx)
	if id != f.p.UserID {
		f.t.Error("Team creation changed owner")
	}
	if f.runWrite {
		actual := callback(f.createDAO)
		if actual != f.writeCallbackError {
			f.t.Errorf("creation callback error=%v want=%v", actual, f.writeCallbackError)
		}
	}
	f.take("create_done")
	return f.completion, f.writeError
}

type teamFixture struct {
	t                                                            *testing.T
	ctx                                                          context.Context
	p                                                            model.Principal
	rawID, id, target, expected, secret, inviteID                string
	service                                                      *Teams
	store                                                        *fixtureStore
	snapshot                                                     *fixtureSnapshot
	writeScope                                                   *fixtureWriteScope
	readDAO                                                      *readerToken
	writeDAO                                                     *writerToken
	createDAO                                                    *creatorToken
	eligibilityDAO                                               *eligibilityToken
	want, calls                                                  []string
	runRead, runWrite                                            bool
	completion                                                   store.Completion
	readError, writeError, readCallbackError, writeCallbackError error
	cancelAfterRead                                              context.CancelFunc
	now                                                          time.Time
}

func newTeamFixture(t *testing.T, want ...string) *teamFixture {
	t.Helper()
	f := &teamFixture{t: t, ctx: t.Context(), p: model.Principal{Kind: model.SessionCredential, UserID: teamFixtureActor, CredentialID: "55555555-5555-4555-8555-555555555555"},
		rawID: teamFixtureID, id: teamFixtureID, target: teamFixtureTarget, expected: teamFixtureActor, secret: "dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", inviteID: teamFixtureInvitation,
		want: slices.Clone(want), runRead: true, runWrite: true, completion: store.Completion{Outcome: store.TransactionCommitted}, now: fixtureTeam().CreatedAt}
	f.readDAO = &readerToken{}
	f.writeDAO = &writerToken{}
	f.createDAO = &creatorToken{}
	f.eligibilityDAO = &eligibilityToken{}
	f.store = &fixtureStore{fixture: f}
	f.snapshot = &fixtureSnapshot{fixture: f}
	f.writeScope = &fixtureWriteScope{fixture: f}
	f.service = NewTeams(f.store)
	f.service.core = teamOperations{}
	f.service.now = func() time.Time { f.take("clock"); return f.now }
	t.Cleanup(func() {
		if !slices.Equal(f.calls, f.want) {
			t.Errorf("calls=%v want=%v", f.calls, f.want)
		}
	})
	return f
}
func (f *teamFixture) take(name string) {
	f.t.Helper()
	i := len(f.calls)
	f.calls = append(f.calls, name)
	if i >= len(f.want) || name != f.want[i] {
		f.t.Errorf("unexpected %s at %d, want %v", name, i, f.want)
	}
}
func (f *teamFixture) sameContext(ctx context.Context) {
	f.t.Helper()
	if ctx != f.ctx {
		f.t.Error("operation changed context")
	}
}
func (f *teamFixture) samePrincipal(p model.Principal) {
	f.t.Helper()
	if p != f.p {
		f.t.Errorf("principal=%+v want=%+v", p, f.p)
	}
}
func (f *teamFixture) readContext(name string, ctx context.Context, dao store.TeamReader, p model.Principal) {
	f.take(name)
	f.sameContext(ctx)
	f.samePrincipal(p)
	if dao != f.readDAO {
		f.t.Error("read changed bound DAO")
	}
}
func (f *teamFixture) readCall(name string, ctx context.Context, dao store.TeamReader, p model.Principal, id string) {
	f.readContext(name, ctx, dao, p)
	if id != f.id {
		f.t.Error("read changed TeamID")
	}
}
func (f *teamFixture) writeCall(name string, ctx context.Context, dao store.TeamWriteDAO, p model.Principal) {
	f.take(name)
	f.sameContext(ctx)
	f.samePrincipal(p)
	if dao != f.writeDAO {
		f.t.Error("write changed bound DAO")
	}
}
func (f *teamFixture) clock(clock func() time.Time) {
	f.t.Helper()
	if clock() == f.now {
		return
	}
	f.t.Error("operation changed clock capability")
}
func (f *teamFixture) validateRead(err error) {
	f.service.core.validateRead = func(p model.Principal, id string) (string, error) {
		f.take("validateRead")
		f.samePrincipal(p)
		if id != f.rawID {
			f.t.Errorf("raw TeamID=%q want=%q", id, f.rawID)
		}
		return f.id, err
	}
}
func (f *teamFixture) bindCreate(input core.CreateTeam, result model.Team, lower, admission error) {
	f.service.core.validateCreate = func(p model.Principal, actual core.CreateTeam) error {
		f.take("validateCreate")
		f.samePrincipal(p)
		if actual != input {
			f.t.Error("creation input changed")
		}
		return admission
	}
	f.service.core.create = func(ctx context.Context, dao store.TeamCreationDAO, actual core.CreateTeam) (model.Team, error) {
		f.take("create")
		f.sameContext(ctx)
		if dao != f.createDAO || actual != input {
			f.t.Error("creation changed DAO or input")
		}
		return cloneTeam(result), lower
	}
}
func (f *teamFixture) bindGet(result model.Team, lower error) {
	f.validateRead(nil)
	f.service.core.get = func(ctx context.Context, dao store.TeamReader, p model.Principal, id string) (model.Team, error) {
		f.readCall("get", ctx, dao, p, id)
		return cloneTeam(result), lower
	}
}
func (f *teamFixture) bindList(request model.PageRequest, result core.TeamPage, lower error) {
	request.Cursor = clonePointer(request.Cursor)
	f.service.core.list = func(ctx context.Context, dao store.TeamReader, p model.Principal, actual model.PageRequest) (core.TeamPage, error) {
		f.readContext("list", ctx, dao, p)
		if !reflect.DeepEqual(actual, request) {
			f.t.Error("Team page request changed")
		}
		copy := core.TeamPage{NextCursor: clonePointer(result.NextCursor)}
		for _, item := range result.Items {
			copy.Items = append(copy.Items, cloneTeam(item))
		}
		if result.Items != nil && copy.Items == nil {
			copy.Items = []model.Team{}
		}
		return copy, lower
	}
}
func (f *teamFixture) validateChange(input core.ChangeTeam, err error) {
	f.service.core.validateChange = func(p model.Principal, id string, actual core.ChangeTeam) (string, error) {
		f.take("validateChange")
		f.samePrincipal(p)
		if id != f.rawID || actual != input {
			f.t.Error("raw Team change input changed")
		}
		return f.id, err
	}
}
func (f *teamFixture) bindRename(input core.ChangeTeam, result model.Team, lower error) {
	f.validateChange(input, nil)
	f.service.core.rename = func(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, actual core.ChangeTeam) (model.Team, error) {
		f.writeCall("rename", ctx, dao, p)
		if actual != input {
			f.t.Error("rename input changed")
		}
		return cloneTeam(result), lower
	}
}
func (f *teamFixture) bindDelete(input core.ChangeTeam, lower error) {
	f.validateChange(input, nil)
	f.service.core.delete = func(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, actual core.ChangeTeam) error {
		f.writeCall("delete", ctx, dao, p)
		if actual != input {
			f.t.Error("delete input changed")
		}
		return lower
	}
}
func (f *teamFixture) bindMembers(result []model.TeamMemberProfile, lower error) {
	f.validateRead(nil)
	f.service.core.members = func(ctx context.Context, dao store.TeamReader, p model.Principal, id string) ([]model.TeamMemberProfile, error) {
		f.readCall("members", ctx, dao, p, id)
		return cloneMemberProfiles(result), lower
	}
}
func (f *teamFixture) bindMembersPage(request model.PageRequest, result core.MemberPage, lower error) {
	request.Cursor = clonePointer(request.Cursor)
	f.validateRead(nil)
	f.service.core.membersPage = func(ctx context.Context, dao store.TeamReader, p model.Principal, id string, actual model.PageRequest) (core.MemberPage, error) {
		f.readCall("membersPage", ctx, dao, p, id)
		if !reflect.DeepEqual(actual, request) {
			f.t.Error("member page input changed")
		}
		return core.MemberPage{Items: cloneMemberProfiles(result.Items), NextCursor: clonePointer(result.NextCursor)}, lower
	}
}
func (f *teamFixture) bindMember(result model.TeamMember, lower error) {
	f.validateRead(nil)
	f.service.core.member = func(ctx context.Context, dao store.TeamReader, p model.Principal, id, user string) (model.TeamMember, error) {
		f.readCall("member", ctx, dao, p, id)
		if user != f.target {
			f.t.Error("member target changed")
		}
		return result, lower
	}
}
func (f *teamFixture) validateMember(input core.ChangeTeamMember, remove bool, err error) {
	f.service.core.validateMemberChange = func(p model.Principal, id, user string, actual core.ChangeTeamMember, actualRemove bool) (string, string, error) {
		f.take("validateMember")
		f.samePrincipal(p)
		if id != f.rawID || user != f.target || actual != input || actualRemove != remove {
			f.t.Error("member admission input changed")
		}
		return f.id, f.target, err
	}
}
func (f *teamFixture) bindChangeMember(input core.ChangeTeamMember, remove bool, result core.TeamMemberResult, lower error) {
	f.validateMember(input, remove, nil)
	f.service.core.changeMember = func(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, target string, actual core.ChangeTeamMember, actualRemove bool) (core.TeamMemberResult, error) {
		f.writeCall("changeMember", ctx, dao, p)
		if target != f.target || actual != input || actualRemove != remove {
			f.t.Error("member operation input changed")
		}
		return core.TeamMemberResult{Membership: result.Membership, ActorRole: clonePointer(result.ActorRole)}, lower
	}
}
func (f *teamFixture) bindRefresh(filter store.WebhookEligibilityFilter, lower error) {
	f.service.core.refreshEligibility = func(ctx context.Context, dao store.WebhookEligibilityDAO, actual store.WebhookEligibilityFilter) error {
		f.take("refresh")
		f.sameContext(ctx)
		if dao != f.eligibilityDAO || actual != filter {
			f.t.Errorf("eligibility changed bound DAO/filter: %+v want=%+v", actual, filter)
		}
		return lower
	}
}
func (f *teamFixture) bindMint(result core.MintedTeamInvitation, lower, admission error) {
	f.service.core.validateInvitationWrite = func(p model.Principal, id, expected string) (string, error) {
		f.take("validateInvitationWrite")
		f.samePrincipal(p)
		if id != f.rawID || expected != f.expected {
			f.t.Error("invitation admission input changed")
		}
		return f.id, admission
	}
	f.service.core.createInvitation = func(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, id string, clock func() time.Time) (core.MintedTeamInvitation, error) {
		f.writeCall("mint", ctx, dao, p)
		if id != f.id {
			f.t.Error("mint TeamID changed")
		}
		f.clock(clock)
		return core.MintedTeamInvitation{Invitation: cloneInvitation(result.Invitation), Secret: result.Secret}, lower
	}
}
func (f *teamFixture) bindListInvitations(result []model.TeamInvitation, lower error) {
	f.validateRead(nil)
	f.service.core.listInvitations = func(ctx context.Context, dao store.TeamReader, p model.Principal, id string, clock func() time.Time) ([]model.TeamInvitation, error) {
		f.readCall("listInvitations", ctx, dao, p, id)
		f.clock(clock)
		copy := slices.Clone(result)
		for i := range copy {
			copy[i] = cloneInvitation(copy[i])
		}
		return copy, lower
	}
}
func (f *teamFixture) bindInvitationPage(request model.PageRequest, result core.InvitationPage, lower error) {
	request.Cursor = clonePointer(request.Cursor)
	f.validateRead(nil)
	f.service.core.listInvitationPage = func(ctx context.Context, dao store.TeamReader, p model.Principal, id string, actual model.PageRequest, clock func() time.Time) (core.InvitationPage, error) {
		f.readCall("invitationPage", ctx, dao, p, id)
		if !reflect.DeepEqual(actual, request) {
			f.t.Error("invitation page input changed")
		}
		f.clock(clock)
		copy := slices.Clone(result.Items)
		for i := range copy {
			copy[i] = cloneInvitation(copy[i])
		}
		return core.InvitationPage{Items: copy, NextCursor: clonePointer(result.NextCursor)}, lower
	}
}
func (f *teamFixture) bindRevoke(changed bool, lower, admission error) {
	f.service.core.validateInvitationRevoke = func(p model.Principal, id, invite, expected string) (string, string, error) {
		f.take("validateInvitationRevoke")
		f.samePrincipal(p)
		if id != f.rawID || invite != f.inviteID || expected != f.expected {
			f.t.Error("revoke admission input changed")
		}
		return f.id, f.inviteID, admission
	}
	f.service.core.revokeInvitation = func(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, id string, clock func() time.Time) (bool, error) {
		f.writeCall("revoke", ctx, dao, p)
		if id != f.inviteID {
			f.t.Error("revoke ID changed")
		}
		f.clock(clock)
		return changed, lower
	}
}
func (f *teamFixture) bindInvitation(result model.TeamInvitation, lower, admission error) {
	f.service.core.validateInvitation = func(p model.Principal, secret string) error {
		f.take("validateInvitation")
		f.samePrincipal(p)
		if secret != f.secret {
			f.t.Error("raw invitation secret changed")
		}
		return admission
	}
	f.service.core.invitation = func(ctx context.Context, dao store.TeamReader, secret string, clock func() time.Time) (model.TeamInvitation, error) {
		f.take("invitation")
		f.sameContext(ctx)
		if dao != f.readDAO || secret != f.secret {
			f.t.Error("invitation lookup changed DAO/secret")
		}
		f.clock(clock)
		return cloneInvitation(result), lower
	}
}
func (f *teamFixture) bindInspection(invite model.TeamInvitation, result core.TeamInvitationInspection, lower error) {
	f.bindInvitation(invite, nil, nil)
	f.service.core.inspectInvitation = func(ctx context.Context, dao store.TeamReader, p model.Principal, actual model.TeamInvitation) (core.TeamInvitationInspection, error) {
		f.readContext("inspect", ctx, dao, p)
		if !reflect.DeepEqual(actual, invite) {
			f.t.Error("inspection changed looked-up invitation")
		}
		copy := result
		copy.Team.Name = clonePointer(result.Team.Name)
		if result.Membership != nil {
			copy.Membership = fixturePointer(*result.Membership)
		}
		return copy, lower
	}
}
func (f *teamFixture) bindAccept(invite model.TeamInvitation, result core.TeamInvitationAcceptance, lower error) {
	f.service.core.requireActor = func(p model.Principal, expected string) error {
		f.take("requireActor")
		f.samePrincipal(p)
		if expected != f.expected {
			f.t.Error("accept actor input changed")
		}
		return nil
	}
	f.bindInvitation(invite, nil, nil)
	f.service.core.acceptInvitation = func(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, secret string, clock func() time.Time) (core.TeamInvitationAcceptance, error) {
		f.writeCall("accept", ctx, dao, p)
		if secret != f.secret {
			f.t.Error("accept secret changed")
		}
		f.clock(clock)
		copy := result
		copy.Team.Name = clonePointer(result.Team.Name)
		return copy, lower
	}
}
