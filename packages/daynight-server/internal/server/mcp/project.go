package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed project_tools.json
var projectToolsJSON []byte

type projectOperations interface {
	RegisterRepository(context.Context, model.Principal, coreproject.CreateProject, bool) (model.Project, bool, error)
	Get(context.Context, model.Principal, string) (model.Project, error)
	List(context.Context, model.Principal, model.PageRequest) (coreproject.ProjectPage, error)
	TransferPreview(context.Context, model.Principal, string, string) (coreproject.TransferPreview, error)
	Transfer(context.Context, model.Principal, string, coreproject.TransferInput) (coreproject.TransferReceipt, error)
}

type projectTools struct {
	projects projectOperations
	identity *identity.Identity
	origin   string
}
type projectCreateInput struct {
	Name    string `json:"name"`
	RepoURL string `json:"repoUrl"`
	Team    string `json:"team"`
	Confirm bool   `json:"confirm"`
}
type projectTransferInput struct {
	ProjectID string  `json:"projectId"`
	ToTeam    string  `json:"toTeam"`
	IfVersion *string `json:"ifVersion"`
	Confirm   bool    `json:"confirm"`
}
type projectShowInput struct {
	ProjectID string `json:"projectId"`
}
type projectListInput struct {
	Limit  *int    `json:"limit"`
	Cursor *string `json:"cursor"`
}

// RegisterProjectTools exposes the Project operations through the shared MCP wrapper.
func RegisterProjectTools(e *Entry, projects projectOperations, identity *identity.Identity, origin string) error {
	var tools []*sdk.Tool
	if err := json.Unmarshal(projectToolsJSON, &tools); err != nil {
		return fmt.Errorf("decode Project tools: %w", err)
	}
	byName := make(map[string]*sdk.Tool, len(tools))
	for _, tool := range tools {
		byName[tool.Name] = tool
	}
	h := &projectTools{projects: projects, identity: identity, origin: origin}
	if err := RegisterTypedTool(e, byName["project_create"], BudgetLarge, h.create, "name", "repoUrl", "team"); err != nil {
		return err
	}
	if err := RegisterTypedTool(e, byName["project_transfer"], BudgetControl, h.transfer, "projectId", "toTeam", "ifVersion"); err != nil {
		return err
	}
	if err := RegisterTypedTool(e, byName["project_list"], BudgetLarge, h.list, "cursor"); err != nil {
		return err
	}
	return RegisterTypedTool(e, byName["project_show"], BudgetLarge, h.show, "projectId")
}

func (h *projectTools) create(ctx context.Context, actor RequestActor, in projectCreateInput) (ToolResult, error) {
	teamID, err := ResolveTeamID(ctx, h.identity, actor.Principal, in.Team)
	if err != nil {
		return ToolResult{}, err
	}
	if projectCreateBodySize(in.Name, in.RepoURL, teamID, actor.Principal.UserID) > httpx.MaxJSONBody {
		return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Project creation input exceeds the JSON body limit."}
	}
	project, created, err := h.projects.RegisterRepository(ctx, actor.Principal, coreproject.CreateProject{Name: in.Name, RepoURL: in.RepoURL, TeamID: &teamID, ExpectedUserID: actor.Principal.UserID}, in.Confirm)
	if err != nil {
		return ToolResult{}, err
	}
	outcome := "unchanged"
	if created {
		outcome = "changed"
	}
	return ToolResult{Data: map[string]any{"project": MapProject(project), "created": created}, Outcome: outcome, WriteOutcome: "confirmed", Refs: map[string]any{"projectId": project.ID}}, nil
}

// projectCreateBodySize matches JSON.stringify for the corresponding REST body.
// It counts UTF-8 bytes and JSON escapes without HTML escaping or an encoder newline.
func projectCreateBodySize(name, repoURL, teamID, userID string) int {
	size := len(`{"name":,"repoUrl":,"teamId":,"expectedUserId":}`)
	for _, value := range []string{name, repoURL, teamID, userID} {
		size += 2
		for i := 0; i < len(value); i++ {
			switch value[i] {
			case '"', '\\', '\b', '\f', '\n', '\r', '\t':
				size += 2
			default:
				if value[i] < 0x20 {
					size += 6
				} else {
					size++
				}
			}
		}
	}
	return size
}

func (h *projectTools) show(ctx context.Context, actor RequestActor, in projectShowInput) (ToolResult, error) {
	project, err := h.projects.Get(ctx, actor.Principal, in.ProjectID)
	if err != nil {
		return ToolResult{}, err
	}
	return ToolResult{Data: MapProject(project)}, nil
}

type projectPage struct {
	Items      []Project `json:"items"`
	NextCursor *string   `json:"nextCursor"`
}

func (h *projectTools) list(ctx context.Context, actor RequestActor, in projectListInput) (ToolResult, error) {
	limit := 50
	if in.Limit != nil {
		limit = *in.Limit
	}
	page, err := h.projects.List(ctx, actor.Principal, model.PageRequest{Limit: limit, Cursor: in.Cursor})
	if err != nil {
		return ToolResult{}, err
	}
	out := projectPage{Items: make([]Project, 0, len(page.Items)), NextCursor: page.NextCursor}
	for i, project := range page.Items {
		out.Items = append(out.Items, MapProject(project))
		if i < len(page.Items)-1 || page.NextCursor != nil {
			cursor, err := query.EncodeProjectCursor(project, actor.Principal.UserID, store.ProjectScope{Kind: store.ProjectScopeAll})
			if err != nil {
				return ToolResult{}, err
			}
			out.NextCursor = &cursor
		} else {
			out.NextCursor = nil
		}
		encoded, err := json.Marshal(envelope{Data: out, Meta: &envelopeMeta{RequestID: actor.RequestID}})
		if err != nil {
			return ToolResult{}, err
		}
		if len(encoded) > 16<<10 {
			out.Items = out.Items[:len(out.Items)-1]
			if len(out.Items) == 0 {
				cursor, err := query.EncodeProjectCursor(project, actor.Principal.UserID, store.ProjectScope{Kind: store.ProjectScopeAll})
				if err != nil {
					return ToolResult{}, err
				}
				return ToolResult{Refs: map[string]any{"projectId": project.ID, "readTool": "project_show", "nextCursor": cursor}}, &model.Fault{Code: "resource_conflict", Message: "Project exceeds the page budget; use project_show and continue with nextCursor."}
			}
			cursor, err := query.EncodeProjectCursor(page.Items[i-1], actor.Principal.UserID, store.ProjectScope{Kind: store.ProjectScopeAll})
			if err != nil {
				return ToolResult{}, err
			}
			out.NextCursor = &cursor
			break
		}
	}
	return ToolResult{Data: out}, nil
}

var teamLink = regexp.MustCompile(`(?i)^(https?://[^\s\\/?#@]+)(/teams/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))$`)

func teamIdentifier(value, origin string) (string, error) {
	invalid := &model.Fault{Code: "invalid_input", Message: "Destination must be a canonical Team UUID or a same-service Team link."}
	if id, err := model.CanonicalID(value); err == nil && id == value {
		return id, nil
	}
	parts := teamLink.FindStringSubmatch(value)
	if parts == nil || !strings.HasPrefix(parts[2], "/teams/") {
		return "", invalid
	}
	id, err := model.CanonicalID(parts[3])
	if err != nil || id != parts[3] {
		return "", invalid
	}
	link, err := url.Parse(value)
	if err != nil || link.User != nil || link.Path != parts[2] || link.RawPath != "" {
		return "", invalid
	}
	base, err := url.Parse(origin)
	if err != nil || !sameOrigin(link, base) {
		return "", invalid
	}
	return id, nil
}
func sameOrigin(a, b *url.URL) bool {
	port := func(u *url.URL) string {
		p := u.Port()
		if p == "" {
			if strings.EqualFold(u.Scheme, "http") {
				return "80"
			}
			if strings.EqualFold(u.Scheme, "https") {
				return "443"
			}
		}
		return p
	}
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b)
}

type projectGrantWire struct {
	ProjectID string            `json:"projectId"`
	UserID    string            `json:"userId"`
	Role      model.ProjectRole `json:"role"`
	Version   string            `json:"version"`
	CreatedAt time.Time         `json:"createdAt"`
	UpdatedAt time.Time         `json:"updatedAt"`
}
type projectAccessWire struct {
	ProjectID     string             `json:"projectId"`
	OwnerTeam     TeamRef            `json:"ownerTeam"`
	Ownership     ProjectOwnership   `json:"ownership"`
	TeamRole      *model.ProjectRole `json:"teamRole"`
	CanTransfer   bool               `json:"canTransfer"`
	EffectiveRole model.ProjectRole  `json:"effectiveRole"`
	DirectGrant   *projectGrantWire  `json:"directGrant"`
}

func mapProjectAccess(a *model.ProjectAccess) *projectAccessWire {
	if a == nil {
		return nil
	}
	out := &projectAccessWire{ProjectID: a.ProjectID, OwnerTeam: MapTeamRef(a.OwnerTeam), Ownership: ProjectOwnership{TeamID: a.Ownership.TeamID, Version: Decimal(a.Ownership.Version), UpdatedAt: a.Ownership.UpdatedAt.UTC()}, TeamRole: a.TeamRole, CanTransfer: a.CanTransfer, EffectiveRole: a.Role}
	if g := a.DirectGrant; g != nil {
		out.DirectGrant = &projectGrantWire{ProjectID: g.ProjectID, UserID: g.UserID, Role: g.Role, Version: Decimal(g.Version), CreatedAt: g.CreatedAt.UTC(), UpdatedAt: g.UpdatedAt.UTC()}
	}
	return out
}
func (h *projectTools) transfer(ctx context.Context, actor RequestActor, in projectTransferInput) (ToolResult, error) {
	target, err := teamIdentifier(in.ToTeam, h.origin)
	if err != nil {
		return ToolResult{}, err
	}
	refs := map[string]any{"projectId": in.ProjectID, "targetTeamId": target}
	var version int64
	if in.IfVersion != nil {
		version, err = ParseVersion(*in.IfVersion)
		if err != nil {
			return ToolResult{Refs: refs}, err
		}
	}
	preview, err := h.projects.TransferPreview(ctx, actor.Principal, in.ProjectID, target)
	if err != nil {
		return ToolResult{Refs: refs}, err
	}
	refs["sourceTeamId"] = preview.SourceTeam.ID
	if in.IfVersion != nil {
		preview.Ownership.Version = version
	}
	receipt, err := h.projects.Transfer(ctx, actor.Principal, in.ProjectID, coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target, Version: preview.TargetTeamVersion}, ExpectedUserID: actor.Principal.UserID})
	if err != nil {
		return ToolResult{Refs: refs}, err
	}
	outcome := "unchanged"
	if receipt.Changed {
		outcome = "changed"
	}
	return ToolResult{Data: map[string]any{"projectId": receipt.ProjectID, "changed": receipt.Changed, "sourceTeam": MapTeamRef(receipt.SourceTeam), "ownerTeam": MapTeamRef(receipt.OwnerTeam), "ownership": ProjectOwnership{TeamID: receipt.Ownership.TeamID, Version: Decimal(receipt.Ownership.Version), UpdatedAt: receipt.Ownership.UpdatedAt.UTC()}, "actorAccess": mapProjectAccess(receipt.ActorAccess)}, Outcome: outcome, WriteOutcome: "confirmed", Refs: refs}, nil
}
