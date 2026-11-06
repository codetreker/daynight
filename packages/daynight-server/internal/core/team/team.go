package team

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type CreateTeam struct{ Name, ExpectedUserID string }
type ChangeTeam struct {
	Name           string
	Version        int64
	ExpectedUserID string
}
type TeamPage struct {
	Items      []model.Team
	NextCursor *string
}

func invalidInput(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }
func ValidateName(name string) error {
	if !utf8.ValidString(name) || strings.ContainsRune(name, 0) || strings.TrimSpace(name) == "" {
		return invalidInput("Team name must be nonempty Unicode text without NUL characters.")
	}
	return nil
}
func RequireActor(principal model.Principal, expectedUserID string) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	expected, err := model.CanonicalID(expectedUserID)
	if err != nil || expected != expectedUserID {
		return invalidInput("expectedUserId must be a canonical user UUID.")
	}
	if expected != principal.UserID {
		return &model.Fault{Code: "identity_mismatch", Message: "The signed-in account changed. Review the Team operation again."}
	}
	return nil
}
func CanonicalID(id string) (string, error) {
	canonical, err := model.CanonicalID(id)
	if err != nil || canonical != id {
		return "", invalidInput("Team ID must be a canonical UUID.")
	}
	return canonical, nil
}
func ValidateCreate(p model.Principal, input CreateTeam) error {
	if err := RequireActor(p, input.ExpectedUserID); err != nil {
		return err
	}
	return ValidateName(input.Name)
}
func Create(ctx context.Context, dao store.TeamCreationDAO, input CreateTeam) (model.Team, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return model.Team{}, fmt.Errorf("generate Team ID: %w", err)
	}
	return dao.InsertTeam(ctx, id.String(), input.Name)
}
func ValidateRead(p model.Principal, id string) (string, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return "", err
	}
	return CanonicalID(id)
}
func Get(ctx context.Context, dao store.TeamReader, p model.Principal, id string) (model.Team, error) {
	result, err := dao.Team(ctx, p.UserID, id)
	if errors.Is(err, model.ErrNotFound) {
		return model.Team{}, &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: err}
	}
	return result, err
}
func List(ctx context.Context, dao store.TeamReader, p model.Principal, request model.PageRequest) (TeamPage, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return TeamPage{}, err
	}
	scope := query.ListScope{Kind: "teams", UserID: p.UserID}
	page, err := query.ListPage(request, scope)
	if err != nil {
		return TeamPage{}, err
	}
	result, err := dao.Teams(ctx, p.UserID, page)
	if err != nil {
		return TeamPage{}, err
	}
	response := TeamPage{Items: result.Items}
	if result.HasMore {
		last := result.Items[len(result.Items)-1]
		cursor, err := query.EncodeListCursor(scope, last.CreatedAt, last.ID)
		if err != nil {
			return TeamPage{}, fmt.Errorf("encode Team cursor: %w", err)
		}
		response.NextCursor = &cursor
	}
	return response, nil
}

// GetBounded and ListBounded are protocol projections that reject oversized
// names before materializing them. Ordinary Team reads keep their full contract.
func GetBounded(ctx context.Context, dao store.TeamReader, p model.Principal, id string, limit int) (model.Team, error) {
	t, oversized, err := dao.TeamBounded(ctx, p.UserID, id, limit)
	if errors.Is(err, model.ErrNotFound) {
		return model.Team{}, &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: err}
	}
	if err != nil {
		return model.Team{}, err
	}
	if oversized {
		return model.Team{}, &model.Fault{Code: "payload_too_large", Message: fmt.Sprintf("Team %s exceeds the read budget.", id)}
	}
	return t, nil
}
func ListBounded(ctx context.Context, dao store.TeamReader, p model.Principal, request model.PageRequest, limit int) (TeamPage, error) {
	scope := query.ListScope{Kind: "teams", UserID: p.UserID}
	page, err := query.ListPage(request, scope)
	if err != nil {
		return TeamPage{}, err
	}
	result, err := dao.TeamsBounded(ctx, p.UserID, page, limit)
	if err != nil {
		return TeamPage{}, err
	}
	if result.OversizedTeamID != "" {
		return TeamPage{}, &model.Fault{Code: "payload_too_large", Message: fmt.Sprintf("Team %s exceeds the list budget.", result.OversizedTeamID)}
	}
	response := TeamPage{Items: result.Items}
	if result.HasMore {
		last := result.Items[len(result.Items)-1]
		cursor, err := query.EncodeListCursor(scope, last.CreatedAt, last.ID)
		if err != nil {
			return TeamPage{}, fmt.Errorf("encode Team cursor: %w", err)
		}
		response.NextCursor = &cursor
	}
	return response, nil
}

func ValidateChange(p model.Principal, id string, input ChangeTeam) (string, error) {
	if err := RequireActor(p, input.ExpectedUserID); err != nil {
		return "", err
	}
	id, err := CanonicalID(id)
	if err != nil {
		return "", err
	}
	if input.Version < 1 {
		return "", invalidInput("Version must be a positive integer.")
	}
	if err := ValidateName(input.Name); err != nil {
		return "", err
	}
	return id, nil
}
func writableTeam(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, input ChangeTeam) (model.Team, error) {
	t, err := dao.Team(ctx, p.UserID)
	if err != nil {
		return model.Team{}, err
	}
	if t.Membership.Role != model.ProjectAdmin {
		return model.Team{}, &model.Fault{Code: "forbidden", Message: "Team administrator access is required."}
	}
	if t.Kind == "personal" {
		return model.Team{}, &model.Fault{Code: "personal_team_immutable", Message: "Personal Team cannot be changed or deleted."}
	}
	if t.Version != input.Version {
		return model.Team{}, &model.Fault{Code: "version_conflict", Message: "Team version does not match."}
	}
	return t, nil
}
func Rename(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, input ChangeTeam) (model.Team, error) {
	t, err := writableTeam(ctx, dao, p, input)
	if err != nil {
		return model.Team{}, err
	}
	if *t.Name == input.Name {
		return t, nil
	}
	if t.Version == math.MaxInt64 {
		return model.Team{}, &model.Fault{Code: "version_exhausted", Message: "Team version is exhausted."}
	}
	return dao.Rename(ctx, p.UserID, input.Name)
}
func Delete(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, input ChangeTeam) error {
	t, err := writableTeam(ctx, dao, p, input)
	if err != nil {
		return err
	}
	if *t.Name != input.Name {
		return &model.Fault{Code: "version_conflict", Message: "Team name does not match the confirmed version."}
	}
	occupied, err := dao.HasProjects(ctx)
	if err != nil {
		return err
	}
	if occupied {
		return &model.Fault{Code: "team_not_empty", Message: "Transfer every Project before deleting the Team."}
	}
	return dao.Delete(ctx)
}

// WriteFault preserves transaction completion evidence before inspecting nested domain refusals.
func WriteFault(err error) (*model.Fault, bool) {
	var transaction *store.TransactionError
	if !errors.As(err, &transaction) {
		return nil, false
	}
	if transaction.CleanupFailed {
		return &model.Fault{Code: "internal_error", Message: "The request could not be completed.", Cause: err}, true
	}
	if transaction.CommitAttempted && transaction.Outcome == store.TransactionUnknown {
		return &model.Fault{Code: "write_outcome_unknown", Message: "The write outcome is unknown. Read the current resource before deciding on another operation.", Cause: err}, true
	}
	if transaction.Phase != "operation" || transaction.Outcome != store.TransactionNotCommitted {
		return &model.Fault{Code: "internal_error", Message: "The request could not be completed.", Cause: err}, true
	}
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: err}, true
	}
	return nil, false
}
