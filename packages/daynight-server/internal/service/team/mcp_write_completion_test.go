package team

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

const mcpAdmissionTarget = "33333333-3333-4333-8333-333333333333"

type mcpUnknownWrite struct {
	store.TeamWriter
	store.SnapshotReader
	store.TeamWriteDAO
	store.WebhookEligibilityDAO
	t       *testing.T
	ctx     context.Context
	failure error
	pending []string
	calls   int
}

func (s *mcpUnknownWrite) call(ctx context.Context, method string) {
	if ctx != s.ctx || len(s.pending) == 0 || s.pending[0] != method {
		s.t.Fatalf("unexpected %s; expected %v", method, s.pending)
	}
	s.pending = s.pending[1:]
}
func (s *mcpUnknownWrite) WriteTeam(ctx context.Context, id string, operation func(store.TeamWriteScope) error) (store.Completion, error) {
	s.calls++
	if ctx != s.ctx || id != mcpAdmissionTeam || s.calls != 1 {
		s.t.Fatal("unexpected Team write")
	}
	if err := operation(s); err != nil {
		s.t.Fatalf("unexpected Team operation error: %v", err)
	}
	if len(s.pending) != 0 {
		s.t.Errorf("unconsumed write: %v", s.pending)
	}
	return store.Completion{Outcome: store.TransactionUnknown}, s.failure
}
func (s *mcpUnknownWrite) TeamDAO() store.TeamWriteDAO                 { return s }
func (s *mcpUnknownWrite) EligibilityDAO() store.WebhookEligibilityDAO { return s }
func mcpUnconfirmedTeam() model.Team {
	name := "Original"
	return model.Team{TeamRef: model.TeamRef{ID: mcpAdmissionTeam, Kind: "ordinary", Name: &name}, Version: 1, Membership: model.TeamMember{TeamID: mcpAdmissionTeam, UserID: mcpAdmissionUser, Role: model.ProjectAdmin, Version: 1}}
}
func (s *mcpUnknownWrite) Team(ctx context.Context, user string) (model.Team, error) {
	s.call(ctx, "Team")
	if user != mcpAdmissionUser {
		s.t.Errorf("Team user: %s", user)
	}
	return mcpUnconfirmedTeam(), nil
}
func (s *mcpUnknownWrite) Member(ctx context.Context, user string) (model.TeamMember, error) {
	s.call(ctx, "Member")
	return model.TeamMember{TeamID: mcpAdmissionTeam, UserID: user, Role: model.ProjectMemberRole, Version: 1}, nil
}
func (s *mcpUnknownWrite) Rename(ctx context.Context, user, name string) (model.Team, error) {
	s.call(ctx, "Rename")
	if user != mcpAdmissionUser || name != "Changed" {
		s.t.Errorf("Rename(%s, %s)", user, name)
	}
	result := mcpUnconfirmedTeam()
	result.Name = &name
	return result, nil
}
func (s *mcpUnknownWrite) HasProjects(ctx context.Context) (bool, error) {
	s.call(ctx, "HasProjects")
	return false, nil
}
func (s *mcpUnknownWrite) Delete(ctx context.Context) error { s.call(ctx, "Delete"); return nil }
func (s *mcpUnknownWrite) SetMemberRole(ctx context.Context, user string, role model.ProjectRole) (model.TeamMember, error) {
	s.call(ctx, "SetMemberRole")
	if user != mcpAdmissionTarget || role != model.ProjectAdmin {
		s.t.Errorf("SetMemberRole(%s, %s)", user, role)
	}
	return model.TeamMember{TeamID: mcpAdmissionTeam, UserID: user, Role: role, Version: 2}, nil
}
func (s *mcpUnknownWrite) RemoveMember(ctx context.Context, user string) error {
	s.call(ctx, "RemoveMember")
	if user != mcpAdmissionTarget && user != mcpAdmissionUser {
		s.t.Errorf("RemoveMember(%s)", user)
	}
	return nil
}
func (s *mcpUnknownWrite) LockAffected(ctx context.Context, filter store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	s.call(ctx, "LockAffected")
	if filter.TeamID != mcpAdmissionTeam {
		s.t.Errorf("eligibility filter: %+v", filter)
	}
	return nil, nil
}
func TestMCPTeamWritesPreserveUnknownCompletion(t *testing.T) {
	for _, method := range []string{"rename", "delete", "leave", "set_role", "remove"} {
		t.Run(method, func(t *testing.T) {
			cause := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("lost commit")}
			db := &mcpUnknownWrite{t: t, ctx: t.Context(), failure: cause}
			service := NewTeams(db)
			principal := model.Principal{Kind: model.PATCredential, UserID: mcpAdmissionUser, CredentialID: "44444444-4444-4444-8444-444444444444"}
			var err error
			switch method {
			case "rename":
				db.pending = []string{"Team", "Rename"}
				result, failure := service.Rename(t.Context(), principal, mcpAdmissionTeam, coreteam.ChangeTeam{Name: "Changed", Version: 1, ExpectedUserID: principal.UserID})
				err = failure
				if result.ID != "" {
					t.Errorf("uncertain rename exposed data: %+v", result)
				}
			case "delete":
				db.pending = []string{"Team", "HasProjects", "Delete", "LockAffected"}
				err = service.Delete(t.Context(), principal, mcpAdmissionTeam, coreteam.ChangeTeam{Name: "Original", Version: 1, ExpectedUserID: principal.UserID})
			default:
				target := mcpAdmissionTarget
				if method == "leave" {
					target = mcpAdmissionUser
				}
				db.pending = []string{"Team", "Member", "RemoveMember", "LockAffected"}
				input := coreteam.ChangeTeamMember{Version: 1, ExpectedUserID: principal.UserID}
				var result coreteam.TeamMemberResult
				if method == "set_role" {
					input.Role = model.ProjectAdmin
					db.pending = []string{"Team", "Member", "SetMemberRole", "LockAffected"}
					result, err = service.SetMemberRole(t.Context(), principal, mcpAdmissionTeam, target, input)
				} else {
					result, err = service.RemoveMember(t.Context(), principal, mcpAdmissionTeam, target, input)
				}
				if result.Membership.UserID != "" || result.ActorRole != nil {
					t.Errorf("uncertain membership exposed data: %+v", result)
				}
			}
			if !errors.Is(err, cause) || db.calls != 1 || len(db.pending) != 0 {
				t.Fatalf("unknown completion = %v; writes=%d pending=%v", err, db.calls, db.pending)
			}
		})
	}
}
