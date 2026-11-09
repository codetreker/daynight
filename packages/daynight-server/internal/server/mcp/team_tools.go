package mcp

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed team_tools.json
var teamToolsJSON []byte

type teamArguments struct {
	Team         string            `json:"team"`
	Name         string            `json:"name"`
	ExpectedName *string           `json:"expectedName"`
	IfVersion    *string           `json:"ifVersion"`
	UserID       string            `json:"userId"`
	Role         model.ProjectRole `json:"role"`
	Limit        *int              `json:"limit"`
	Cursor       *string           `json:"cursor"`
}

func (a teamArguments) page() model.PageRequest {
	limit := 50
	if a.Limit != nil {
		limit = *a.Limit
	}
	return model.PageRequest{Limit: limit, Cursor: a.Cursor}
}
func observedVersion(input *string, observed int64) (int64, error) {
	if input == nil {
		return observed, nil
	}
	v, err := ParseVersion(*input)
	if err != nil {
		return 0, err
	}
	if v != observed {
		return 0, &model.Fault{Code: "version_conflict", Message: "The observed version does not match."}
	}
	return v, nil
}
func mapTeamMember(m model.TeamMember) TeamMember {
	return TeamMember{TeamID: m.TeamID, UserID: m.UserID, Role: m.Role, Version: Decimal(m.Version), CreatedAt: m.CreatedAt.UTC(), UpdatedAt: m.UpdatedAt.UTC()}
}

type teamMemberProfile struct {
	Name      *string `json:"name"`
	Email     *string `json:"email"`
	AvatarURL *string `json:"avatarUrl"`
}
type teamMemberWithProfile struct {
	TeamMember
	Profile teamMemberProfile `json:"profile"`
}
type teamListData[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

func checkTeamBody(value any) error {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return err
	}
	body := encoded.Bytes()
	// JSON.stringify emits U+2028 and U+2029 literally; Go's encoder escapes
	// them even with HTML escaping disabled. Ignore escaped backslashes so a
	// literal "\\u2028" remains six characters in the input value.
	size := len(body) - 1 // Encoder appends a newline.
	for i := 0; i < len(body); i++ {
		if body[i] != '\\' || i+1 >= len(body) {
			continue
		}
		if i+5 < len(body) && body[i+1] == 'u' && body[i+2] == '2' && body[i+3] == '0' && body[i+4] == '2' && (body[i+5] == '8' || body[i+5] == '9') {
			size -= 3 // Six ASCII bytes encode a three-byte UTF-8 rune.
			i += 5
		} else {
			i++
		}
	}
	if size > httpx.MaxJSONBody {
		return &model.Fault{Code: "invalid_input", Message: "request body must be valid JSON within the 1 MiB limit"}
	}
	return nil
}

// RegisterTeamTools exposes the Team use cases through the common MCP wrapper.
func RegisterTeamTools(e *Entry, teams *teamservice.Teams, projects *projectservice.Projects, identities *identity.Identity) error {
	if e == nil || teams == nil || projects == nil || identities == nil {
		return fmt.Errorf("Team tool dependencies are required")
	}
	var tools []sdk.Tool
	if err := json.Unmarshal(teamToolsJSON, &tools); err != nil {
		return err
	}
	for i := range tools {
		tool := &tools[i]
		name := tool.Name
		class := BudgetControl
		if name == "team_list" || name == "team_projects" || name == "team_member_list" {
			class = BudgetLarge
		}
		budget := func(json.RawMessage) BudgetClass { return class }
		handler := func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
			if err := ValidateUnicodeFields(raw, "name", "expectedName"); err != nil {
				return ToolResult{}, err
			}
			var a teamArguments
			if err := json.Unmarshal(raw, &a); err != nil {
				return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
			}
			return teamTool(ctx, actor, name, a, teams, projects, identities)
		}
		var err error
		switch name {
		case "team_list", "team_show", "team_projects", "team_member_list":
			err = e.registerReadTool(tool, budget, handler)
		default:
			err = e.registerTool(tool, budget, handler)
		}
		if err != nil {
			return fmt.Errorf("register %s: %w", name, err)
		}
	}
	return nil
}

func teamTool(ctx context.Context, actor RequestActor, name string, a teamArguments, teams *teamservice.Teams, projects *projectservice.Projects, identities *identity.Identity) (ToolResult, error) {
	p := actor.Principal
	if name == "team_create" {
		if err := checkTeamBody(api.CreateTeamRequest{Name: a.Name, ExpectedUserID: p.UserID}); err != nil {
			return ToolResult{WriteOutcome: "not_committed"}, err
		}
		t, err := teams.Create(ctx, p, coreteam.CreateTeam{Name: a.Name, ExpectedUserID: p.UserID})
		if err != nil {
			var failure *teamservice.CreationError
			if errors.As(err, &failure) {
				return ToolResult{Refs: map[string]any{"teamId": failure.TeamID}}, err
			}
			return ToolResult{}, err
		}
		return ToolResult{Data: MapTeam(t), Outcome: "changed", WriteOutcome: "confirmed", Refs: map[string]any{"teamId": t.ID}}, nil
	}
	if name == "team_list" {
		project := func(teams []model.Team, cursor *string) teamListData[Team] {
			page := teamListData[Team]{Items: make([]Team, 0, len(teams)), NextCursor: cursor}
			for _, team := range teams {
				page.Items = append(page.Items, MapTeam(team))
			}
			return page
		}
		result, err := teams.List(ctx, p, a.page())
		if err != nil {
			return ToolResult{}, err
		}
		return ToolResult{Data: project(result.Items, result.NextCursor)}, nil
	}

	// Failures before a business mutation starts establish that this tool did
	// not commit a write, even if a separate read transaction is uncertain.
	preflight := ToolResult{}
	switch name {
	case "team_rename", "team_delete", "team_leave", "team_member_set_role", "team_member_remove":
		preflight.WriteOutcome = "not_committed"
	}
	id, err := ResolveTeamID(ctx, identities, p, a.Team)
	if err != nil {
		return preflight, err
	}
	switch name {
	case "team_show":
		t, err := teams.Get(ctx, p, id)
		if err != nil {
			return ToolResult{}, err
		}
		return ToolResult{Data: MapTeam(t)}, nil
	case "team_rename", "team_delete":
		t, err := teams.Get(ctx, p, id)
		if err != nil {
			return preflight, err
		}
		version, err := observedVersion(a.IfVersion, t.Version)
		if err != nil {
			return ToolResult{WriteOutcome: "not_committed"}, err
		}
		if name == "team_rename" {
			if err := checkTeamBody(api.ChangeTeamRequest{Name: a.Name, Version: version, ExpectedUserID: p.UserID}); err != nil {
				return ToolResult{WriteOutcome: "not_committed"}, err
			}
			result, err := teams.Rename(ctx, p, id, coreteam.ChangeTeam{Name: a.Name, Version: version, ExpectedUserID: p.UserID})
			if err != nil {
				return ToolResult{Refs: map[string]any{"teamId": id}}, err
			}
			outcome := "changed"
			if t.Name != nil && *t.Name == a.Name {
				outcome = "unchanged"
			}
			return ToolResult{Data: MapTeam(result), Outcome: outcome, WriteOutcome: "confirmed", Refs: map[string]any{"teamId": id}}, nil
		}
		expected := "personal"
		if t.Name != nil {
			expected = *t.Name
		}
		if a.ExpectedName != nil {
			expected = *a.ExpectedName
		}
		if err := checkTeamBody(api.ChangeTeamRequest{Name: expected, Version: version, ExpectedUserID: p.UserID}); err != nil {
			return ToolResult{WriteOutcome: "not_committed"}, err
		}
		err = teams.Delete(ctx, p, id, coreteam.ChangeTeam{Name: expected, Version: version, ExpectedUserID: p.UserID})
		if err != nil {
			return ToolResult{Refs: map[string]any{"teamId": id}}, err
		}
		return ToolResult{Data: map[string]any{"teamId": id, "deleted": true}, Outcome: "changed", WriteOutcome: "confirmed", Refs: map[string]any{"teamId": id}}, nil
	case "team_projects":
		project := func(items []model.Project, cursor *string) teamListData[Project] {
			page := teamListData[Project]{Items: make([]Project, 0, len(items)), NextCursor: cursor}
			for _, item := range items {
				page.Items = append(page.Items, MapProject(item))
			}
			return page
		}
		scope := coreproject.ProjectListRequest{Page: a.page(), TeamID: &id}
		result, err := projects.ListScoped(ctx, p, scope)
		if err != nil {
			return ToolResult{}, err
		}
		return ToolResult{Data: project(result.Items, result.NextCursor)}, nil

	case "team_member_list":
		project := func(members []model.TeamMemberProfile, cursor *string) teamListData[teamMemberWithProfile] {
			page := teamListData[teamMemberWithProfile]{Items: make([]teamMemberWithProfile, 0, len(members)), NextCursor: cursor}
			for _, m := range members {
				page.Items = append(page.Items, teamMemberWithProfile{TeamMember: mapTeamMember(m.Membership), Profile: teamMemberProfile{Name: m.Profile.Name, Email: m.Profile.Email, AvatarURL: m.Profile.AvatarURL}})
			}
			return page
		}
		result, err := teams.MembersPage(ctx, p, id, a.page())
		if err != nil {
			return ToolResult{}, err
		}
		return ToolResult{Data: project(result.Items, result.NextCursor)}, nil

	case "team_leave", "team_member_set_role", "team_member_remove":
		target := a.UserID
		if name == "team_leave" {
			target = p.UserID
		}
		m, err := teams.Member(ctx, p, id, target)
		if err != nil {
			return preflight, err
		}
		version, err := observedVersion(a.IfVersion, m.Version)
		if err != nil {
			return ToolResult{WriteOutcome: "not_committed"}, err
		}
		input := coreteam.ChangeTeamMember{Version: version, Role: a.Role, ExpectedUserID: p.UserID}
		if name == "team_member_set_role" {
			if err := checkTeamBody(api.SetTeamMemberRoleRequest{Version: version, Role: string(a.Role), ExpectedUserID: p.UserID}); err != nil {
				return ToolResult{WriteOutcome: "not_committed"}, err
			}
			result, err := teams.SetMemberRole(ctx, p, id, target, input)
			if err != nil {
				return ToolResult{Refs: map[string]any{"teamId": id, "userId": target}}, err
			}
			outcome := "changed"
			if m.Role == a.Role {
				outcome = "unchanged"
			}
			return ToolResult{Data: map[string]any{"membership": mapTeamMember(result.Membership), "actorRole": result.ActorRole}, Outcome: outcome, WriteOutcome: "confirmed", Refs: map[string]any{"teamId": id, "userId": target}}, nil
		}
		if err := checkTeamBody(api.RemoveTeamMemberRequest{Version: version, ExpectedUserID: p.UserID}); err != nil {
			return ToolResult{WriteOutcome: "not_committed"}, err
		}
		result, err := teams.RemoveMember(ctx, p, id, target, input)
		if err != nil {
			return ToolResult{Refs: map[string]any{"teamId": id, "userId": target}}, err
		}
		return ToolResult{Data: map[string]any{"teamId": id, "userId": target, "removed": true, "actorRole": result.ActorRole}, Outcome: "changed", WriteOutcome: "confirmed", Refs: map[string]any{"teamId": id, "userId": target}}, nil
	}
	return ToolResult{}, fmt.Errorf("unknown Team tool %q", name)
}
