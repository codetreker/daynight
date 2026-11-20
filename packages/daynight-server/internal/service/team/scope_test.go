package team

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func scopedAuth(t *testing.T, p model.Principal, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	ids, err := scopepolicy.Normalize(scopepolicy.PAT, ids)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
}

type guardedCandidateScope struct {
	store.SnapshotScope
	store.TeamReader
	team     model.Team
	searches int
}

func (s *guardedCandidateScope) CredentialDAO() store.CredentialReader { return s }
func (s *guardedCandidateScope) Credential(context.Context, model.Principal) (store.ThreadCredential, error) {
	return store.ThreadCredential{}, nil
}
func (s *guardedCandidateScope) TeamDAO() store.TeamReader                   { return s }
func (s *guardedCandidateScope) UserCandidateDAO() store.UserCandidateReader { return s }
func (s *guardedCandidateScope) Team(context.Context, string, string) (model.Team, error) {
	return s.team, nil
}
func (s *guardedCandidateScope) MemberCandidates(context.Context, store.UserCandidateQuery) (store.UserCandidatePage, error) {
	s.searches++
	return store.UserCandidatePage{}, nil
}

type guardedCandidateSnapshot struct{ scope *guardedCandidateScope }

func (s guardedCandidateSnapshot) ReadSnapshot(_ context.Context, cb func(store.SnapshotScope) error) error {
	return cb(s.scope)
}
func TestCandidateSearchUsesCurrentSnapshotAuthorization(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: teamFixtureActor, CredentialID: teamFixtureTarget}
	scope := &guardedCandidateScope{team: fixtureTeam()}
	snap := guardedCandidateSnapshot{scope}
	request := scopedAuth(t, p, "team:members")
	current := scopedAuth(t, p, "team:read")
	calls := 0
	svc := &Teams{reader: snap, admission: &scopeAdmission{request: func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
		t.Fatal("used stale request authorization")
		return request, nil
	}, snapshot: func(_ context.Context, actual store.SnapshotScope, got model.Principal) (model.CredentialAuthorization, error) {
		calls++
		if actual != scope || got != p {
			t.Fatal("wrong snapshot or principal")
		}
		return current, nil
	}}}
	_, err := svc.SearchMemberCandidates(context.Background(), p, teamFixtureID, core.CandidateSearchInput{ExpectedUserID: p.UserID, Query: "alice"})
	teamFault(t, err, "insufficient_scope")
	if calls != 1 || scope.searches != 0 {
		t.Fatalf("authorization=%d searches=%d", calls, scope.searches)
	}
	scope.team.Membership.Role = model.ProjectMemberRole
	calls = 0
	_, err = svc.SearchMemberCandidates(context.Background(), p, teamFixtureID, core.CandidateSearchInput{ExpectedUserID: p.UserID, Query: "alice"})
	teamFault(t, err, "insufficient_scope")
	if calls != 1 || scope.searches != 0 {
		t.Fatal("scope check did not precede role check")
	}
	current = request
	_, err = svc.SearchMemberCandidates(context.Background(), p, teamFixtureID, core.CandidateSearchInput{ExpectedUserID: p.UserID, Query: "alice"})
	teamFault(t, err, "forbidden")
	if scope.searches != 0 {
		t.Fatal("member reached candidate search")
	}
}

type guardedTeamWriteScope struct {
	store.TeamWriteScope
	store.TeamWriteDAO
	team     model.Team
	resolves int
}

func (s *guardedTeamWriteScope) IdentityDAO() store.IdentityDAO                   { return nil }
func (s *guardedTeamWriteScope) CredentialFamilyDAO() store.CredentialFamilyDAO   { return nil }
func (s *guardedTeamWriteScope) TeamDAO() store.TeamWriteDAO                      { return s }
func (s *guardedTeamWriteScope) Team(context.Context, string) (model.Team, error) { return s.team, nil }
func (s *guardedTeamWriteScope) MemberByExternalID(context.Context, string) (model.TeamMember, error) {
	s.resolves++
	return model.TeamMember{}, model.ErrNotFound
}

type guardedTeamWriter struct {
	store.TeamWriter
	scope *guardedTeamWriteScope
}

func (w guardedTeamWriter) WriteTeam(_ context.Context, _ string, cb func(store.TeamWriteScope) error) (store.Completion, error) {
	err := cb(w.scope)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func TestDirectMemberRechecksCurrentPolicyWithinTransaction(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: teamFixtureActor, CredentialID: teamFixtureTarget}
	scope := &guardedTeamWriteScope{team: fixtureTeam()}
	writer := guardedTeamWriter{scope: scope}
	allowed := scopedAuth(t, p, "team:members", "team:read")
	revoked := scopedAuth(t, p, "team:read")
	calls := 0
	svc, err := NewScopedDirectMembers(writer, nil, "", func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
		t.Fatal("used request policy in transaction")
		return allowed, nil
	}, func(_ context.Context, actual store.TeamWriteScope, got model.Principal) (model.CredentialAuthorization, error) {
		if actual != scope || got != p {
			t.Fatal("wrong transaction or principal")
		}
		calls++
		if calls <= 1 {
			return allowed, nil
		}
		return revoked, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.ops.credential = func(context.Context, store.IdentityDAO, store.CredentialFamilyDAO, model.Principal, string, time.Time) error {
		return nil
	}
	_, err = svc.ResolveMember(context.Background(), p, teamFixtureID, core.ResolveTeamMember{ExpectedUserID: p.UserID, ExternalUserID: "external"})
	teamFault(t, err, "insufficient_scope")
	if calls != 2 || scope.resolves != 1 {
		t.Fatalf("checks=%d resolves=%d", calls, scope.resolves)
	}
}
func TestScopedAssemblyRejectsMissingProvidersAndWrongIdentity(t *testing.T) {
	if _, err := NewScopedTeams(nil, nil, nil); err == nil {
		t.Fatal("missing providers accepted")
	}
	if _, err := NewScopedDirectMembers(nil, nil, "", nil, nil); err == nil {
		t.Fatal("missing providers accepted")
	}
	p := model.Principal{Kind: model.PATCredential, UserID: teamFixtureActor, CredentialID: teamFixtureTarget}
	wrong := p
	wrong.UserID = teamFixtureTarget
	err := scopeCheck(func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
		return scopedAuth(t, wrong, "team:read"), nil
	})(context.Background(), p, scopepolicy.TeamRead)
	if err == nil || errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatal("mismatched identity accepted or misclassified")
	}
}

func TestAddMemberChecksFullResponseBeforeIdentityCreation(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: teamFixtureActor, CredentialID: teamFixtureTarget}
	scope := &guardedTeamWriteScope{team: fixtureTeam()}
	writer := guardedTeamWriter{scope: scope}
	calls, ensures := 0, 0
	current := scopedAuth(t, p, "team:members")
	svc, err := NewScopedDirectMembers(writer, func(context.Context, model.User) (model.User, error) { ensures++; return model.User{}, nil }, "", func(context.Context, model.Principal) (model.CredentialAuthorization, error) { return current, nil }, func(_ context.Context, actual store.TeamWriteScope, got model.Principal) (model.CredentialAuthorization, error) {
		calls++
		if actual != scope || got != p {
			t.Fatal("wrong scope or principal")
		}
		return current, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.ops.credential = func(context.Context, store.IdentityDAO, store.CredentialFamilyDAO, model.Principal, string, time.Time) error {
		return nil
	}
	_, err = svc.AddMember(context.Background(), p, teamFixtureID, core.AddTeamMember{ExpectedUserID: p.UserID, User: model.User{UniAuthID: "target"}, Role: model.ProjectMemberRole})
	teamFault(t, err, "insufficient_scope")
	if ensures != 0 || calls != 1 {
		t.Fatalf("ensure=%d authorization=%d", ensures, calls)
	}
}

type acceptanceData struct {
	invitation model.TeamInvitation
	team       model.TeamRef
	writes     int
}
type acceptanceReader struct {
	store.TeamReader
	data *acceptanceData
}

func (r acceptanceReader) TeamInvitation(context.Context, []byte) (model.TeamInvitation, error) {
	return r.data.invitation, nil
}

type acceptanceWriter struct {
	store.TeamWriteDAO
	data *acceptanceData
}

func (w acceptanceWriter) LockInvitation(context.Context, []byte) (model.TeamInvitation, error) {
	return w.data.invitation, nil
}
func (w acceptanceWriter) InvitationTeam(context.Context) (model.TeamRef, error) {
	return w.data.team, nil
}
func (w acceptanceWriter) InvitationMember(context.Context, string) (model.TeamMember, error) {
	return model.TeamMember{}, model.ErrNotFound
}
func (w acceptanceWriter) AddMember(_ context.Context, user string, role model.ProjectRole) (model.TeamMember, error) {
	w.data.writes++
	return model.TeamMember{TeamID: w.data.team.ID, UserID: user, Role: role}, nil
}
func (w acceptanceWriter) ConsumeInvitation(context.Context, string, string, time.Time) error {
	w.data.writes++
	return nil
}

type acceptanceSnapshot struct {
	store.SnapshotScope
	data *acceptanceData
}

func (s acceptanceSnapshot) TeamDAO() store.TeamReader { return acceptanceReader{data: s.data} }

type acceptanceWrite struct {
	store.TeamWriteScope
	data *acceptanceData
}

func (s acceptanceWrite) TeamDAO() store.TeamWriteDAO                 { return acceptanceWriter{data: s.data} }
func (s acceptanceWrite) EligibilityDAO() store.WebhookEligibilityDAO { return nil }

type acceptanceBackend struct {
	store.TeamWriter
	store.SnapshotReader
	data *acceptanceData
}

func (b acceptanceBackend) ReadSnapshot(_ context.Context, cb func(store.SnapshotScope) error) error {
	return cb(acceptanceSnapshot{data: b.data})
}
func (b acceptanceBackend) WriteTeam(_ context.Context, _ string, cb func(store.TeamWriteScope) error) (store.Completion, error) {
	err := cb(acceptanceWrite{data: b.data})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestScopedInvitationAcceptanceReceiptAndFullResponse(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: teamFixtureActor, CredentialID: teamFixtureTarget}
	name := "Team"
	now := time.Now()
	data := &acceptanceData{team: model.TeamRef{ID: teamFixtureID, Kind: "ordinary", Name: &name}, invitation: model.TeamInvitation{ID: teamFixtureInvitation, TeamID: teamFixtureID, ExpiresAt: now.Add(time.Hour)}}
	auth := scopedAuth(t, p, "team:invitation-accept")
	svc, err := NewScopedTeams(acceptanceBackend{data: data}, func(_ context.Context, got model.Principal) (model.CredentialAuthorization, error) {
		if got != p {
			t.Fatal("wrong principal")
		}
		return auth, nil
	}, func(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error) {
		t.Fatal("unexpected snapshot authorization")
		return model.CredentialAuthorization{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.core.refreshEligibility = func(context.Context, store.WebhookEligibilityDAO, store.WebhookEligibilityFilter) error { return nil }
	secret := secretutil.Random("dnteam_")
	_, err = svc.AcceptInvitation(context.Background(), p, secret, p.UserID)
	teamFault(t, err, "insufficient_scope")
	if data.writes != 0 {
		t.Fatal("full response wrote without invitation-read")
	}
	receipt, err := svc.AcceptInvitationReceipt(context.Background(), p, secret, p.UserID)
	if err != nil || receipt.TeamID != teamFixtureID || !receipt.Joined || !receipt.Consumed || data.writes != 2 {
		t.Fatalf("receipt=%+v writes=%d err=%v", receipt, data.writes, err)
	}
	_, err = svc.AcceptInvitationReceipt(context.Background(), p, "bad-secret", p.UserID)
	if err == nil || data.writes != 2 {
		t.Fatal("invalid secret accepted or wrote")
	}
	_, err = svc.AcceptInvitationReceipt(context.Background(), p, secret, teamFixtureTarget)
	if err == nil || data.writes != 2 {
		t.Fatal("identity mismatch accepted or wrote")
	}
}

func TestScopedServiceConstructionAndRequestAdmission(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: teamFixtureActor, CredentialID: teamFixtureTarget}
	auth := scopedAuth(t, p, "team:read")
	request := func(context.Context, model.Principal) (model.CredentialAuthorization, error) { return auth, nil }
	snapshot := func(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error) {
		return auth, nil
	}
	app, err := NewScopedAppTeams(nil, request, snapshot)
	if err != nil || !app.ScopeProtected() {
		t.Fatalf("protected app: %v", err)
	}
	if _, err := NewScopedAppTeams(nil, nil, snapshot); err == nil {
		t.Fatal("missing request provider accepted")
	}
	var noTeams *Teams
	if noTeams.ScopeProtected() || NewTeams(nil).ScopeProtected() {
		t.Fatal("legacy service reported protected")
	}
	var noMembers *DirectMembers
	if noMembers.ScopeProtected() || NewDirectMembers(nil, nil, "").ScopeProtected() {
		t.Fatal("legacy direct service reported protected")
	}
	protected, err := NewScopedDirectMembers(nil, nil, "", request, func(context.Context, store.TeamWriteScope, model.Principal) (model.CredentialAuthorization, error) {
		return auth, nil
	})
	if err != nil || !protected.ScopeProtected() {
		t.Fatalf("protected direct service: %v", err)
	}
	var legacy *scopeAdmission
	if err := legacy.require(context.Background(), p, scopepolicy.TeamRead); err != nil {
		t.Fatal(err)
	}
	admission := &scopeAdmission{request: request}
	if err := admission.require(context.Background(), p, scopepolicy.TeamRead); err != nil {
		t.Fatal(err)
	}
	teamFault(t, admission.require(context.Background(), p, scopepolicy.TeamWrite), "insufficient_scope")
	failure := errors.New("authorization unavailable")
	admission.request = func(context.Context, model.Principal) (model.CredentialAuthorization, error) {
		return model.CredentialAuthorization{}, failure
	}
	if err := admission.require(context.Background(), p, scopepolicy.TeamRead); !errors.Is(err, failure) {
		t.Fatalf("provider error: %v", err)
	}
}
