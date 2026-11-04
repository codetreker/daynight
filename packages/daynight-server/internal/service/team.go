package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type Teams struct{ store *store.Store }

func NewTeams(database *store.Store) *Teams { return &Teams{store: database} }

type CreateTeam struct {
	Name           string
	ExpectedUserID string
}

type ChangeTeam struct {
	Name           string
	Version        int64
	ExpectedUserID string
}

type TeamPage struct {
	Items      []core.Team
	NextCursor *string
}

func validateTeamName(name string) error {
	if !utf8.ValidString(name) || strings.ContainsRune(name, 0) || strings.TrimSpace(name) == "" {
		return invalidInput("Team name must be nonempty Unicode text without NUL characters.")
	}
	return nil
}

func requireTeamActor(principal core.Principal, expectedUserID string) error {
	if err := requirePrincipal(principal); err != nil {
		return err
	}
	expected, err := CanonicalID(expectedUserID)
	if err != nil || expected != expectedUserID {
		return invalidInput("expectedUserId must be a canonical user UUID.")
	}
	if expected != principal.UserID {
		return &Fault{Code: "identity_mismatch", Message: "The signed-in account changed. Review the Team operation again."}
	}
	return nil
}

func canonicalTeamID(id string) (string, error) {
	canonical, err := CanonicalID(id)
	if err != nil || canonical != id {
		return "", invalidInput("Team ID must be a canonical UUID.")
	}
	return canonical, nil
}

func (s *Teams) Create(ctx context.Context, principal core.Principal, input CreateTeam) (core.Team, error) {
	if err := requireTeamActor(principal, input.ExpectedUserID); err != nil {
		return core.Team{}, err
	}
	if err := validateTeamName(input.Name); err != nil {
		return core.Team{}, err
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return core.Team{}, fmt.Errorf("generate Team ID: %w", err)
	}
	return s.store.CreateTeam(ctx, principal.UserID, id.String(), input.Name)
}

func (s *Teams) Get(ctx context.Context, principal core.Principal, teamID string) (core.Team, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.Team{}, err
	}
	id, err := canonicalTeamID(teamID)
	if err != nil {
		return core.Team{}, err
	}
	var result core.Team
	var missing error
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		var err error
		result, err = snapshot.Team(ctx, principal.UserID, id)
		if errors.Is(err, core.ErrNotFound) {
			missing = err
			return nil
		}
		return err
	})
	if err != nil {
		return core.Team{}, err
	}
	if missing != nil {
		return core.Team{}, &Fault{Code: "not_found", Message: "Team was not found.", Cause: missing}
	}
	return result, nil
}

func (s *Teams) List(ctx context.Context, principal core.Principal, request PageRequest) (TeamPage, error) {
	if err := requirePrincipal(principal); err != nil {
		return TeamPage{}, err
	}
	scope := listScope{Kind: "teams", UserID: principal.UserID}
	page, err := listPage(request, scope)
	if err != nil {
		return TeamPage{}, err
	}
	var result store.TeamPage
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		var err error
		result, err = snapshot.Teams(ctx, principal.UserID, page)
		return err
	})
	if err != nil {
		return TeamPage{}, err
	}
	response := TeamPage{Items: result.Items}
	if result.HasMore {
		last := result.Items[len(result.Items)-1]
		cursor, err := encodeListCursor(scope, last.CreatedAt, last.ID)
		if err != nil {
			return TeamPage{}, fmt.Errorf("encode Team cursor: %w", err)
		}
		response.NextCursor = &cursor
	}
	return response, nil
}

func (s *Teams) write(ctx context.Context, principal core.Principal, teamID string, input ChangeTeam, operation func(*store.TeamTx, core.Team) error) error {
	if err := requireTeamActor(principal, input.ExpectedUserID); err != nil {
		return err
	}
	id, err := canonicalTeamID(teamID)
	if err != nil {
		return err
	}
	if input.Version < 1 {
		return invalidInput("Version must be a positive integer.")
	}
	if err := validateTeamName(input.Name); err != nil {
		return err
	}
	return s.store.WriteTeam(ctx, id, func(tx *store.TeamTx) error {
		team, err := tx.Team(ctx, principal.UserID)
		if err != nil {
			return err
		}
		if team.Membership.Role != core.ProjectAdmin {
			return &Fault{Code: "forbidden", Message: "Team administrator access is required."}
		}
		if team.Kind == "personal" {
			return &Fault{Code: "personal_team_immutable", Message: "Personal Team cannot be changed or deleted."}
		}
		if team.Version != input.Version {
			return &Fault{Code: "version_conflict", Message: "Team version does not match."}
		}
		return operation(tx, team)
	})
}

func (s *Teams) Rename(ctx context.Context, principal core.Principal, teamID string, input ChangeTeam) (core.Team, error) {
	var result core.Team
	err := s.write(ctx, principal, teamID, input, func(tx *store.TeamTx, team core.Team) error {
		if *team.Name == input.Name {
			result = team
			return nil
		}
		if team.Version == math.MaxInt64 {
			return &Fault{Code: "version_exhausted", Message: "Team version is exhausted."}
		}
		var err error
		result, err = tx.Rename(ctx, principal.UserID, input.Name)
		return err
	})
	return result, err
}

func (s *Teams) Delete(ctx context.Context, principal core.Principal, teamID string, input ChangeTeam) error {
	return s.write(ctx, principal, teamID, input, func(tx *store.TeamTx, team core.Team) error {
		if *team.Name != input.Name {
			return &Fault{Code: "version_conflict", Message: "Team name does not match the confirmed version."}
		}
		occupied, err := tx.HasProjects(ctx)
		if err != nil {
			return err
		}
		if occupied {
			return &Fault{Code: "team_not_empty", Message: "Transfer every Project before deleting the Team."}
		}
		return tx.Delete(ctx)
	})
}

// TeamResponseFault preserves transaction completion evidence before inspecting
// nested domain refusals. Uncertain COMMIT cannot be reported as a rejection.
func TeamResponseFault(err error) (*Fault, bool) {
	var transaction *store.TransactionError
	if !errors.As(err, &transaction) {
		return nil, false
	}
	if transaction.CleanupFailed {
		return &Fault{Code: "internal_error", Message: "The request could not be completed.", Cause: err}, true
	}
	if transaction.CommitAttempted && transaction.Outcome == store.TransactionUnknown {
		return &Fault{Code: "write_outcome_unknown", Message: "The write outcome is unknown. Read the current resource before deciding on another operation.", Cause: err}, true
	}
	if transaction.Phase != "operation" || transaction.Outcome != store.TransactionNotCommitted {
		return &Fault{Code: "internal_error", Message: "The request could not be completed.", Cause: err}, true
	}
	if errors.Is(err, core.ErrNotFound) {
		return &Fault{Code: "not_found", Message: "Team was not found.", Cause: err}, true
	}
	return nil, false
}
