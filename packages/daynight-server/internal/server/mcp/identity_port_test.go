package mcp

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

const portTeamUpper = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF"
const portTeam = "abcdefab-abcd-4abc-8abc-abcdefabcdef"
const portRepo = "https://example.com/owner/repo"
const portOrigin = "https://daynight.test"

// portProbe checks the exact resolver and operation calls, including requests
// handled on the HTTP server goroutine.
type portProbe struct {
	mu                           sync.Mutex
	t                            *testing.T
	principal                    model.Principal
	context                      context.Context // nil until the resolver runs for an HTTP request
	resolveWant, operationWant   int
	resolveCalls, operationCalls int
	resolveErr                   error
	project                      model.Project
	minted                       teamcore.MintedTeamInvitation
}

func newPortProbe(t *testing.T, principal model.Principal, ctx context.Context, resolves, operations int) *portProbe {
	t.Helper()
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	p := &portProbe{t: t, principal: principal, context: ctx, resolveWant: resolves, operationWant: operations,
		project: model.Project{ID: testProjectID, Name: "Project", RepoURL: portRepo, CreatedAt: now, UpdatedAt: now, Settings: model.ProjectSettings{Version: 7}, Ownership: model.ProjectOwnership{TeamID: portTeam, Version: 8, UpdatedAt: now}},
		minted:  teamcore.MintedTeamInvitation{Invitation: model.TeamInvitation{ID: invitationTestProjectID, TeamID: portTeam, CreatedBy: principal.UserID, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, Secret: "dnteam_" + strings.Repeat("A", 43)},
	}
	t.Cleanup(func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.resolveCalls != p.resolveWant || p.operationCalls != p.operationWant {
			t.Errorf("resolver calls %d/%d, operation calls %d/%d", p.resolveCalls, p.resolveWant, p.operationCalls, p.operationWant)
		}
	})
	return p
}
func (p *portProbe) check(ctx context.Context, principal model.Principal) {
	p.t.Helper()
	if p.context == nil {
		p.context = ctx
	}
	if ctx != p.context || principal != p.principal {
		p.t.Errorf("context/principal mismatch: same context=%v, got %+v, want %+v", ctx == p.context, principal, p.principal)
	}
}
func (p *portProbe) PersonalTeamID(ctx context.Context, principal model.Principal) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resolveCalls++
	if p.resolveCalls > p.resolveWant {
		p.t.Errorf("unexpected PersonalTeamID call %d", p.resolveCalls)
	}
	p.check(ctx, principal)
	return portTeamUpper, p.resolveErr
}
func (p *portProbe) RegisterRepository(ctx context.Context, principal model.Principal, input projectcore.CreateProject, confirm bool) (model.Project, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.operationCalls++
	if p.operationCalls > p.operationWant {
		p.t.Errorf("unexpected RegisterRepository call %d", p.operationCalls)
	}
	p.check(ctx, principal)
	want := projectcore.CreateProject{Name: "Project", RepoURL: portRepo, TeamID: stringPointer(portTeam), ExpectedUserID: p.principal.UserID}
	if !reflect.DeepEqual(input, want) || !confirm {
		p.t.Errorf("project input %+v, confirm %v; want %+v, true", input, confirm, want)
	}
	return p.project, true, nil
}
func stringPointer(s string) *string { return &s }
func (p *portProbe) CreateInvitation(ctx context.Context, principal model.Principal, teamID, expected string) (teamcore.MintedTeamInvitation, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.operationCalls++
	if p.operationCalls > p.operationWant {
		p.t.Errorf("unexpected CreateInvitation call %d", p.operationCalls)
	}
	p.check(ctx, principal)
	if teamID != portTeam || expected != p.principal.UserID {
		p.t.Errorf("invitation team/expected %q/%q", teamID, expected)
	}
	return p.minted, nil
}
func (p *portProbe) unexpected(name string) { p.t.Errorf("unexpected %s call", name) }
func (p *portProbe) ResolveRepository(context.Context, model.Principal, string) (model.Project, error) {
	p.unexpected("ResolveRepository")
	return model.Project{}, errors.New("unexpected call")
}
func (p *portProbe) Get(context.Context, model.Principal, string) (model.Project, error) {
	p.unexpected("Get")
	return model.Project{}, errors.New("unexpected call")
}
func (p *portProbe) ListScoped(context.Context, model.Principal, projectcore.ProjectListRequest) (projectcore.ProjectPage, error) {
	p.unexpected("ListScoped")
	return projectcore.ProjectPage{}, errors.New("unexpected call")
}
func (p *portProbe) TransferPreview(context.Context, model.Principal, string, string) (projectcore.TransferPreview, error) {
	p.unexpected("TransferPreview")
	return projectcore.TransferPreview{}, errors.New("unexpected call")
}
func (p *portProbe) Transfer(context.Context, model.Principal, string, projectcore.TransferInput) (projectcore.TransferReceipt, error) {
	p.unexpected("Transfer")
	return projectcore.TransferReceipt{}, errors.New("unexpected call")
}
func (p *portProbe) ListInvitationPage(context.Context, model.Principal, string, model.PageRequest) (teamcore.InvitationPage, error) {
	p.unexpected("ListInvitationPage")
	return teamcore.InvitationPage{}, errors.New("unexpected call")
}
func (p *portProbe) RevokeInvitation(context.Context, model.Principal, string, string, string) (bool, error) {
	p.unexpected("RevokeInvitation")
	return false, errors.New("unexpected call")
}
func (p *portProbe) InspectInvitation(context.Context, model.Principal, string) (teamcore.TeamInvitationInspection, error) {
	p.unexpected("InspectInvitation")
	return teamcore.TeamInvitationInspection{}, errors.New("unexpected call")
}
func (p *portProbe) AcceptInvitation(context.Context, model.Principal, string, string) (teamcore.TeamInvitationAcceptance, error) {
	p.unexpected("AcceptInvitation")
	return teamcore.TeamInvitationAcceptance{}, errors.New("unexpected call")
}

type portInvitationProjects struct{ t *testing.T }

func (p portInvitationProjects) InspectInvitation(context.Context, model.Principal, string) (projectcore.InvitationInspection, error) {
	p.t.Error("unexpected Project InspectInvitation")
	return projectcore.InvitationInspection{}, errors.New("unexpected call")
}
func (p portInvitationProjects) AcceptInvitation(context.Context, model.Principal, string, string) (projectcore.InvitationAcceptance, error) {
	p.t.Error("unexpected Project AcceptInvitation")
	return projectcore.InvitationAcceptance{}, errors.New("unexpected call")
}

type portContextKey struct{}

func TestIdentityPortAdapters(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "user", CredentialID: "credential"}
	actor := RequestActor{Principal: principal}
	failure := errors.New("personal team unavailable")
	for _, consumer := range []string{"project", "invitation"} {
		for _, scenario := range []string{"personal", "resolver failure", "explicit"} {
			t.Run(consumer+"/"+scenario, func(t *testing.T) {
				ctx := context.WithValue(t.Context(), portContextKey{}, "original")
				selection, resolves, operations := "personal", 1, 1
				if scenario == "resolver failure" {
					operations = 0
				}
				if scenario == "explicit" {
					selection, resolves = portTeamUpper, 0
				}
				p := newPortProbe(t, principal, ctx, resolves, operations)
				if scenario == "resolver failure" {
					p.resolveErr = failure
				}
				var got ToolResult
				var err error
				if consumer == "project" {
					got, err = (&projectTools{projects: p, identity: p}).create(ctx, actor, projectCreateInput{Name: "Project", RepoURL: portRepo, Team: selection, Confirm: true})
				} else {
					got, err = (&invitationAdapter{identity: p, teams: p, origin: portOrigin}).create(ctx, actor, invitationInput{Team: selection})
				}
				if scenario == "resolver failure" {
					if !errors.Is(err, failure) {
						t.Fatalf("resolver error: %v", err)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if consumer == "project" {
					want := ToolResult{Data: map[string]any{"project": MapProject(p.project), "created": true}, Outcome: "changed", WriteOutcome: "confirmed", Refs: map[string]any{"projectId": p.project.ID}}
					if !reflect.DeepEqual(got, want) {
						t.Fatalf("project response: %#v; want %#v", got, want)
					}
				} else {
					want := struct {
						teamInvitation
						Link string `json:"link"`
					}{mapTeamInvitation(p.minted.Invitation), portOrigin + "/team-invitations#" + p.minted.Secret}
					if !reflect.DeepEqual(got.Data, want) || got.Outcome != "changed" || got.WriteOutcome != "confirmed" {
						t.Fatalf("invitation response: %#v", got)
					}
				}
			})
		}
	}
}

func TestIdentityPortProductionRegistrations(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "alice", CredentialID: "credential-alice"}
	for _, consumer := range []string{"project", "invitation"} {
		t.Run(consumer, func(t *testing.T) {
			fixture := newEntryFixture(t)
			p := newPortProbe(t, principal, nil, 1, 1)
			var err error
			if consumer == "project" {
				err = RegisterProjectTools(fixture.entry, p, p, portOrigin)
			} else {
				err = RegisterInvitationTools(fixture.entry, p, p, portInvitationProjects{t}, portOrigin)
			}
			if err != nil {
				t.Fatal(err)
			}
			client := fixture.client(t, "2026-07-28", "alice")
			if consumer == "project" {
				out := invitationCall(t, client, "project_create", map[string]any{"name": "Project", "repoUrl": portRepo, "team": "personal", "confirm": true}, false)
				data := object(t, out["data"])
				if data["created"] != true || object(t, data["project"])["id"] != p.project.ID || object(t, out["meta"])["outcome"] != "changed" {
					t.Fatalf("project response: %#v", out)
				}
			} else {
				out := invitationCall(t, client, "team_invitation_create", map[string]any{"team": "personal", "confirm": true}, false)
				data := object(t, out["data"])
				if data["id"] != p.minted.Invitation.ID || data["teamId"] != portTeam || data["link"] != portOrigin+"/team-invitations#"+p.minted.Secret || object(t, out["meta"])["outcome"] != "changed" {
					t.Fatalf("invitation response: %#v", out)
				}
			}
		})
	}
}
