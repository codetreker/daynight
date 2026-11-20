package mcp

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

func scopeProtected(service any) bool {
	protected, ok := service.(interface{ ScopeProtected() bool })
	return ok && protected.ScopeProtected()
}

// Every preflight read is an actual business call, even when the caller supplied
// its own version. The protected service checks each operation after its existing
// visibility check and before returning data or performing a mutation.
func teamToolOperations(name string, p model.Principal, a teamArguments) ([]scopepolicy.Operation, bool, error) {
	switch name {
	case "team_list", "team_show", "team_member_list":
		return []scopepolicy.Operation{scopepolicy.TeamRead}, false, nil
	case "team_projects":
		return []scopepolicy.Operation{scopepolicy.TeamRead, scopepolicy.ProjectRead}, false, nil
	case "team_create":
		return []scopepolicy.Operation{scopepolicy.TeamWrite}, true, nil
	case "team_rename":
		return []scopepolicy.Operation{scopepolicy.TeamRead, scopepolicy.TeamWrite}, true, nil
	case "team_delete":
		return []scopepolicy.Operation{scopepolicy.TeamRead, scopepolicy.TeamDelete}, true, nil
	case "team_leave":
		return []scopepolicy.Operation{scopepolicy.TeamRead, scopepolicy.TeamLeave}, true, nil
	case "team_member_set_role":
		return []scopepolicy.Operation{scopepolicy.TeamRead, scopepolicy.TeamMembers}, true, nil
	case "team_member_remove":
		if a.UserID == p.UserID {
			return []scopepolicy.Operation{scopepolicy.TeamRead, scopepolicy.TeamLeave}, true, nil
		}
		return []scopepolicy.Operation{scopepolicy.TeamRead, scopepolicy.TeamMembers}, true, nil
	default:
		return nil, false, fmt.Errorf("unclassified Team tool %q", name)
	}
}

func (a *invitationAdapter) invitationToolOperations(name string, in invitationInput) ([]scopepolicy.Operation, bool, error) {
	switch name {
	case "team_invitation_create", "team_invitation_revoke":
		return []scopepolicy.Operation{scopepolicy.TeamInvitations}, true, nil
	case "team_invitation_list":
		return []scopepolicy.Operation{scopepolicy.TeamInvitations}, false, nil
	case "invitation_inspect", "invitation_accept":
		write := name == "invitation_accept"
		scope, _, err := a.parseLink(in.Link)
		if err != nil {
			return nil, write, err
		}
		if scope == "team" {
			if write {
				return []scopepolicy.Operation{scopepolicy.TeamInvitationAccept, scopepolicy.TeamInvitationRead}, true, nil
			}
			return []scopepolicy.Operation{scopepolicy.TeamInvitationRead}, false, nil
		}
		if write {
			return []scopepolicy.Operation{scopepolicy.ProjectInvitationAccept}, true, nil
		}
		return []scopepolicy.Operation{scopepolicy.ProjectInvitationRead}, false, nil
	default:
		return nil, false, fmt.Errorf("unclassified invitation tool %q", name)
	}
}

func requireTeamToolScopes(ctx context.Context, provider teamservice.AuthorizationProvider, principal model.Principal, operations ...scopepolicy.Operation) error {
	authorization, err := provider(ctx, principal)
	if err != nil {
		return err
	}
	if authorization.Principal != principal {
		return fmt.Errorf("credential authorization principal mismatch")
	}
	return coreteam.RequireScope(authorization, operations...)
}
