package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type structClient struct {
	t      *testing.T
	client *sdk.ClientSession
}

func (c *structClient) call(name string, args any, wantError bool) map[string]any {
	c.t.Helper()
	return invitationCall(c.t, c.client, name, args, wantError)
}

type testScopedAuthenticator struct {
	policies map[string]model.CredentialAuthorization
}

type fixedScopedAuthenticator struct {
	authorization model.CredentialAuthorization
	authority     AuthorityRef
}

func (s fixedScopedAuthenticator) AuthenticateScoped(context.Context, model.CredentialKind, string, string) (model.CredentialAuthorization, AuthorityRef, error) {
	return s.authorization, s.authority, nil
}

func (s testScopedAuthenticator) AuthenticateScoped(_ context.Context, kind model.CredentialKind, token, resource string) (model.CredentialAuthorization, AuthorityRef, error) {
	a, ok := s.policies[token]
	if !ok || kind != a.Principal.Kind || resource != "https://daynight.test/mcp" {
		return model.CredentialAuthorization{}, AuthorityRef{}, model.Unauthenticated(nil)
	}
	if kind == model.OAuthCredential {
		return a, AuthorityRef{Kind: "oauth", ID: testTeamID}, nil
	}
	return a, AuthorityRef{Kind: "pat", ID: a.Principal.CredentialID}, nil
}

func scopedTestAuthorization(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	ids, err := scopepolicy.Normalize(scopepolicy.PAT, scopes)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: testUserID, CredentialID: testTargetID}, Profile: model.ScopedPATProfile, Policy: &policy}
}

type scopedProjectFixture struct {
	ScopedProjectOperations
	calls   []string
	visible bool
}

func (s *scopedProjectFixture) RegisterRepository(_ context.Context, a model.CredentialAuthorization, input coreproject.CreateProject, _ bool) (model.Project, bool, error) {
	s.calls = append(s.calls, "create")
	if err := scopeadmission.Require(a, scopepolicy.ProjectRead, scopepolicy.ProjectWrite); err != nil {
		return model.Project{}, false, err
	}
	return model.Project{ID: testProjectID, Name: input.Name}, true, nil
}
func (s *scopedProjectFixture) ResolveRepository(_ context.Context, a model.CredentialAuthorization, address string) (model.Project, error) {
	s.calls = append(s.calls, "resolve")
	if err := scopeadmission.Require(a, scopepolicy.ProjectRead); err != nil {
		return model.Project{}, err
	}
	project := sampleProject(testProjectID)
	project.RepoURL = address
	return project, nil
}
func (s *scopedProjectFixture) RepositoryPreview(_ context.Context, a model.CredentialAuthorization, id, _, _ string) (coreproject.RepositoryPreview, error) {
	s.calls = append(s.calls, "repository-preview")
	if err := scopeadmission.Require(a, scopepolicy.ProjectRepository); err != nil {
		return coreproject.RepositoryPreview{}, err
	}
	return coreproject.RepositoryPreview{ProjectID: id, ProjectName: "visible name"}, nil
}
func (s *scopedProjectFixture) SetRepository(_ context.Context, a model.CredentialAuthorization, id string, _ coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
	s.calls = append(s.calls, "repository-set")
	if err := scopeadmission.Require(a, scopepolicy.ProjectRepository); err != nil {
		return coreproject.RepositoryReceipt{}, err
	}
	return coreproject.RepositoryReceipt{ProjectID: id, Changed: true}, nil
}

func (s *scopedProjectFixture) Get(_ context.Context, a model.CredentialAuthorization, id string) (model.Project, error) {
	s.calls = append(s.calls, "get")
	if !s.visible {
		return model.Project{}, &model.Fault{Code: "not_found", Message: "not found"}
	}
	if err := scopeadmission.Require(a, scopepolicy.ProjectRead); err != nil {
		return model.Project{}, err
	}
	return sampleProject(id), nil
}
func (s *scopedProjectFixture) ListScoped(_ context.Context, a model.CredentialAuthorization, _ coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
	s.calls = append(s.calls, "list")
	if err := scopeadmission.Require(a, scopepolicy.ProjectRead); err != nil {
		return coreproject.ProjectPage{}, err
	}
	return coreproject.ProjectPage{Items: []model.Project{sampleProject(testProjectID)}}, nil
}
func (s *scopedProjectFixture) TransferPreviewWithName(_ context.Context, a model.CredentialAuthorization, _, _ string) (coreproject.TransferPreview, string, error) {
	s.calls = append(s.calls, "preview-name")
	if !s.visible {
		return coreproject.TransferPreview{}, "", &model.Fault{Code: "not_found", Message: "not found"}
	}
	if err := scopeadmission.Require(a, scopepolicy.ProjectTransfer); err != nil {
		return coreproject.TransferPreview{}, "", err
	}
	return coreproject.TransferPreview{SourceTeam: model.TeamRef{ID: testTeamID}, TargetTeam: model.TeamRef{ID: testTargetID}, Ownership: model.ProjectOwnership{TeamID: testTeamID, Version: 1}, TargetTeamVersion: 1}, "visible name", nil
}
func (s *scopedProjectFixture) TransferPreview(_ context.Context, a model.CredentialAuthorization, _, _ string) (coreproject.TransferPreview, error) {
	s.calls = append(s.calls, "preview")
	if err := scopeadmission.Require(a, scopepolicy.ProjectTransfer); err != nil {
		return coreproject.TransferPreview{}, err
	}
	return coreproject.TransferPreview{SourceTeam: model.TeamRef{ID: testTeamID}, Ownership: model.ProjectOwnership{TeamID: testTeamID, Version: 1}, TargetTeamVersion: 1}, nil
}
func (s *scopedProjectFixture) Transfer(_ context.Context, a model.CredentialAuthorization, _ string, _ coreproject.TransferInput) (coreproject.TransferReceipt, error) {
	s.calls = append(s.calls, "transfer")
	if err := scopeadmission.Require(a, scopepolicy.ProjectTransfer, scopepolicy.ProjectRead); err != nil {
		return coreproject.TransferReceipt{}, err
	}
	return coreproject.TransferReceipt{ProjectID: testProjectID}, nil
}

type scopedInvitationFixture struct{ calls []string }

func (s *scopedInvitationFixture) InspectInvitation(_ context.Context, a model.CredentialAuthorization, _ string) (coreproject.InvitationInspection, error) {
	s.calls = append(s.calls, "inspect")
	if err := scopeadmission.Require(a, scopepolicy.ProjectInvitationRead, scopepolicy.ProjectRead); err != nil {
		return coreproject.InvitationInspection{}, err
	}
	return coreproject.InvitationInspection{ProjectID: testProjectID, ProjectName: "visible name"}, nil
}
func (s *scopedInvitationFixture) AcceptInvitation(_ context.Context, a model.CredentialAuthorization, _, _ string) (coreproject.InvitationAcceptance, error) {
	s.calls = append(s.calls, "accept")
	if err := scopeadmission.Require(a, scopepolicy.ProjectInvitationAccept, scopepolicy.ProjectRead); err != nil {
		return coreproject.InvitationAcceptance{}, err
	}
	return coreproject.InvitationAcceptance{ProjectID: testProjectID, Joined: true}, nil
}

type scopedTeamFixture struct {
	teamOperations
	calls int
	err   error
}

func (s *scopedTeamFixture) Get(_ context.Context, _ model.Principal, _ string) (model.Team, error) {
	s.calls++
	return model.Team{}, s.err
}

func TestScopedProjectMCPAdmission(t *testing.T) {
	f := newEntryFixture(t)
	auth := testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{
		"read":          scopedTestAuthorization(t, "project:read"),
		"transfer":      scopedTestAuthorization(t, "project:transfer"),
		"transfer-read": scopedTestAuthorization(t, "project:read", "project:transfer"),
		"invite-read":   scopedTestAuthorization(t, "project:invitation-read", "project:read"),
		"invite-accept": scopedTestAuthorization(t, "project:invitation-accept", "project:read"),
		"team-only":     scopedTestAuthorization(t, "team:read"),
		"both":          scopedTestAuthorization(t, "project:read", "team:read"),
		"repository":    scopedTestAuthorization(t, "project:repository"),
		"create":        scopedTestAuthorization(t, "project:read", "project:write"),
	}}
	if err := f.entry.EnableScopedAuthentication(auth); err != nil {
		t.Fatal(err)
	}
	projects := &scopedProjectFixture{visible: true}
	invites := &scopedInvitationFixture{}
	teams := &scopedTeamFixture{}
	identity := &identityservice.Identity{}
	if err := RegisterScopedProjectTools(f.entry, projects, identity, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	if err := RegisterProjectScopedInvitationTools(f.entry, identity, &invitationTestTeams{}, invites, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	if err := RegisterProjectScopedTeamTools(f.entry, teams, projects, identity); err != nil {
		t.Fatal(err)
	}
	client := func(token string) *structClient { return &structClient{t: t, client: f.client(t, "2026-07-28", token)} }
	read, transfer := client("read"), client("transfer")
	v := read.call("project_transfer_preview", map[string]any{"projectId": testProjectID, "toTeam": testTargetID}, true)
	if e := object(t, v["error"]); e["code"] != "insufficient_scope" || v["data"] != nil {
		t.Fatalf("preview refusal: %#v", v)
	}
	v = transfer.call("project_transfer_preview", map[string]any{"projectId": strings.ToUpper(testProjectID), "toTeam": testTargetID}, false)
	if d := object(t, v["data"]); d["projectName"] != "visible name" || d["projectId"] != testProjectID {
		t.Fatalf("preview: %#v", v)
	}
	if strings.Join(projects.calls, ",") != "preview-name,preview-name" {
		t.Fatalf("unexpected Project reads: %v", projects.calls)
	}
	v = read.call("project_transfer", map[string]any{"projectId": testProjectID, "toTeam": testTargetID, "confirm": true}, true)
	if e := object(t, v["error"]); e["code"] != "insufficient_scope" || e["writeOutcome"] != "not_committed" {
		t.Fatalf("transfer refusal: %#v", v)
	}
	if strings.Join(projects.calls, ",") != "preview-name,preview-name,preview" {
		t.Fatalf("transfer executed after refusal: %v", projects.calls)
	}
	v = transfer.call("project_transfer", map[string]any{"projectId": testProjectID, "toTeam": testTargetID, "confirm": true}, true)
	if e := object(t, v["error"]); e["code"] != "insufficient_scope" || e["writeOutcome"] != "not_committed" {
		t.Fatalf("full transfer receipt requires project read: %#v", v)
	}
	projects.visible = false
	v = transfer.call("project_show", map[string]any{"projectId": testProjectID}, true)
	if object(t, v["error"])["code"] != "not_found" {
		t.Fatalf("visibility refusal: %#v", v)
	}
	projects.visible = true
	projectLink := "https://daynight.test/invitations#dninvite_" + strings.Repeat("A", 43)
	teamLink := "https://daynight.test/team-invitations#dnteam_" + strings.Repeat("A", 43)
	ir, ia := client("invite-read"), client("invite-accept")
	ir.call("invitation_inspect", map[string]any{"link": projectLink}, false)
	v = ir.call("invitation_accept", map[string]any{"link": projectLink, "confirm": true}, true)
	if e := object(t, v["error"]); e["code"] != "insufficient_scope" || e["writeOutcome"] != "not_committed" {
		t.Fatalf("accept refusal: %#v", v)
	}
	ia.call("invitation_accept", map[string]any{"link": projectLink, "confirm": true}, false)
	v = ia.call("invitation_inspect", map[string]any{"link": projectLink}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" {
		t.Fatalf("inspect refusal: %#v", v)
	}
	v = ir.call("invitation_inspect", map[string]any{"link": teamLink}, true)
	if object(t, v["error"])["code"] != "forbidden" {
		t.Fatalf("unclassified Team invitation: %#v", v)
	}
	teamOnly, both := client("team-only"), client("both")
	v = teamOnly.call("team_projects", map[string]any{"team": testTeamID}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" {
		t.Fatalf("project read refusal: %#v", v)
	}
	v = read.call("team_projects", map[string]any{"team": testTeamID}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" {
		t.Fatalf("team read refusal: %#v", v)
	}
	both.call("team_projects", map[string]any{"team": testTeamID}, false)
	teams.err = &model.Fault{Code: "not_found", Message: "not found"}
	v = read.call("team_projects", map[string]any{"team": testTeamID}, true)
	if object(t, v["error"])["code"] != "not_found" {
		t.Fatalf("Team visibility: %#v", v)
	}
	v = read.call("test_only", map[string]any{"mode": "ok"}, true)
	if object(t, v["error"])["code"] != "forbidden" || f.calls.Load() != 0 {
		t.Fatalf("unclassified tool: %#v", v)
	}
	create := map[string]any{"name": "new", "repoUrl": "https://github.com/x/y", "team": testTeamID, "confirm": true}
	v = read.call("project_create", create, true)
	if e := object(t, v["error"]); e["code"] != "insufficient_scope" || e["writeOutcome"] != "not_committed" {
		t.Fatalf("create refusal: %#v", v)
	}
	client("create").call("project_create", create, false)
	repo := map[string]any{"projectId": testProjectID, "repoUrl": "https://github.com/x/y"}
	v = read.call("project_preview_repository", repo, true)
	if object(t, v["error"])["code"] != "insufficient_scope" {
		t.Fatalf("repository preview refusal: %#v", v)
	}
	client("repository").call("project_preview_repository", repo, false)
	set := map[string]any{"projectId": testProjectID, "repoUrl": "https://github.com/x/y", "repositoryVersion": "1", "ownershipVersion": "1", "classification": "unchanged", "targetGitHubRepositoryId": nil, "confirm": true}
	v = read.call("project_set_repository", set, true)
	if e := object(t, v["error"]); e["code"] != "insufficient_scope" || e["writeOutcome"] != "not_committed" {
		t.Fatalf("repository set refusal: %#v", v)
	}
	client("repository").call("project_set_repository", set, false)
	resolved := map[string]any{"repoUrl": "https://github.com/x/y"}
	v = transfer.call("project_resolve", resolved, true)
	if object(t, v["error"])["code"] != "insufficient_scope" || v["data"] != nil {
		t.Fatalf("resolve refusal: %#v", v)
	}
	v = read.call("project_resolve", resolved, false)
	if d := object(t, v["data"]); d["id"] != testProjectID || d["repoUrl"] != resolved["repoUrl"] {
		t.Fatalf("resolved project: %#v", v)
	}
	v = read.call("project_show", map[string]any{"projectId": testProjectID}, false)
	if object(t, v["data"])["id"] != testProjectID {
		t.Fatalf("shown project: %#v", v)
	}
	v = transfer.call("project_list", map[string]any{}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" || v["data"] != nil {
		t.Fatalf("list refusal: %#v", v)
	}
	v = client("transfer-read").call("project_transfer", map[string]any{"projectId": testProjectID, "toTeam": testTargetID, "confirm": true}, false)
	if object(t, v["data"])["projectId"] != testProjectID {
		t.Fatalf("transfer receipt: %#v", v)
	}
	v = ir.call("invitation_accept", map[string]any{"link": teamLink, "confirm": true}, true)
	if e := object(t, v["error"]); e["code"] != "forbidden" || e["writeOutcome"] != "not_committed" {
		t.Fatalf("unclassified Team acceptance: %#v", v)
	}
}

func TestScopedProjectAdapterRejectsMissingOrMismatchedAuthorization(t *testing.T) {
	fixture := &scopedProjectFixture{visible: true}
	adapter := scopedProjectAdapter{fixture}
	invitations := &scopedInvitationFixture{}
	invitationAdapter := scopedInvitationProjects{invitations}
	a := scopedTestAuthorization(t, "project:read")
	p := model.Principal{Kind: model.PATCredential, UserID: "other", CredentialID: testTargetID}
	calls := map[string]func(context.Context) error{
		"create": func(ctx context.Context) error {
			_, _, err := adapter.RegisterRepository(ctx, p, coreproject.CreateProject{}, false)
			return err
		},
		"resolve": func(ctx context.Context) error { _, err := adapter.ResolveRepository(ctx, p, "address"); return err },
		"get":     func(ctx context.Context) error { _, err := adapter.Get(ctx, p, testProjectID); return err },
		"list": func(ctx context.Context) error {
			_, err := adapter.ListScoped(ctx, p, coreproject.ProjectListRequest{})
			return err
		},
		"transfer preview": func(ctx context.Context) error {
			_, err := adapter.TransferPreview(ctx, p, testProjectID, testTargetID)
			return err
		},
		"transfer preview with name": func(ctx context.Context) error {
			_, _, err := adapter.TransferPreviewWithName(ctx, p, testProjectID, testTargetID)
			return err
		},
		"transfer": func(ctx context.Context) error {
			_, err := adapter.Transfer(ctx, p, testProjectID, coreproject.TransferInput{})
			return err
		},
		"repository preview": func(ctx context.Context) error {
			_, err := adapter.RepositoryPreview(ctx, p, testProjectID, "address", p.UserID)
			return err
		},
		"repository change": func(ctx context.Context) error {
			_, err := adapter.SetRepository(ctx, p, testProjectID, coreproject.RepositoryChange{})
			return err
		},
		"inspect invitation": func(ctx context.Context) error {
			_, err := invitationAdapter.InspectInvitation(ctx, p, "secret")
			return err
		},
		"accept invitation": func(ctx context.Context) error {
			_, err := invitationAdapter.AcceptInvitation(ctx, p, "secret", p.UserID)
			return err
		},
	}
	for name, call := range calls {
		for label, ctx := range map[string]context.Context{"missing": context.Background(), "mismatched": context.WithValue(context.Background(), scopedAuthorizationKey{}, a)} {
			if err := call(ctx); err == nil {
				t.Errorf("%s accepted %s authorization", name, label)
			}
		}
	}
	if len(fixture.calls) != 0 || len(invitations.calls) != 0 {
		t.Fatal("service called without matching authorization")
	}
	if err := (&Entry{}).EnableScopedAuthentication(nil); err == nil {
		t.Fatal("nil authenticator accepted")
	}
}

func TestScopedMCPRejectsInvalidAuthenticationSnapshots(t *testing.T) {
	pat := scopedTestAuthorization(t, "project:read")
	missing := pat
	missing.Policy = nil
	wrong := pat
	wrong.Profile = model.ScopedMCPProfile
	for _, tc := range []struct {
		name      string
		auth      model.CredentialAuthorization
		authority AuthorityRef
	}{
		{"missing policy", missing, AuthorityRef{Kind: "pat", ID: pat.Principal.CredentialID}},
		{"wrong profile", wrong, AuthorityRef{Kind: "pat", ID: pat.Principal.CredentialID}},
		{"wrong authority", pat, AuthorityRef{Kind: "pat", ID: testProjectID}},
		{"wrong authority kind", pat, AuthorityRef{Kind: "oauth", ID: pat.Principal.CredentialID}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newEntryFixture(t)
			if err := f.entry.EnableScopedAuthentication(fixedScopedAuthenticator{tc.auth, tc.authority}); err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(http.MethodPost, "http://localhost/mcp", nil)
			r.Header.Set("Authorization", "Bearer some-token")
			w := httptest.NewRecorder()
			f.entry.ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestScopedMCPUsesCurrentGrantPolicyOnEveryRequest(t *testing.T) {
	f := newEntryFixture(t)
	policy := func(id scopepolicy.ScopeID) *scopepolicy.Policy {
		p, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{id}, 1)
		if err != nil {
			t.Fatal(err)
		}
		return &p
	}
	a := model.CredentialAuthorization{Principal: model.Principal{Kind: model.OAuthCredential, UserID: testUserID, CredentialID: testTargetID}, Profile: model.ScopedMCPProfile, Policy: policy("project:read")}
	auth := testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"dnmcp_access": a}}
	if err := f.entry.EnableScopedAuthentication(auth); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedProjectTools(f.entry, &scopedProjectFixture{visible: true}, &identityservice.Identity{}, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	c := &structClient{t: t, client: f.client(t, "2026-07-28", "dnmcp_access")}
	c.call("project_list", map[string]any{}, false)
	a.Policy = policy("project:transfer")
	auth.policies["dnmcp_access"] = a
	v := c.call("project_list", map[string]any{}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" {
		t.Fatalf("current grant policy: %#v", v)
	}
}

func TestScopedMCPRejectsLegacyToolReplacement(t *testing.T) {
	f := newEntryFixture(t)
	a := scopedTestAuthorization(t, "project:read")
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"read": a}}); err != nil {
		t.Fatal(err)
	}
	identity := &identityservice.Identity{}
	projects := &scopedProjectFixture{visible: true}
	if err := RegisterScopedProjectTools(f.entry, projects, identity, "https://daynight.test"); err != nil {
		t.Fatal(err)
	}
	legacy := &fakeProjectOperations{project: sampleProject(testProjectID)}
	if err := RegisterProjectTools(f.entry, legacy, identity, "https://daynight.test"); err == nil {
		t.Fatal("legacy registration replaced a scoped tool")
	}
	c := &structClient{t: t, client: f.client(t, "2026-07-28", "read")}
	v := c.call("project_transfer_preview", map[string]any{"projectId": testProjectID, "toTeam": testTargetID}, true)
	if object(t, v["error"])["code"] != "insufficient_scope" || legacy.previews != 0 {
		t.Fatalf("scope bypass after duplicate registration: %#v", v)
	}
}

func TestScopedMCPRegistrationsRejectMissingDependenciesAndCollisions(t *testing.T) {
	auth := testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"read": scopedTestAuthorization(t, "project:read")}}
	projects := &scopedProjectFixture{visible: true}
	identity := &identityservice.Identity{}
	teams := &scopedTeamFixture{}
	invitationTeams := &invitationTestTeams{}
	invitations := &scopedInvitationFixture{}
	for _, tc := range []struct {
		name     string
		register func(*Entry) error
		missing  func(*Entry) error
	}{
		{"project", func(e *Entry) error {
			return RegisterScopedProjectTools(e, projects, identity, "https://daynight.test")
		}, func(e *Entry) error { return RegisterScopedProjectTools(e, nil, identity, "https://daynight.test") }},
		{"team", func(e *Entry) error { return RegisterProjectScopedTeamTools(e, teams, projects, identity) }, func(e *Entry) error { return RegisterProjectScopedTeamTools(e, nil, projects, identity) }},
		{"invitation", func(e *Entry) error {
			return RegisterProjectScopedInvitationTools(e, identity, invitationTeams, invitations, "https://daynight.test")
		}, func(e *Entry) error {
			return RegisterProjectScopedInvitationTools(e, identity, invitationTeams, nil, "https://daynight.test")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newEntryFixture(t)
			if tc.register(nil) == nil || tc.register(f.entry) == nil {
				t.Fatal("registration without scoped authentication accepted")
			}
			if err := f.entry.EnableScopedAuthentication(auth); err != nil {
				t.Fatal(err)
			}
			if tc.missing(f.entry) == nil {
				t.Fatal("missing dependency accepted")
			}
			if err := tc.register(f.entry); err != nil {
				t.Fatal(err)
			}
			if tc.register(f.entry) == nil {
				t.Fatal("duplicate registration accepted")
			}
		})
	}
}

func TestScopedMCPRefusalDoesNotHideUnknownOrMixedFailures(t *testing.T) {
	f := newEntryFixture(t)
	a := scopedTestAuthorization(t, "project:read")
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"read": a}}); err != nil {
		t.Fatal(err)
	}
	scopeErr := scopeadmission.Require(a, scopepolicy.ProjectWrite)
	errorsByMode := map[string]error{
		"refused":  scopeErr,
		"mixed":    errors.Join(scopeErr, errors.New("independent failure")),
		"database": errors.Join(scopeErr, &store.Error{DatabaseFailure: true}),
		"unknown":  &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: scopeErr},
		"cleanup":  &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: scopeErr},
	}
	err := f.entry.RegisterTool(&sdk.Tool{Name: "scope_failure", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"mode": map[string]any{"type": "string"}}}}, BudgetControl, func(_ context.Context, _ RequestActor, raw json.RawMessage) (ToolResult, error) {
		var args struct {
			Mode string `json:"mode"`
		}
		if err := json.Unmarshal(raw, &args); err != nil {
			return ToolResult{}, err
		}
		return ToolResult{}, errorsByMode[args.Mode]
	})
	if err != nil {
		t.Fatal(err)
	}
	f.entry.scopedTools["scope_failure"] = true
	c := &structClient{t: t, client: f.client(t, "2026-07-28", "read")}
	for _, mode := range []string{"refused", "mixed", "database", "unknown", "cleanup"} {
		v := c.call("scope_failure", map[string]any{"mode": mode}, true)
		e := object(t, v["error"])
		if mode == "refused" {
			if e["code"] != "insufficient_scope" || e["writeOutcome"] != "not_committed" {
				t.Fatalf("known refusal: %#v", v)
			}
		} else if e["code"] == "insufficient_scope" {
			t.Fatalf("%s concealed failure: %#v", mode, v)
		}
		if mode == "unknown" && e["writeOutcome"] != "unknown" {
			t.Fatalf("unknown outcome: %#v", v)
		}
	}
}
