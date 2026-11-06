package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type invitationTeams interface {
	CreateInvitation(context.Context, model.Principal, string, string) (teamcore.MintedTeamInvitation, error)
	ListInvitationPage(context.Context, model.Principal, string, model.PageRequest) (teamcore.InvitationPage, error)
	RevokeInvitation(context.Context, model.Principal, string, string, string) (bool, error)
	InspectInvitation(context.Context, model.Principal, string) (teamcore.TeamInvitationInspection, error)
	AcceptInvitation(context.Context, model.Principal, string, string) (teamcore.TeamInvitationAcceptance, error)
}
type invitationProjects interface {
	InspectInvitation(context.Context, model.Principal, string) (projectcore.InvitationInspection, error)
	AcceptInvitation(context.Context, model.Principal, string, string) (projectcore.InvitationAcceptance, error)
}
type invitationAdapter struct {
	identity *identity.Identity
	teams    invitationTeams
	projects invitationProjects
	origin   string
}

type teamInvitation struct {
	ID         string     `json:"id"`
	TeamID     string     `json:"teamId"`
	CreatedBy  string     `json:"createdBy"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	ConsumedBy *string    `json:"consumedBy"`
	ConsumedAt *time.Time `json:"consumedAt"`
	RevokedAt  *time.Time `json:"revokedAt"`
}

func mapTeamInvitation(i model.TeamInvitation) teamInvitation {
	return teamInvitation{ID: i.ID, TeamID: i.TeamID, CreatedBy: i.CreatedBy, CreatedAt: i.CreatedAt.UTC(), ExpiresAt: i.ExpiresAt.UTC(), ConsumedBy: i.ConsumedBy, ConsumedAt: utcTime(i.ConsumedAt), RevokedAt: utcTime(i.RevokedAt)}
}
func mapMember(m model.TeamMember) TeamMember {
	return TeamMember{TeamID: m.TeamID, UserID: m.UserID, Role: m.Role, Version: Decimal(m.Version), CreatedAt: m.CreatedAt.UTC(), UpdatedAt: m.UpdatedAt.UTC()}
}

type projectGrant struct {
	ProjectID string            `json:"projectId"`
	UserID    string            `json:"userId"`
	Role      model.ProjectRole `json:"role"`
	Version   string            `json:"version"`
	CreatedAt time.Time         `json:"createdAt"`
	UpdatedAt time.Time         `json:"updatedAt"`
}

func mapGrant(g model.ProjectGrant) projectGrant {
	return projectGrant{g.ProjectID, g.UserID, g.Role, Decimal(g.Version), g.CreatedAt.UTC(), g.UpdatedAt.UTC()}
}
func optionalGrant(g *model.ProjectGrant) *projectGrant {
	if g == nil {
		return nil
	}
	v := mapGrant(*g)
	return &v
}

type invitationProjectOwnership struct {
	TeamID  string `json:"teamId"`
	Version string `json:"version"`
}
type projectAccess struct {
	ProjectID     string                     `json:"projectId"`
	OwnerTeam     TeamRef                    `json:"ownerTeam"`
	Ownership     invitationProjectOwnership `json:"ownership"`
	TeamRole      *model.ProjectRole         `json:"teamRole"`
	CanTransfer   bool                       `json:"canTransfer"`
	EffectiveRole model.ProjectRole          `json:"effectiveRole"`
	DirectGrant   *projectGrant              `json:"directGrant"`
}

func mapAccess(a model.ProjectAccess) projectAccess {
	return projectAccess{ProjectID: a.ProjectID, OwnerTeam: MapTeamRef(a.OwnerTeam), Ownership: invitationProjectOwnership{a.Ownership.TeamID, Decimal(a.Ownership.Version)}, TeamRole: a.TeamRole, CanTransfer: a.CanTransfer, EffectiveRole: a.Role, DirectGrant: optionalGrant(a.DirectGrant)}
}
func optionalAccess(a *model.ProjectAccess) *projectAccess {
	if a == nil {
		return nil
	}
	v := mapAccess(*a)
	return &v
}

// InvitationInspection is a typed union of Team and Project inspection results.
type InvitationInspection interface{ invitationScope() string }
type TeamInvitationInspection struct {
	Scope      string      `json:"scope"`
	Team       TeamRef     `json:"team"`
	Membership *TeamMember `json:"membership"`
}

func (TeamInvitationInspection) invitationScope() string { return "team" }

type ProjectInvitationInspection struct {
	Scope       string         `json:"scope"`
	ProjectID   string         `json:"projectId"`
	ProjectName string         `json:"projectName"`
	DirectGrant *projectGrant  `json:"directGrant"`
	Access      *projectAccess `json:"access"`
}

func (ProjectInvitationInspection) invitationScope() string { return "project" }

type InvitationAcceptance struct {
	Scope       string         `json:"scope"`
	Team        *TeamRef       `json:"team,omitempty"`
	Membership  *TeamMember    `json:"membership,omitempty"`
	ProjectID   string         `json:"projectId,omitempty"`
	DirectGrant *projectGrant  `json:"directGrant,omitempty"`
	Access      *projectAccess `json:"access,omitempty"`
	Joined      bool           `json:"joined"`
	Consumed    bool           `json:"consumed"`
}
type invitationInput struct {
	Team         string  `json:"team"`
	InvitationID string  `json:"invitationId"`
	Link         string  `json:"link"`
	Limit        int     `json:"limit"`
	Cursor       *string `json:"cursor"`
}
type invitationPage struct {
	Items      []teamInvitation `json:"items"`
	NextCursor *string          `json:"nextCursor"`
}

// RegisterInvitationTools registers only complete invitation adapters.
func RegisterInvitationTools(e *Entry, identity *identity.Identity, teams invitationTeams, projects invitationProjects, origin string) error {
	if identity == nil || teams == nil || projects == nil {
		return errors.New("invitation services are required")
	}
	var tools []sdk.Tool
	if err := json.Unmarshal([]byte(invitationSchemas), &tools); err != nil {
		return err
	}
	a := &invitationAdapter{identity, teams, projects, origin}
	for i := range tools {
		output := invitationOutputSchema
		if tools[i].Name == "team_invitation_list" {
			output = invitationPageOutputSchema
		}
		var schema map[string]any
		if err := json.Unmarshal([]byte(output), &schema); err != nil {
			return err
		}
		tools[i].OutputSchema = schema
		var handler func(context.Context, RequestActor, invitationInput) (ToolResult, error)
		switch tools[i].Name {
		case "team_invitation_create":
			handler = a.create
		case "team_invitation_list":
			handler = a.list
		case "team_invitation_revoke":
			handler = a.revoke
		case "invitation_inspect":
			handler = a.inspect
		case "invitation_accept":
			handler = a.accept
		default:
			return errors.New("unknown invitation tool")
		}
		if err := RegisterTypedTool(e, &tools[i], BudgetControl, handler, "team", "invitationId", "link", "cursor"); err != nil {
			return err
		}
	}
	return nil
}
func (a *invitationAdapter) create(ctx context.Context, actor RequestActor, in invitationInput) (ToolResult, error) {
	id, err := ResolveTeamID(ctx, a.identity, actor.Principal, in.Team)
	if err != nil {
		return ToolResult{}, err
	}
	result, err := a.teams.CreateInvitation(ctx, actor.Principal, id, actor.Principal.UserID)
	if err != nil {
		if fault, ok := teamcore.WriteFault(err); ok {
			err = fault
		}
		return ToolResult{}, err
	}
	return ToolResult{Data: struct {
		teamInvitation
		Link string `json:"link"`
	}{mapTeamInvitation(result.Invitation), a.origin + "/team-invitations#" + result.Secret}, Outcome: "changed", WriteOutcome: "confirmed"}, nil
}
func (a *invitationAdapter) list(ctx context.Context, actor RequestActor, in invitationInput) (ToolResult, error) {
	id, err := ResolveTeamID(ctx, a.identity, actor.Principal, in.Team)
	if err != nil {
		return ToolResult{}, err
	}
	limit := in.Limit
	if limit == 0 {
		limit = 50
	}
	page, err := a.teams.ListInvitationPage(ctx, actor.Principal, id, model.PageRequest{Limit: limit, Cursor: in.Cursor})
	if err != nil {
		return ToolResult{}, err
	}
	result := invitationPage{Items: make([]teamInvitation, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, i := range page.Items {
		result.Items = append(result.Items, mapTeamInvitation(i))
	}
	// Keep the entire encoded response within the default budget and ensure that
	// its cursor follows the last returned item, including when a page is trimmed.
	for {
		encoded, err := json.Marshal(envelope{Data: result, Meta: &envelopeMeta{RequestID: actor.RequestID}})
		if err != nil {
			return ToolResult{}, err
		}
		if len(encoded) <= 16<<10 {
			break
		}
		if len(result.Items) <= 1 {
			return ToolResult{}, errors.New("invitation item exceeds output budget")
		}
		result.Items = result.Items[:len(result.Items)-1]
		last := result.Items[len(result.Items)-1]
		cursor, err := query.EncodeListCursor(query.ListScope{Kind: "team_invitations", UserID: actor.Principal.UserID, ProjectID: id}, last.CreatedAt, last.ID)
		if err != nil {
			return ToolResult{}, err
		}
		result.NextCursor = &cursor
	}
	return ToolResult{Data: result}, nil
}
func (a *invitationAdapter) revoke(ctx context.Context, actor RequestActor, in invitationInput) (ToolResult, error) {
	id, err := ResolveTeamID(ctx, a.identity, actor.Principal, in.Team)
	if err != nil {
		return ToolResult{}, err
	}
	changed, err := a.teams.RevokeInvitation(ctx, actor.Principal, id, in.InvitationID, actor.Principal.UserID)
	if err != nil {
		if fault, ok := teamcore.WriteFault(err); ok {
			err = fault
		}
		return ToolResult{}, err
	}
	outcome := "unchanged"
	if changed {
		outcome = "changed"
	}
	return ToolResult{Data: struct {
		TeamID       string `json:"teamId"`
		InvitationID string `json:"invitationId"`
		Changed      bool   `json:"changed"`
	}{id, in.InvitationID, changed}, Outcome: outcome, WriteOutcome: "confirmed"}, nil
}
func (a *invitationAdapter) parseLink(link string) (string, string, error) {
	invalid := &model.Fault{Code: "invalid_input", Message: "Invalid invitation link; use a same-service Team or Project invitation link."}
	if len(link) > 4096 {
		return "", "", invalid
	}
	for _, candidate := range []struct{ path, scope, prefix string }{{"/invitations#", "project", "dninvite_"}, {"/team-invitations#", "team", "dnteam_"}} {
		if strings.HasPrefix(link, a.origin+candidate.path) {
			token := strings.TrimPrefix(link, a.origin+candidate.path)
			if secretutil.Valid(token, candidate.prefix) {
				return candidate.scope, token, nil
			}
		}
	}
	return "", "", invalid
}
func (a *invitationAdapter) inspect(ctx context.Context, actor RequestActor, in invitationInput) (ToolResult, error) {
	scope, secret, err := a.parseLink(in.Link)
	if err != nil {
		return ToolResult{}, err
	}
	if scope == "team" {
		i, err := a.teams.InspectInvitation(ctx, actor.Principal, secret)
		if err != nil {
			return ToolResult{}, err
		}
		team := MapTeamRef(i.Team)
		var member *TeamMember
		if i.Membership != nil {
			v := mapMember(*i.Membership)
			member = &v
		}
		inspection := TeamInvitationInspection{Team: team, Membership: member}
		inspection.Scope = inspection.invitationScope()
		var result InvitationInspection = inspection
		return ToolResult{Data: result}, nil
	}
	i, err := a.projects.InspectInvitation(ctx, actor.Principal, secret)
	if err != nil {
		return ToolResult{}, err
	}
	inspection := ProjectInvitationInspection{ProjectID: i.ProjectID, ProjectName: i.ProjectName, DirectGrant: optionalGrant(i.DirectGrant), Access: optionalAccess(i.Access)}
	inspection.Scope = inspection.invitationScope()
	var result InvitationInspection = inspection
	return ToolResult{Data: result}, nil
}
func (a *invitationAdapter) accept(ctx context.Context, actor RequestActor, in invitationInput) (ToolResult, error) {
	scope, secret, err := a.parseLink(in.Link)
	if err != nil {
		return ToolResult{}, err
	}
	if scope == "team" {
		i, err := a.teams.AcceptInvitation(ctx, actor.Principal, secret, actor.Principal.UserID)
		if err != nil {
			return ToolResult{}, err
		}
		team := MapTeamRef(i.Team)
		member := mapMember(i.Membership)
		outcome := "unchanged"
		if i.Joined {
			outcome = "changed"
		}
		return ToolResult{Data: InvitationAcceptance{Scope: scope, Team: &team, Membership: &member, Joined: i.Joined, Consumed: i.Consumed}, Outcome: outcome, WriteOutcome: "confirmed"}, nil
	}
	i, err := a.projects.AcceptInvitation(ctx, actor.Principal, secret, actor.Principal.UserID)
	if err != nil {
		return ToolResult{}, err
	}
	grant := mapGrant(i.DirectGrant)
	access := mapAccess(i.Access)
	outcome := "unchanged"
	if i.Joined {
		outcome = "changed"
	}
	return ToolResult{Data: InvitationAcceptance{Scope: scope, ProjectID: i.ProjectID, DirectGrant: &grant, Access: &access, Joined: i.Joined, Consumed: i.Consumed}, Outcome: outcome, WriteOutcome: "confirmed"}, nil
}
