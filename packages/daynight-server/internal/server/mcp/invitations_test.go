package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const invitationTestTeamID = "00000000-0000-4000-8000-000000000001"
const invitationTestProjectID = "00000000-0000-4000-8000-000000000002"

type invitationTestTeams struct {
	minted               teamcore.MintedTeamInvitation
	page                 teamcore.InvitationPage
	inspection           teamcore.TeamInvitationInspection
	acceptance           teamcore.TeamInvitationAcceptance
	changed              bool
	err                  error
	calls                int
	lastID, lastExpected string
	request              model.PageRequest
}

func (s *invitationTestTeams) CreateInvitation(_ context.Context, p model.Principal, id, expected string) (teamcore.MintedTeamInvitation, error) {
	s.calls++
	s.lastID, s.lastExpected = id, expected
	return s.minted, s.err
}
func (s *invitationTestTeams) ListInvitationPage(_ context.Context, p model.Principal, id string, request model.PageRequest) (teamcore.InvitationPage, error) {
	s.calls++
	s.lastID, s.request = id, request
	return s.page, s.err
}
func (s *invitationTestTeams) RevokeInvitation(_ context.Context, p model.Principal, id, invitation, expected string) (bool, error) {
	s.calls++
	s.lastID, s.lastExpected = id, expected
	return s.changed, s.err
}
func (s *invitationTestTeams) InspectInvitation(_ context.Context, p model.Principal, secret string) (teamcore.TeamInvitationInspection, error) {
	s.calls++
	s.lastID = secret
	return s.inspection, s.err
}
func (s *invitationTestTeams) AcceptInvitation(_ context.Context, p model.Principal, secret, expected string) (teamcore.TeamInvitationAcceptance, error) {
	s.calls++
	s.lastID, s.lastExpected = secret, expected
	return s.acceptance, s.err
}

type invitationTestProjects struct {
	inspection               projectcore.InvitationInspection
	acceptance               projectcore.InvitationAcceptance
	err                      error
	calls                    int
	lastSecret, lastExpected string
}

func (s *invitationTestProjects) InspectInvitation(_ context.Context, p model.Principal, secret string) (projectcore.InvitationInspection, error) {
	s.calls++
	s.lastSecret = secret
	return s.inspection, s.err
}
func (s *invitationTestProjects) AcceptInvitation(_ context.Context, p model.Principal, secret, expected string) (projectcore.InvitationAcceptance, error) {
	s.calls++
	s.lastSecret, s.lastExpected = secret, expected
	return s.acceptance, s.err
}

func invitationCall(t *testing.T, client *sdk.ClientSession, name string, args any, wantError bool) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil || result.IsError != wantError {
		t.Fatalf("%s: tool error=%v transport error=%v", name, result != nil && result.IsError, err)
	}
	return structured(t, result)
}

func TestInvitationToolsAdaptServices(t *testing.T) {
	fixture := newEntryFixture(t)
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	teamSecret, projectSecret := "dnteam_"+strings.Repeat("A", 43), "dninvite_"+strings.Repeat("A", 43)
	name := "Team"
	member := model.TeamMember{TeamID: invitationTestTeamID, UserID: "alice", Role: model.ProjectAdmin, Version: 9007199254740993, CreatedAt: now, UpdatedAt: now}
	grant := model.ProjectGrant{ProjectID: invitationTestProjectID, UserID: "alice", Role: model.ProjectAdmin, Version: 9007199254740993, CreatedAt: now, UpdatedAt: now}
	access := model.ProjectAccess{ProjectID: invitationTestProjectID, Role: model.ProjectAdmin, DirectGrant: &grant, Ownership: model.ProjectOwnership{TeamID: invitationTestTeamID, Version: 7}, OwnerTeam: model.TeamRef{ID: invitationTestTeamID, Kind: "ordinary", Name: &name}}
	team := &invitationTestTeams{
		minted:     teamcore.MintedTeamInvitation{Invitation: model.TeamInvitation{ID: invitationTestProjectID, TeamID: invitationTestTeamID, CreatedBy: "alice", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, Secret: teamSecret},
		inspection: teamcore.TeamInvitationInspection{Team: model.TeamRef{ID: invitationTestTeamID, Kind: "ordinary", Name: &name}, Membership: &member},
		acceptance: teamcore.TeamInvitationAcceptance{Team: model.TeamRef{ID: invitationTestTeamID, Kind: "ordinary", Name: &name}, Membership: member, Joined: true, Consumed: true}, changed: true,
	}
	project := &invitationTestProjects{inspection: projectcore.InvitationInspection{ProjectID: invitationTestProjectID, ProjectName: "Project", DirectGrant: &grant, Access: &access}, acceptance: projectcore.InvitationAcceptance{ProjectID: invitationTestProjectID, DirectGrant: grant, Access: access, Joined: true, Consumed: true}}
	if err := RegisterInvitationTools(fixture.entry, &identity.Identity{}, team, project, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	created := object(t, invitationCall(t, client, "team_invitation_create", map[string]any{"team": invitationTestTeamID, "confirm": true}, false)["data"])
	if created["link"] != "https://daynight.test/team-invitations#"+teamSecret || team.lastExpected != "alice" || team.lastID != invitationTestTeamID {
		t.Fatal("incorrect create receipt or actor")
	}
	teamLink := "https://daynight.test/team-invitations#" + teamSecret
	projectLink := "https://daynight.test/invitations#" + projectSecret
	for _, tc := range []struct{ scope, link string }{{"team", teamLink}, {"project", projectLink}} {
		out := invitationCall(t, client, "invitation_inspect", map[string]any{"link": tc.link}, false)
		data := object(t, out["data"])
		if data["scope"] != tc.scope {
			t.Fatalf("inspect scope: %#v", data)
		}
		if tc.scope == "team" {
			if object(t, data["membership"])["version"] != "9007199254740993" || team.lastID != teamSecret {
				t.Fatal("incorrect Team inspection")
			}
		} else if object(t, data["directGrant"])["version"] != "9007199254740993" || object(t, data["access"])["projectId"] != invitationTestProjectID || project.lastSecret != projectSecret {
			t.Fatal("incorrect Project inspection")
		}
		out = invitationCall(t, client, "invitation_accept", map[string]any{"link": tc.link, "confirm": true}, false)
		data = object(t, out["data"])
		if data["scope"] != tc.scope || data["joined"] != true || data["consumed"] != true || object(t, out["meta"])["outcome"] != "changed" {
			t.Fatalf("accept %s: %#v", tc.scope, data)
		}
	}
	if team.lastExpected != "alice" || project.lastExpected != "alice" {
		t.Fatal("acceptance actor was not authenticated user")
	}
	team.acceptance.Joined, team.acceptance.Consumed = false, false
	project.acceptance.Joined, project.acceptance.Consumed = false, false
	for _, link := range []string{teamLink, projectLink} {
		out := invitationCall(t, client, "invitation_accept", map[string]any{"link": link, "confirm": true}, false)
		if object(t, out["meta"])["outcome"] != "unchanged" {
			t.Fatal("existing member outcome was not unchanged")
		}
	}
	for _, changed := range []bool{true, false} {
		team.changed = changed
		out := invitationCall(t, client, "team_invitation_revoke", map[string]any{"team": invitationTestTeamID, "invitationId": invitationTestProjectID, "confirm": true}, false)
		data := object(t, out["data"])
		if data["changed"] != changed || data["teamId"] != invitationTestTeamID || data["invitationId"] != invitationTestProjectID {
			t.Fatal("incorrect revoke receipt")
		}
	}
	team.err = &model.Fault{Code: "forbidden", Message: "denied"}
	for _, call := range []struct {
		name string
		args map[string]any
	}{
		{"team_invitation_create", map[string]any{"team": invitationTestTeamID, "confirm": true}},
		{"team_invitation_list", map[string]any{"team": invitationTestTeamID}},
		{"team_invitation_revoke", map[string]any{"team": invitationTestTeamID, "invitationId": invitationTestProjectID, "confirm": true}},
		{"invitation_inspect", map[string]any{"link": teamLink}},
		{"invitation_accept", map[string]any{"link": teamLink, "confirm": true}},
	} {
		out := invitationCall(t, client, call.name, call.args, true)
		if object(t, out["error"])["code"] != "forbidden" {
			t.Fatalf("%s did not propagate denial", call.name)
		}
	}
	project.err = &model.Fault{Code: "invitation_unavailable", Message: "Invitation is unavailable."}
	for _, call := range []struct {
		name string
		args map[string]any
	}{{"invitation_inspect", map[string]any{"link": projectLink}}, {"invitation_accept", map[string]any{"link": projectLink, "confirm": true}}} {
		out := invitationCall(t, client, call.name, call.args, true)
		if object(t, out["error"])["code"] != "invitation_unavailable" {
			t.Fatalf("%s did not propagate refusal", call.name)
		}
	}
	calls := team.calls + project.calls
	for _, link := range []string{"https://other.test/team-invitations#" + teamSecret, "https://daynight.test/invitations#" + teamSecret, teamLink + "?extra", strings.Repeat("a", 4097)} {
		out := invitationCall(t, client, "invitation_inspect", map[string]any{"link": link}, true)
		if object(t, out["error"])["code"] != "invalid_input" {
			t.Fatal("bad link was not rejected")
		}
	}
	if team.calls+project.calls != calls {
		t.Fatal("invalid link reached service")
	}
}

func TestInvitationPagePreservesCountAndCursor(t *testing.T) {
	fixture := newEntryFixture(t)
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	team := &invitationTestTeams{}
	for i := 1; i <= 100; i++ {
		team.page.Items = append(team.page.Items, model.TeamInvitation{ID: fmt.Sprintf("%08x-0000-4000-8000-%012x", i, i), TeamID: invitationTestTeamID, CreatedBy: invitationTestProjectID, CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	}
	if err := RegisterInvitationTools(fixture.entry, &identity.Identity{}, team, &invitationTestProjects{}, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	client := fixture.client(t, "2026-07-28", "alice")
	out := invitationCall(t, client, "team_invitation_list", map[string]any{"team": invitationTestTeamID, "limit": 100}, false)
	page := object(t, out["data"])
	items := page["items"].([]any)
	if len(items) != 100 || team.request.Limit != 100 {
		t.Fatalf("expected count page, got %d", len(items))
	}
	if page["nextCursor"] != nil {
		t.Fatal("complete page has a cursor")
	}
	team.page.Items = nil
	invitationCall(t, client, "team_invitation_list", map[string]any{"team": invitationTestTeamID}, false)
	if team.request.Limit != 50 {
		t.Fatal("default page limit was not applied")
	}
	adapter := invitationAdapter{teams: team}
	actor := RequestActor{Principal: model.Principal{UserID: "alice"}}
	for _, handler := range []func(context.Context, RequestActor, invitationInput) (ToolResult, error){adapter.create, adapter.list, adapter.revoke} {
		if _, err := handler(t.Context(), actor, invitationInput{Team: "bad"}); err == nil {
			t.Fatal("invalid Team ID accepted")
		}
	}
	if err := RegisterInvitationTools(fixture.entry, nil, team, &invitationTestProjects{}, "https://daynight.test"); err == nil {
		t.Fatal("missing identity accepted")
	}
	if _, _, err := adapter.parseLink("invalid"); err == nil {
		t.Fatal("invalid link accepted")
	}
}

type mcpOrgIdentityDAO struct {
	store.IdentityDAO
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
	personalReads := mcpOrgCount(t, wantPersonalReads)
	tx.WriteIdentityCall = func(ctx context.Context, op func(store.IdentityScope) error) (store.Completion, error) {
		d := &mcpOrgIdentityDAO{IdentityDAO: nil}
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
			personalReads()
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

// Each lookup and consume callback has its own call plan, including separate
// read and locked-read expectations for the same invitation.
func mcpOrgInvitationLookup[T any](t *testing.T, value T, token string) func(context.Context, []byte) (T, error) {
	called := mcpOrgCount(t, 1)
	return func(_ context.Context, hash []byte) (T, error) {
		called()
		projectHTTPCheck(t, hash, secret.Hash(token))
		return value, nil
	}
}
func mcpOrgConsumeInvitation(t *testing.T, called func(), id, user string, createdAt time.Time, label string) func(context.Context, string, string, time.Time) error {
	return func(_ context.Context, gotID, gotUser string, now time.Time) error {
		called()
		projectHTTPCheck(t, []string{gotID, gotUser}, []string{id, user})
		if now.Before(createdAt) || now.Location() != time.UTC {
			unexpectedHTTPCall(t, label)
		}
		return nil
	}
}
func mcpOrgInspectTeam(t *testing.T, tx *httpTestStore, actor model.Principal, team model.TeamRef, v model.TeamInvitation, token string, membership *model.TeamMember) {
	t.Helper()
	readTeam, readMember := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamInvitationCall: mcpOrgInvitationLookup(t, v, token), InvitationTeamCall: func(ctx context.Context, id string) (model.TeamRef, error) {
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
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamInvitationCall: mcpOrgInvitationLookup(t, v, token)})
}
func mcpOrgAcceptTeam(t *testing.T, tx *httpTestStore, actor model.Principal, team model.TeamRef, v model.TeamInvitation, token string, result model.TeamMember, existing bool) {
	t.Helper()
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamInvitationCall: mcpOrgInvitationLookup(t, v, token)})
	ref, member := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	dao := mcpOrgTeamWriter{LockInvitationCall: mcpOrgInvitationLookup(t, v, token), InvitationTeamCall: func(ctx context.Context) (model.TeamRef, error) { ref(); return team, nil }, InvitationMemberCall: func(ctx context.Context, user string) (model.TeamMember, error) {
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
		dao.ConsumeInvitationCall = mcpOrgConsumeInvitation(t, consume, v.ID, actor.UserID, v.CreatedAt, "Team invitation consumption timestamp")
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
	readProject, access := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	mcpOrgRead(t, tx, 1, mcpOrgProjectReader{InvitationCall: mcpOrgInvitationLookup(t, v, token), ProjectCall: func(ctx context.Context, id string) (model.Project, error) {
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
	mcpOrgRead(t, tx, 1, mcpOrgProjectReader{InvitationCall: mcpOrgInvitationLookup(t, v, token)}, nil)
}
func mcpOrgAcceptProject(t *testing.T, tx *httpTestStore, actor model.Principal, project model.Project, v model.ProjectInvitation, token string, result model.ProjectMember, existing bool) {
	t.Helper()
	mcpOrgRead(t, tx, 1, mcpOrgProjectReader{InvitationCall: mcpOrgInvitationLookup(t, v, token)}, nil)
	member, access := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	dao := mcpOrgProjectWriter{LockInvitationCall: mcpOrgInvitationLookup(t, v, token), DirectProjectMemberCall: func(ctx context.Context, user string) (model.ProjectMember, error) {
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
		dao.ConsumeInvitationCall = mcpOrgConsumeInvitation(t, consume, v.ID, actor.UserID, v.CreatedAt, "Project invitation consumption time")
	}
	mcpOrgWriteProject(t, tx, project.ID, dao, mcpOrgNoEligibility(t, store.WebhookEligibilityFilter{ProjectID: project.ID, UserID: actor.UserID}))
}

func (d mcpOrgTeamReader) TeamAccess(ctx context.Context, user, id string) error {
	return requireCallback(d.t, "MCP DAO TeamAccessCall", d.TeamAccessCall)(ctx, user, id)
}
func (d mcpOrgTeamReader) TeamMembersPage(ctx context.Context, id string, page store.Page) (store.TeamMemberPage, error) {
	return requireCallback(d.t, "MCP DAO TeamMembersPageCall", d.TeamMembersPageCall)(ctx, id, page)
}

func (d mcpOrgTeamWriter) Rename(ctx context.Context, user, name string) (model.Team, error) {
	return requireCallback(d.t, "MCP DAO RenameCall", d.RenameCall)(ctx, user, name)
}
func (d mcpOrgTeamWriter) HasProjects(ctx context.Context) (bool, error) {
	return requireCallback(d.t, "MCP DAO HasProjectsCall", d.HasProjectsCall)(ctx)
}
func (d mcpOrgTeamWriter) Member(ctx context.Context, user string) (model.TeamMember, error) {
	return requireCallback(d.t, "MCP DAO MemberCall", d.MemberCall)(ctx, user)
}
func (d mcpOrgTeamWriter) AdminCount(ctx context.Context) (int64, error) {
	return requireCallback(d.t, "MCP DAO AdminCountCall", d.AdminCountCall)(ctx)
}
func (d mcpOrgTeamWriter) SetMemberRole(ctx context.Context, user string, role model.ProjectRole) (model.TeamMember, error) {
	return requireCallback(d.t, "MCP DAO SetMemberRoleCall", d.SetMemberRoleCall)(ctx, user, role)
}
func (d mcpOrgTeamWriter) RemoveMember(ctx context.Context, user string) error {
	return requireCallback(d.t, "MCP DAO RemoveMemberCall", d.RemoveMemberCall)(ctx, user)
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

type invitationLog struct {
	mu sync.Mutex
	bytes.Buffer
}

func (l *invitationLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.Buffer.Write(p)
}
func (l *invitationLog) text() string { l.mu.Lock(); defer l.mu.Unlock(); return l.Buffer.String() }

// lostAcceptanceTransport waits for the server response, then loses the receipt.
// This models a transport failure after a possibly committed operation.
type lostAcceptanceTransport struct {
	token string
	calls atomic.Int32
}

func (tr *lostAcceptanceTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+tr.token)
	var input struct {
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if req.Body != nil {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		_ = json.Unmarshal(body, &input)
	}
	if input.Method != "tools/call" || input.Params.Name != "invitation_accept" {
		return http.DefaultTransport.RoundTrip(r)
	}
	tr.calls.Add(1)
	resp, err := http.DefaultTransport.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	_, readErr := io.Copy(io.Discard, resp.Body)
	closeErr := resp.Body.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return nil, errors.New("acceptance response lost")
}

func callInvitationTool(t *testing.T, client *sdk.ClientSession, name string, args map[string]any, wantError bool) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s call: %v", name, err)
	}
	if result.IsError != wantError {
		t.Fatalf("%s: unexpected error state %v", name, result.IsError)
	}
	encoded, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	if wantError {
		if link, ok := args["link"].(string); ok {
			parts := strings.SplitN(link, "#", 2)
			if strings.Contains(string(encoded), link) || (len(parts) == 2 && parts[1] != "" && strings.Contains(string(encoded), parts[1])) {
				t.Fatal("invitation secret appeared in an error response")
			}
		}
	}
	var envelope map[string]any
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatal(err)
	}
	key := "data"
	if wantError {
		key = "error"
	}
	value, ok := envelope[key].(map[string]any)
	if !ok {
		t.Fatalf("%s returned no %s object", name, key)
	}
	return value
}

func TestMCPInvitationWorkflow(t *testing.T) {
	admin := defaultHTTPPrincipal()
	member := model.Principal{UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444", Kind: model.PATCredential}
	tokens := []string{defaultHTTPToken(), "dnpat_" + strings.Repeat("B", 42) + "A"}
	tx := newHTTPTestStore(t)
	mcpOrgAuthenticate(t, tx, []model.Principal{admin, member}, tokens, []string{"e1111111-1111-4111-8111-111111111111", "e2222222-2222-4222-8222-222222222222"}, 0)
	logs := &invitationLog{}
	server, _ := newMCPHTTPServer(t, tx, logs)
	origin := server.URL
	clients := []*sdk.ClientSession{mcpPATClient(t, origin, tokens[0]), mcpPATClient(t, origin, tokens[1])}
	team := mcpOrgTeam(t, "e5555555-5555-4555-8555-555555555555", "Invitation Team", admin.UserID)
	otherTeam := mcpOrgTeam(t, "f6666666-6666-4666-8666-666666666666", "Other Team", admin.UserID)
	args := map[string]any{"team": team.ID, "confirm": true}
	created := make([]map[string]any, 0, 3)
	links := make([]string, 0, 3)
	invitations := make([]model.TeamInvitation, 0, 3)
	for range 3 {
		captured := mcpOrgMintInvitation(t, tx, admin, team)
		item := callInvitationTool(t, clients[0], "team_invitation_create", args, false)
		link, ok := item["link"].(string)
		if !ok || !strings.HasPrefix(link, origin+"/team-invitations#dnteam_") {
			t.Fatal("invalid created Team invitation link")
		}
		token := strings.Split(link, "#")[1]
		projectHTTPCheck(t, captured.TokenHash, secret.Hash(token))
		projectHTTPCheck(t, item["id"], captured.ID)
		created = append(created, item)
		links = append(links, link)
		invitations = append(invitations, model.TeamInvitation{ID: captured.ID, TeamID: team.ID, CreatedBy: admin.UserID, TokenHash: secret.Hash(token), CreatedAt: captured.CreatedAt, ExpiresAt: captured.CreatedAt.Add(7 * 24 * time.Hour)})
	}
	tx.WriteTeamCall = nil
	callInvitationTool(t, clients[0], "team_invitation_create", map[string]any{"team": team.ID}, true)
	seen := map[string]bool{}
	var cursor any
	for i := range 3 {
		query, read := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
		wantPage := store.Page{Limit: 1}
		if i > 0 {
			wantPage.After = &store.Position{CreatedAt: invitations[i-1].CreatedAt, ID: invitations[i-1].ID}
		}
		row := invitations[i]
		mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamCall: func(ctx context.Context, user, id string) (model.Team, error) {
			read()
			projectHTTPCheck(t, []string{user, id}, []string{admin.UserID, team.ID})
			return team, nil
		}, TeamInvitationPageCall: func(ctx context.Context, id string, now time.Time, page store.Page) (store.TeamInvitationPage, error) {
			query()
			projectHTTPCheck(t, id, team.ID)
			projectHTTPCheck(t, page, wantPage)
			if now.IsZero() || now.Location() != time.UTC {
				unexpectedHTTPCall(t, "Team invitation page time")
			}
			return store.TeamInvitationPage{Items: []model.TeamInvitation{row}, HasMore: i < 2}, nil
		}})
		pageArgs := map[string]any{"team": team.ID, "limit": 1}
		if cursor != nil {
			pageArgs["cursor"] = cursor
		}
		page := callInvitationTool(t, clients[0], "team_invitation_list", pageArgs, false)
		encoded, _ := json.Marshal(page)
		for _, link := range links {
			if strings.Contains(string(encoded), link) || strings.Contains(string(encoded), strings.Split(link, "#")[1]) {
				t.Fatal("invitation list exposed secret")
			}
		}
		items, ok := page["items"].([]any)
		if !ok || len(items) != 1 {
			t.Fatalf("expected one item per page, got %d", len(items))
		}
		item, ok := items[0].(map[string]any)
		if !ok {
			t.Fatal("invalid page item")
		}
		id, _ := item["id"].(string)
		if id == "" || seen[id] {
			t.Fatal("missing or repeated invitation")
		}
		projectHTTPCheck(t, id, row.ID)
		seen[id] = true
		if _, ok := item["link"]; ok {
			t.Fatal("list returned link")
		}
		if _, ok := item["secret"]; ok {
			t.Fatal("list returned secret")
		}
		cursor = page["nextCursor"]
		if i == 0 {
			if cursor == nil {
				t.Fatal("missing next cursor")
			}
			mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{})
			callInvitationTool(t, clients[0], "team_invitation_list", map[string]any{"team": otherTeam.ID, "limit": 1, "cursor": cursor}, true)
		}
	}
	if cursor != nil {
		t.Fatal("unexpected final cursor")
	}
	for _, item := range created {
		if !seen[item["id"].(string)] {
			t.Fatal("page omitted invitation")
		}
	}
	tx.ReadSnapshotCall = nil
	for _, bad := range []string{strings.Replace(links[0], origin, "https://other.invalid", 1), links[0] + "?query", " " + links[0], strings.Replace(links[0], "/team-invitations", "/x/../team-invitations", 1)} {
		callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": bad}, true)
	}
	token := strings.Split(links[0], "#")[1]
	mcpOrgInspectTeam(t, tx, member, team.TeamRef, invitations[0], token, nil)
	preview := callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": links[0]}, false)
	if preview["scope"] != "team" || preview["membership"] != nil {
		t.Fatal("Team preview did not describe the nonmember")
	}
	tx.ReadSnapshotCall = nil
	tx.WriteTeamCall = nil
	callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": links[0]}, true)
	joinedMember := model.TeamMember{TeamID: team.ID, UserID: member.UserID, Role: model.ProjectMemberRole, Version: 1, CreatedAt: team.CreatedAt, UpdatedAt: team.UpdatedAt}
	mcpOrgAcceptTeam(t, tx, member, team.TeamRef, invitations[0], token, joinedMember, false)
	accepted := callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": links[0], "confirm": true}, false)
	if accepted["scope"] != "team" || accepted["joined"] != true || accepted["consumed"] != true {
		t.Fatal("Team acceptance did not report joining and consumption")
	}
	consumedAt := time.Now().UTC()
	consumed := invitations[0]
	consumed.ConsumedAt = &consumedAt
	consumed.ConsumedBy = &member.UserID
	mcpOrgUnavailableTeamInvitation(t, tx, consumed, token)
	tx.WriteTeamCall = nil
	callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": links[0], "confirm": true}, true)
	token = strings.Split(links[1], "#")[1]
	mcpOrgAcceptTeam(t, tx, admin, team.TeamRef, invitations[1], token, team.Membership, true)
	existing := callInvitationTool(t, clients[0], "invitation_accept", map[string]any{"link": links[1], "confirm": true}, false)
	if existing["joined"] != false || existing["consumed"] != false {
		t.Fatal("existing Team member consumed invitation")
	}
	revokeArgs := map[string]any{"team": team.ID, "invitationId": created[1]["id"], "confirm": true}
	mcpOrgRevokeInvitation(t, tx, admin, team, invitations[1].ID, true)
	if callInvitationTool(t, clients[0], "team_invitation_revoke", revokeArgs, false)["changed"] != true {
		t.Fatal("revoke did not change invitation")
	}
	mcpOrgRevokeInvitation(t, tx, admin, team, invitations[1].ID, false)
	if callInvitationTool(t, clients[0], "team_invitation_revoke", revokeArgs, false)["changed"] != false {
		t.Fatal("repeat revoke was not unchanged")
	}
	revoked := invitations[1]
	revoked.RevokedAt = &consumedAt
	mcpOrgUnavailableTeamInvitation(t, tx, revoked, token)
	callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": links[1]}, true)
	expired := invitations[2]
	expired.CreatedAt = consumedAt.Add(-2 * time.Second)
	expired.ExpiresAt = consumedAt.Add(-time.Second)
	mcpOrgUnavailableTeamInvitation(t, tx, expired, strings.Split(links[2], "#")[1])
	callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": links[2]}, true)

	rows := make([]model.TeamInvitation, 100)
	for i := range rows {
		rows[i] = model.TeamInvitation{ID: fmt.Sprintf("%08x-aaaa-4aaa-8aaa-aaaaaaaaaaaa", i+1), TeamID: team.ID, CreatedBy: admin.UserID, CreatedAt: team.CreatedAt.Add(time.Duration(i) * time.Second), ExpiresAt: consumedAt.Add(24 * time.Hour)}
	}
	read, query := mcpOrgCount(t, 1), mcpOrgCount(t, 1)
	mcpOrgRead(t, tx, 1, nil, mcpOrgTeamReader{TeamCall: func(ctx context.Context, user, id string) (model.Team, error) {
		read()
		projectHTTPCheck(t, []string{user, id}, []string{admin.UserID, team.ID})
		return team, nil
	}, TeamInvitationPageCall: func(ctx context.Context, id string, now time.Time, page store.Page) (store.TeamInvitationPage, error) {
		query()
		projectHTTPCheck(t, id, team.ID)
		projectHTTPCheck(t, page, store.Page{Limit: 100})
		if now.IsZero() || now.Location() != time.UTC {
			unexpectedHTTPCall(t, "Team invitation page time")
		}
		return store.TeamInvitationPage{Items: rows}, nil
	}})
	page := callInvitationTool(t, clients[0], "team_invitation_list", map[string]any{"team": team.ID, "limit": 100}, false)
	items, ok := page["items"].([]any)
	if !ok || len(items) != len(rows) || page["nextCursor"] != nil {
		t.Fatalf("complete invitation page: %+v", page)
	}
	for i, value := range items {
		projectHTTPCheck(t, value.(map[string]any)["id"], rows[i].ID)
	}

	project := projectHTTPRecord("a7777777-7777-4777-8777-777777777777", "Invite Project", "https://example.test/owner/repo.git", "b8888888-8888-4888-8888-888888888888")
	projectToken := "dninvite_" + strings.Repeat("C", 42) + "A"
	invitation := model.ProjectInvitation{ID: "c9999999-9999-4999-8999-999999999999", ProjectID: project.ID, CreatedBy: admin.UserID, TokenHash: secret.Hash(projectToken), CreatedAt: team.CreatedAt, ExpiresAt: consumedAt.Add(24 * time.Hour)}
	projectLink := origin + "/invitations#" + projectToken
	grant := model.ProjectGrant{ProjectID: project.ID, UserID: admin.UserID, Role: model.ProjectAdmin, Version: 1, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt}
	mcpOrgAcceptProject(t, tx, admin, project, invitation, projectToken, model.ProjectMember{Grant: grant}, true)
	ownerReceipt := callInvitationTool(t, clients[0], "invitation_accept", map[string]any{"link": projectLink, "confirm": true}, false)
	if ownerReceipt["joined"] != false || ownerReceipt["consumed"] != false {
		t.Fatal("existing Project member consumed invitation")
	}
	mcpOrgInspectProject(t, tx, member, project, invitation, projectToken)
	projectPreview := callInvitationTool(t, clients[1], "invitation_inspect", map[string]any{"link": projectLink}, false)
	if projectPreview["scope"] != "project" || projectPreview["projectId"] != project.ID {
		t.Fatal("Project preview missing project identity")
	}
	grant.UserID = member.UserID
	grant.Role = model.ProjectMemberRole
	mcpOrgAcceptProject(t, tx, member, project, invitation, projectToken, model.ProjectMember{Grant: grant}, false)
	projectAccepted := callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": projectLink, "confirm": true}, false)
	if projectAccepted["scope"] != "project" || projectAccepted["projectId"] != project.ID || projectAccepted["joined"] != true || projectAccepted["consumed"] != true {
		t.Fatal("Project acceptance missing receipt")
	}
	consumedProject := invitation
	consumedProject.ConsumedBy = &member.UserID
	consumedProject.ConsumedAt = &consumedAt
	mcpOrgUnavailableProjectInvitation(t, tx, consumedProject, projectToken)
	tx.WriteProjectCall = nil
	callInvitationTool(t, clients[1], "invitation_accept", map[string]any{"link": projectLink, "confirm": true}, true)
	lostTeam := mcpOrgTeam(t, "d0000000-0000-4000-8000-000000000000", "Lost receipt Team", admin.UserID)
	lostToken := "dnteam_" + strings.Repeat("D", 42) + "A"
	lostInvitation := model.TeamInvitation{ID: "e0000000-0000-4000-8000-000000000000", TeamID: lostTeam.ID, CreatedBy: admin.UserID, TokenHash: secret.Hash(lostToken), CreatedAt: team.CreatedAt, ExpiresAt: consumedAt.Add(24 * time.Hour)}
	lostLink := origin + "/team-invitations#" + lostToken
	transport := &lostAcceptanceTransport{token: tokens[1]}
	sdkClient := sdk.NewClient(&sdk.Implementation{Name: "lost-receipt-test", Version: "1"}, nil)
	connectCtx, connectCancel := context.WithTimeout(t.Context(), 5*time.Second)
	lostClient, err := sdkClient.Connect(connectCtx, &sdk.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: transport}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	connectCancel()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lostClient.Close() })
	lostMember := joinedMember
	lostMember.TeamID = lostTeam.ID
	mcpOrgAcceptTeam(t, tx, member, lostTeam.TeamRef, lostInvitation, lostToken, lostMember, false)
	callCtx, callCancel := context.WithTimeout(t.Context(), 5*time.Second)
	_, callErr := lostClient.CallTool(callCtx, &sdk.CallToolParams{Name: "invitation_accept", Arguments: map[string]any{"link": lostLink, "confirm": true}})
	callCancel()
	if callErr == nil || transport.calls.Load() != 1 {
		t.Fatalf("lost receipt: error=%v calls=%d", callErr, transport.calls.Load())
	}
	links = append(links, lostLink)
	for _, link := range append(links, projectLink) {
		if strings.Contains(logs.text(), link) || strings.Contains(logs.text(), strings.Split(link, "#")[1]) {
			t.Fatal("invitation secret appeared in logs")
		}
	}
}
