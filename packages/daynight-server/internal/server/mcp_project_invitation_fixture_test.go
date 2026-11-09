package server

import (
	"bytes"
	"context"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

type mcpOrgProjectReader struct {
	t *testing.T
	store.ProjectReader
	ScopedProjectsCall func(ctx context.Context, actor model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error)
	ProjectCall        func(ctx context.Context, id string) (model.Project, error)
	ProjectAccessCall  func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error)
	TransferTeamCall   func(ctx context.Context, id string) (store.TransferTeam, error)
	TransferRoleCall   func(ctx context.Context, user, project, team string) (*model.ProjectRole, error)
	InvitationCall     func(ctx context.Context, hash []byte) (model.ProjectInvitation, error)
}

func (d mcpOrgProjectReader) ScopedProjects(ctx context.Context, actor model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	if d.ScopedProjectsCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO ScopedProjectsCall")
	}
	return d.ScopedProjectsCall(ctx, actor, scope, page)
}
func (d mcpOrgProjectReader) Project(ctx context.Context, id string) (model.Project, error) {
	if d.ProjectCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO ProjectCall")
	}
	return d.ProjectCall(ctx, id)
}
func (d mcpOrgProjectReader) ProjectAccess(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
	if d.ProjectAccessCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO ProjectAccessCall")
	}
	return d.ProjectAccessCall(ctx, actor, id)
}
func (d mcpOrgProjectReader) TransferTeam(ctx context.Context, id string) (store.TransferTeam, error) {
	if d.TransferTeamCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO TransferTeamCall")
	}
	return d.TransferTeamCall(ctx, id)
}
func (d mcpOrgProjectReader) TransferRole(ctx context.Context, user, project, team string) (*model.ProjectRole, error) {
	if d.TransferRoleCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO TransferRoleCall")
	}
	return d.TransferRoleCall(ctx, user, project, team)
}
func (d mcpOrgProjectReader) Invitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	if d.InvitationCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO InvitationCall")
	}
	return d.InvitationCall(ctx, hash)
}

type mcpOrgTeamReader struct {
	t                   *testing.T
	TeamAccessCall      func(ctx context.Context, user, id string) error
	TeamMembersPageCall func(ctx context.Context, id string, page store.Page) (store.TeamMemberPage, error)

	store.TeamReader
	TeamCall                 func(ctx context.Context, user, id string) (model.Team, error)
	TeamInvitationCall       func(ctx context.Context, hash []byte) (model.TeamInvitation, error)
	TeamInvitationPageCall   func(ctx context.Context, id string, now time.Time, page store.Page) (store.TeamInvitationPage, error)
	InvitationTeamCall       func(ctx context.Context, id string) (model.TeamRef, error)
	InvitationTeamMemberCall func(ctx context.Context, id, user string) (model.TeamMember, error)
}

func (d mcpOrgTeamReader) Team(ctx context.Context, user, id string) (model.Team, error) {
	if d.TeamCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO TeamCall")
	}
	return d.TeamCall(ctx, user, id)
}
func (d mcpOrgTeamReader) TeamInvitation(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
	if d.TeamInvitationCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO TeamInvitationCall")
	}
	return d.TeamInvitationCall(ctx, hash)
}
func (d mcpOrgTeamReader) TeamInvitationPage(ctx context.Context, id string, now time.Time, page store.Page) (store.TeamInvitationPage, error) {
	if d.TeamInvitationPageCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO TeamInvitationPageCall")
	}
	return d.TeamInvitationPageCall(ctx, id, now, page)
}
func (d mcpOrgTeamReader) InvitationTeam(ctx context.Context, id string) (model.TeamRef, error) {
	if d.InvitationTeamCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO InvitationTeamCall")
	}
	return d.InvitationTeamCall(ctx, id)
}
func (d mcpOrgTeamReader) InvitationTeamMember(ctx context.Context, id, user string) (model.TeamMember, error) {
	if d.InvitationTeamMemberCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO InvitationTeamMemberCall")
	}
	return d.InvitationTeamMemberCall(ctx, id, user)
}

type mcpOrgTeamWriter struct {
	t                 *testing.T
	RenameCall        func(ctx context.Context, user, name string) (model.Team, error)
	HasProjectsCall   func(ctx context.Context) (bool, error)
	MemberCall        func(ctx context.Context, user string) (model.TeamMember, error)
	AdminCountCall    func(ctx context.Context) (int64, error)
	SetMemberRoleCall func(ctx context.Context, user string, role model.ProjectRole) (model.TeamMember, error)
	RemoveMemberCall  func(ctx context.Context, user string) error

	store.TeamWriteDAO
	TeamCall              func(ctx context.Context, user string) (model.Team, error)
	CreateInvitationCall  func(ctx context.Context, invitation model.TeamInvitation) error
	LockInvitationCall    func(ctx context.Context, hash []byte) (model.TeamInvitation, error)
	InvitationTeamCall    func(ctx context.Context) (model.TeamRef, error)
	InvitationMemberCall  func(ctx context.Context, user string) (model.TeamMember, error)
	AddInvitedMemberCall  func(ctx context.Context, user string) (model.TeamMember, error)
	ConsumeInvitationCall func(ctx context.Context, id, user string, now time.Time) error
	RevokeInvitationCall  func(ctx context.Context, id string, now time.Time) (bool, error)
}

func (d mcpOrgTeamWriter) Team(ctx context.Context, user string) (model.Team, error) {
	if d.TeamCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO TeamCall")
	}
	return d.TeamCall(ctx, user)
}
func (d mcpOrgTeamWriter) CreateInvitation(ctx context.Context, invitation model.TeamInvitation) error {
	if d.CreateInvitationCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO CreateInvitationCall")
	}
	return d.CreateInvitationCall(ctx, invitation)
}
func (d mcpOrgTeamWriter) LockInvitation(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
	if d.LockInvitationCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO LockInvitationCall")
	}
	return d.LockInvitationCall(ctx, hash)
}
func (d mcpOrgTeamWriter) InvitationTeam(ctx context.Context) (model.TeamRef, error) {
	if d.InvitationTeamCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO InvitationTeamCall")
	}
	return d.InvitationTeamCall(ctx)
}
func (d mcpOrgTeamWriter) InvitationMember(ctx context.Context, user string) (model.TeamMember, error) {
	if d.InvitationMemberCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO InvitationMemberCall")
	}
	return d.InvitationMemberCall(ctx, user)
}
func (d mcpOrgTeamWriter) AddInvitedMember(ctx context.Context, user string) (model.TeamMember, error) {
	if d.AddInvitedMemberCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO AddInvitedMemberCall")
	}
	return d.AddInvitedMemberCall(ctx, user)
}
func (d mcpOrgTeamWriter) ConsumeInvitation(ctx context.Context, id, user string, now time.Time) error {
	if d.ConsumeInvitationCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO ConsumeInvitationCall")
	}
	return d.ConsumeInvitationCall(ctx, id, user, now)
}
func (d mcpOrgTeamWriter) RevokeInvitation(ctx context.Context, id string, now time.Time) (bool, error) {
	if d.RevokeInvitationCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO RevokeInvitationCall")
	}
	return d.RevokeInvitationCall(ctx, id, now)
}

type mcpOrgProjectWriter struct {
	t *testing.T
	store.ProjectWriteDAO
	ProjectCall               func(ctx context.Context) (model.Project, error)
	ProjectAccessCall         func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error)
	LockTransferOwnershipCall func(ctx context.Context) (model.ProjectOwnership, error)
	LockTransferTeamsCall     func(ctx context.Context, source, target string) (store.TransferTeam, store.TransferTeam, error)
	MoveOwnershipCall         func(ctx context.Context, target string) (model.ProjectOwnership, error)
	LockInvitationCall        func(ctx context.Context, hash []byte) (model.ProjectInvitation, error)
	DirectProjectMemberCall   func(ctx context.Context, user string) (model.ProjectMember, error)
	AddInvitedMemberCall      func(ctx context.Context, user string) (model.ProjectMember, error)
	ConsumeInvitationCall     func(ctx context.Context, id, user string, now time.Time) error
}

func (d mcpOrgProjectWriter) Project(ctx context.Context) (model.Project, error) {
	if d.ProjectCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO ProjectCall")
	}
	return d.ProjectCall(ctx)
}
func (d mcpOrgProjectWriter) ProjectAccess(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
	if d.ProjectAccessCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO ProjectAccessCall")
	}
	return d.ProjectAccessCall(ctx, actor)
}
func (d mcpOrgProjectWriter) LockTransferOwnership(ctx context.Context) (model.ProjectOwnership, error) {
	if d.LockTransferOwnershipCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO LockTransferOwnershipCall")
	}
	return d.LockTransferOwnershipCall(ctx)
}
func (d mcpOrgProjectWriter) LockTransferTeams(ctx context.Context, source, target string) (store.TransferTeam, store.TransferTeam, error) {
	if d.LockTransferTeamsCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO LockTransferTeamsCall")
	}
	return d.LockTransferTeamsCall(ctx, source, target)
}
func (d mcpOrgProjectWriter) MoveOwnership(ctx context.Context, target string) (model.ProjectOwnership, error) {
	if d.MoveOwnershipCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO MoveOwnershipCall")
	}
	return d.MoveOwnershipCall(ctx, target)
}
func (d mcpOrgProjectWriter) LockInvitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	if d.LockInvitationCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO LockInvitationCall")
	}
	return d.LockInvitationCall(ctx, hash)
}
func (d mcpOrgProjectWriter) DirectProjectMember(ctx context.Context, user string) (model.ProjectMember, error) {
	if d.DirectProjectMemberCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO DirectProjectMemberCall")
	}
	return d.DirectProjectMemberCall(ctx, user)
}
func (d mcpOrgProjectWriter) AddInvitedMember(ctx context.Context, user string) (model.ProjectMember, error) {
	if d.AddInvitedMemberCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO AddInvitedMemberCall")
	}
	return d.AddInvitedMemberCall(ctx, user)
}
func (d mcpOrgProjectWriter) ConsumeInvitation(ctx context.Context, id, user string, now time.Time) error {
	if d.ConsumeInvitationCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO ConsumeInvitationCall")
	}
	return d.ConsumeInvitationCall(ctx, id, user, now)
}

type mcpOrgTeamScope struct {
	t *testing.T
	store.TeamWriteScope
	team        store.TeamWriteDAO
	eligibility store.WebhookEligibilityDAO
}

func (s mcpOrgTeamScope) TeamDAO() store.TeamWriteDAO {
	if s.team == nil {
		unexpectedHTTPCall(s.t, "MCP Scope.TeamDAO")
	}
	return s.team
}
func (s mcpOrgTeamScope) EligibilityDAO() store.WebhookEligibilityDAO {
	if s.eligibility == nil {
		unexpectedHTTPCall(s.t, "MCP Scope.EligibilityDAO")
	}
	return s.eligibility
}

type mcpOrgProjectScope struct {
	t *testing.T
	store.ProjectWriteScope
	project     store.ProjectWriteDAO
	eligibility store.WebhookEligibilityDAO
}

func (s mcpOrgProjectScope) ProjectDAO() store.ProjectWriteDAO {
	if s.project == nil {
		unexpectedHTTPCall(s.t, "MCP Scope.ProjectDAO")
	}
	return s.project
}
func (s mcpOrgProjectScope) EligibilityDAO() store.WebhookEligibilityDAO {
	if s.eligibility == nil {
		unexpectedHTTPCall(s.t, "MCP Scope.EligibilityDAO")
	}
	return s.eligibility
}
func mcpOrgRead(t *testing.T, tx *httpTestStore, n int, project store.ProjectReader, team store.TeamReader) {
	switch d := project.(type) {
	case mcpOrgProjectReader:
		d.t = t
		project = d
	}
	switch d := team.(type) {
	case mcpOrgTeamReader:
		d.t = t
		team = d
	}
	called := mcpOrgCount(t, n)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		called()
		scope := newHTTPTestSnapshot(t)
		scope.Projects = project
		scope.Teams = team
		return op(scope)
	}
}
func mcpOrgWriteTeam(t *testing.T, tx *httpTestStore, id string, dao store.TeamWriteDAO, eligibility store.WebhookEligibilityDAO) {
	if d, ok := dao.(mcpOrgTeamWriter); ok {
		d.t = t
		dao = d
	}
	called := mcpOrgCount(t, 1)
	tx.WriteTeamCall = func(ctx context.Context, got string, op func(store.TeamWriteScope) error) (store.Completion, error) {
		called()
		projectHTTPCheck(t, got, id)
		err := op(mcpOrgTeamScope{t: t, team: dao, eligibility: eligibility})
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}
func mcpOrgWriteProject(t *testing.T, tx *httpTestStore, id string, dao store.ProjectWriteDAO, eligibility store.WebhookEligibilityDAO) {
	if d, ok := dao.(mcpOrgProjectWriter); ok {
		d.t = t
		dao = d
	}
	called := mcpOrgCount(t, 1)
	tx.WriteProjectCall = func(ctx context.Context, got string, op func(store.ProjectWriteScope) error) (store.Completion, error) {
		called()
		projectHTTPCheck(t, got, id)
		err := op(mcpOrgProjectScope{t: t, project: dao, eligibility: eligibility})
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}

type mcpOrgIdentityDAO struct {
	httpRejectedIdentityDAO
	authenticate func(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error)
	personal     func(context.Context, string) (store.PersonalTeamFacts, error)
	calls        int
}

func (d *mcpOrgIdentityDAO) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, at time.Time) (model.Principal, error) {
	d.calls++
	return d.authenticate(ctx, kind, hash, at)
}
func (d *mcpOrgIdentityDAO) IdentityPersonalTeam(ctx context.Context, user string) (store.PersonalTeamFacts, error) {
	d.calls++
	return d.personal(ctx, user)
}
func mcpOrgAuthenticate(t *testing.T, tx *httpTestStore, actors []model.Principal, tokens, personalTeams []string, wantPersonalReads int) {
	t.Helper()
	if len(actors) != len(tokens) || len(actors) != len(personalTeams) {
		t.Fatal("MCP organization identity fixtures must have aligned actors, credentials and Personal Teams")
	}
	for i, actor := range actors {
		if actor.Kind != model.PATCredential || !secret.Valid(tokens[i], "dnpat_") {
			t.Fatal("MCP organization credential fixture must be a canonical PAT")
		}
	}
	personalReads := newHTTPCallPlan(t, map[string]int{"IdentityPersonalTeam": wantPersonalReads})
	tx.WriteIdentityCall = func(ctx context.Context, op func(store.IdentityScope) error) (store.Completion, error) {
		d := &mcpOrgIdentityDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}}
		d.authenticate = func(ctx context.Context, kind model.CredentialKind, hash []byte, at time.Time) (model.Principal, error) {
			if at.IsZero() || at.Location() != time.UTC {
				unexpectedHTTPCall(t, "Identity.Authenticate time")
			}
			for i, actor := range actors {
				if kind == actor.Kind && bytes.Equal(hash, secret.Hash(tokens[i])) {
					return actor, nil
				}
			}
			unexpectedHTTPCall(t, "Identity.Authenticate undeclared credential")
			panic("unreachable")
		}
		d.personal = func(ctx context.Context, user string) (store.PersonalTeamFacts, error) {
			personalReads.Called("IdentityPersonalTeam")
			for i, actor := range actors {
				if actor.UserID == user {
					return store.PersonalTeamFacts{ID: personalTeams[i], MemberCount: 1, OwnerAdminCount: 1}, nil
				}
			}
			unexpectedHTTPCall(t, "IdentityPersonalTeam undeclared actor")
			panic("unreachable")
		}
		err := op(httpAuthenticationScope{t: t, dao: d})
		if d.calls != 1 {
			unexpectedHTTPCall(t, "Identity callback count")
		}
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}

type mcpOrgTeamCreator struct {
	insert func(context.Context, string, string) (model.Team, error)
}

func (d mcpOrgTeamCreator) InsertTeam(ctx context.Context, id, name string) (model.Team, error) {
	return d.insert(ctx, id, name)
}
func mcpOrgTeam(t *testing.T, id, name, user string) model.Team {
	t.Helper()
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1, CreatedAt: at, UpdatedAt: at, Membership: model.TeamMember{TeamID: id, UserID: user, Role: model.ProjectAdmin, Version: 1, CreatedAt: at, UpdatedAt: at}}
}
func mcpOrgCreateTeam(t *testing.T, tx *httpTestStore, p model.Principal, v model.Team) {
	write, insert := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	tx.CreateTeamCall = func(ctx context.Context, user string, op func(store.TeamCreationDAO) error) (store.Completion, error) {
		write()
		projectHTTPCheck(t, user, p.UserID)
		err := op(mcpOrgTeamCreator{insert: func(ctx context.Context, id, name string) (model.Team, error) {
			insert()
			parsed, err := uuid.Parse(id)
			if err != nil || parsed.Version() != 4 {
				unexpectedHTTPCall(t, "Team create UUID")
			}
			projectHTTPCheck(t, name, *v.Name)
			return v, nil
		}})
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}

type mcpOrgEligibility struct {
	t *testing.T
	store.WebhookEligibilityDAO
	lock func(context.Context, store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error)
}

func (d mcpOrgEligibility) LockAffected(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	return d.lock(ctx, f)
}
func mcpOrgNoEligibility(t *testing.T, filter store.WebhookEligibilityFilter) store.WebhookEligibilityDAO {
	called := mcpOrgCount(t, 1)
	return mcpOrgEligibility{t: t, lock: func(ctx context.Context, f store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
		called()
		projectHTTPCheck(t, f, filter)
		return []store.WebhookAuthorization{}, nil
	}}
}
func mcpOrgGetProject(t *testing.T, tx *httpTestStore, p model.Principal, v model.Project, accessErr error) {
	access := mcpOrgCount(t, 1)
	reader := mcpOrgProjectReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		access()
		projectHTTPCheck(t, actor, p)
		projectHTTPCheck(t, id, v.ID)
		return projectHTTPAccess(p, v), accessErr
	}}
	if accessErr == nil {
		read := mcpOrgCount(t, 1)
		reader.ProjectCall = func(ctx context.Context, id string) (model.Project, error) {
			read()
			projectHTTPCheck(t, id, v.ID)
			return v, nil
		}
	}
	mcpOrgRead(t, tx, 1, reader, nil)
}

func mcpOrgMintInvitation(t *testing.T, tx *httpTestStore, actor model.Principal, team model.Team) *model.TeamInvitation {
	t.Helper()
	out := new(model.TeamInvitation)
	read, write := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	mcpOrgWriteTeam(t, tx, team.ID, mcpOrgTeamWriter{TeamCall: func(ctx context.Context, user string) (model.Team, error) {
		read()
		projectHTTPCheck(t, user, actor.UserID)
		return team, nil
	}, CreateInvitationCall: func(ctx context.Context, v model.TeamInvitation) error {
		write()
		if _, err := model.CanonicalID(v.ID); err != nil || v.CreatedAt.IsZero() || v.CreatedAt.Location() != time.UTC || v.ExpiresAt.Sub(v.CreatedAt) != 7*24*time.Hour || len(v.TokenHash) != 32 {
			unexpectedHTTPCall(t, "Team invitation mint facts")
		}
		projectHTTPCheck(t, []string{v.TeamID, v.CreatedBy}, []string{team.ID, actor.UserID})
		*out = v
		return nil
	}}, nil)
	return out
}
func mcpOrgInspectTeam(t *testing.T, tx *httpTestStore, actor model.Principal, team model.TeamRef, v model.TeamInvitation, token string, membership *model.TeamMember) {
	t.Helper()
	read, readTeam, readMember := mcpOrgCount(t, 1), mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamInvitationCall: func(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
		read()
		projectHTTPCheck(t, hash, secret.Hash(token))
		return v, nil
	}, InvitationTeamCall: func(ctx context.Context, id string) (model.TeamRef, error) {
		readTeam()
		projectHTTPCheck(t, id, team.ID)
		return team, nil
	}, InvitationTeamMemberCall: func(ctx context.Context, id, user string) (model.TeamMember, error) {
		readMember()
		projectHTTPCheck(t, []string{id, user}, []string{team.ID, actor.UserID})
		if membership == nil {
			return model.TeamMember{}, model.ErrNotFound
		}
		return *membership, nil
	}})
}
func mcpOrgUnavailableTeamInvitation(t *testing.T, tx *httpTestStore, v model.TeamInvitation, token string) {
	t.Helper()
	read := mcpOrgCount(t, 1)
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamInvitationCall: func(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
		read()
		projectHTTPCheck(t, hash, secret.Hash(token))
		return v, nil
	}})
}
func mcpOrgAcceptTeam(t *testing.T, tx *httpTestStore, actor model.Principal, team model.TeamRef, v model.TeamInvitation, token string, result model.TeamMember, existing bool) {
	t.Helper()
	read := mcpOrgCount(t, 1)
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamInvitationCall: func(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
		read()
		projectHTTPCheck(t, hash, secret.Hash(token))
		return v, nil
	}})
	lock, ref, member := mcpOrgCount(t, 1), mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	dao := mcpOrgTeamWriter{LockInvitationCall: func(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
		lock()
		projectHTTPCheck(t, hash, secret.Hash(token))
		return v, nil
	}, InvitationTeamCall: func(ctx context.Context) (model.TeamRef, error) { ref(); return team, nil }, InvitationMemberCall: func(ctx context.Context, user string) (model.TeamMember, error) {
		member()
		projectHTTPCheck(t, user, actor.UserID)
		if !existing {
			return model.TeamMember{}, model.ErrNotFound
		}
		return result, nil
	}}
	if !existing {
		add, consume := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
		dao.AddInvitedMemberCall = func(ctx context.Context, user string) (model.TeamMember, error) {
			add()
			projectHTTPCheck(t, user, actor.UserID)
			return result, nil
		}
		dao.ConsumeInvitationCall = func(ctx context.Context, id, user string, now time.Time) error {
			consume()
			projectHTTPCheck(t, []string{id, user}, []string{v.ID, actor.UserID})
			if now.Before(v.CreatedAt) || now.Location() != time.UTC {
				unexpectedHTTPCall(t, "Team invitation consumption timestamp")
			}
			return nil
		}
	}
	mcpOrgWriteTeam(t, tx, team.ID, dao, mcpOrgNoEligibility(t, store.WebhookEligibilityFilter{TeamID: team.ID, UserID: actor.UserID}))
}
func mcpOrgRevokeInvitation(t *testing.T, tx *httpTestStore, actor model.Principal, team model.Team, id string, changed bool) {
	t.Helper()
	read, revoke := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	mcpOrgWriteTeam(t, tx, team.ID, mcpOrgTeamWriter{TeamCall: func(ctx context.Context, user string) (model.Team, error) {
		read()
		projectHTTPCheck(t, user, actor.UserID)
		return team, nil
	}, RevokeInvitationCall: func(ctx context.Context, got string, now time.Time) (bool, error) {
		revoke()
		projectHTTPCheck(t, got, id)
		if now.IsZero() || now.Location() != time.UTC {
			unexpectedHTTPCall(t, "Team invitation revocation time")
		}
		return changed, nil
	}}, nil)
}
func mcpOrgInspectProject(t *testing.T, tx *httpTestStore, actor model.Principal, project model.Project, v model.ProjectInvitation, token string) {
	t.Helper()
	read, readProject, access := mcpOrgCount(t, 1), mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	mcpOrgRead(t, tx, 1, mcpOrgProjectReader{InvitationCall: func(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
		read()
		projectHTTPCheck(t, hash, secret.Hash(token))
		return v, nil
	}, ProjectCall: func(ctx context.Context, id string) (model.Project, error) {
		readProject()
		projectHTTPCheck(t, id, project.ID)
		return project, nil
	}, ProjectAccessCall: func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		access()
		projectHTTPCheck(t, p, actor)
		projectHTTPCheck(t, id, project.ID)
		return model.ProjectAccess{}, model.ErrNotFound
	}}, nil)
}
func mcpOrgUnavailableProjectInvitation(t *testing.T, tx *httpTestStore, v model.ProjectInvitation, token string) {
	t.Helper()
	read := mcpOrgCount(t, 1)
	mcpOrgRead(t, tx, 1, mcpOrgProjectReader{InvitationCall: func(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
		read()
		projectHTTPCheck(t, hash, secret.Hash(token))
		return v, nil
	}}, nil)
}
func mcpOrgAcceptProject(t *testing.T, tx *httpTestStore, actor model.Principal, project model.Project, v model.ProjectInvitation, token string, result model.ProjectMember, existing bool) {
	t.Helper()
	read := mcpOrgCount(t, 1)
	mcpOrgRead(t, tx, 1, mcpOrgProjectReader{InvitationCall: func(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
		read()
		projectHTTPCheck(t, hash, secret.Hash(token))
		return v, nil
	}}, nil)
	lock, member, access := mcpOrgCount(t, 1), mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	dao := mcpOrgProjectWriter{LockInvitationCall: func(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
		lock()
		projectHTTPCheck(t, hash, secret.Hash(token))
		return v, nil
	}, DirectProjectMemberCall: func(ctx context.Context, user string) (model.ProjectMember, error) {
		member()
		projectHTTPCheck(t, user, actor.UserID)
		if !existing {
			return model.ProjectMember{}, model.ErrNotFound
		}
		return result, nil
	}, ProjectAccessCall: func(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
		access()
		projectHTTPCheck(t, p, actor)
		a := projectHTTPAccess(actor, project)
		a.Role = result.Grant.Role
		a.DirectGrant = &result.Grant
		return a, nil
	}}
	if !existing {
		add, consume := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
		dao.AddInvitedMemberCall = func(ctx context.Context, user string) (model.ProjectMember, error) {
			add()
			projectHTTPCheck(t, user, actor.UserID)
			return result, nil
		}
		dao.ConsumeInvitationCall = func(ctx context.Context, id, user string, now time.Time) error {
			consume()
			projectHTTPCheck(t, []string{id, user}, []string{v.ID, actor.UserID})
			if now.Before(v.CreatedAt) || now.Location() != time.UTC {
				unexpectedHTTPCall(t, "Project invitation consumption time")
			}
			return nil
		}
	}
	mcpOrgWriteProject(t, tx, project.ID, dao, mcpOrgNoEligibility(t, store.WebhookEligibilityFilter{ProjectID: project.ID, UserID: actor.UserID}))
}

func (d mcpOrgTeamReader) TeamAccess(ctx context.Context, user, id string) error {
	if d.TeamAccessCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO TeamAccessCall")
	}
	return d.TeamAccessCall(ctx, user, id)
}
func (d mcpOrgTeamReader) TeamMembersPage(ctx context.Context, id string, page store.Page) (store.TeamMemberPage, error) {
	if d.TeamMembersPageCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO TeamMembersPageCall")
	}
	return d.TeamMembersPageCall(ctx, id, page)
}

func (d mcpOrgTeamWriter) Rename(ctx context.Context, user, name string) (model.Team, error) {
	if d.RenameCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO RenameCall")
	}
	return d.RenameCall(ctx, user, name)
}
func (d mcpOrgTeamWriter) HasProjects(ctx context.Context) (bool, error) {
	if d.HasProjectsCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO HasProjectsCall")
	}
	return d.HasProjectsCall(ctx)
}
func (d mcpOrgTeamWriter) Member(ctx context.Context, user string) (model.TeamMember, error) {
	if d.MemberCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO MemberCall")
	}
	return d.MemberCall(ctx, user)
}
func (d mcpOrgTeamWriter) AdminCount(ctx context.Context) (int64, error) {
	if d.AdminCountCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO AdminCountCall")
	}
	return d.AdminCountCall(ctx)
}
func (d mcpOrgTeamWriter) SetMemberRole(ctx context.Context, user string, role model.ProjectRole) (model.TeamMember, error) {
	if d.SetMemberRoleCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO SetMemberRoleCall")
	}
	return d.SetMemberRoleCall(ctx, user, role)
}
func (d mcpOrgTeamWriter) RemoveMember(ctx context.Context, user string) error {
	if d.RemoveMemberCall == nil {
		unexpectedHTTPCall(d.t, "MCP DAO RemoveMemberCall")
	}
	return d.RemoveMemberCall(ctx, user)
}

func mcpOrgCount(t *testing.T, want int) func() {
	t.Helper()
	_, file, line, ok := runtime.Caller(1)
	if !ok {
		t.Fatal("MCP DAO plan has no callsite")
	}
	label := fmt.Sprintf("%s:%d", filepath.Base(file), line)
	var seen atomic.Int64
	t.Cleanup(func() {
		if got := seen.Load(); got != int64(want) {
			t.Errorf("MCP DAO plan %s calls=%d, want=%d", label, got, want)
		}
	})
	return func() {
		if got := seen.Add(1); got > int64(want) {
			unexpectedHTTPCall(t, "MCP DAO plan "+label)
		}
	}
}
