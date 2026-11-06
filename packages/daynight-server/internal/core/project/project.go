package project

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

type CreateProject struct {
	Name, RepoURL  string
	TeamID         *string
	ExpectedUserID string
}
type ProjectListRequest struct {
	Page   model.PageRequest
	TeamID *string
	Shared bool
}
type ProjectPage struct {
	Items      []model.Project
	NextCursor *string
	Oversized  *model.Project
}

func invalidInput(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }
func ProjectNotFound(cause error) error {
	return &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: cause}
}
func LookupError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return ProjectNotFound(err)
	}
	return err
}
func ValidateCreate(p model.Principal, input CreateProject) error {
	if err := ValidateCreateFields(p, input); err != nil {
		return err
	}
	return validateRepoURL(input.RepoURL)
}

// ValidateCreateFields validates the common creation fields independently of
// the repository syntax used by each registration entry point.
func ValidateCreateFields(p model.Principal, input CreateProject) error {
	if err := team.RequireActor(p, input.ExpectedUserID); err != nil {
		return err
	}
	if input.TeamID != nil {
		if _, err := team.CanonicalID(*input.TeamID); err != nil {
			return err
		}
	}
	if strings.TrimSpace(input.Name) == "" || !utf8.ValidString(input.Name) || strings.ContainsRune(input.Name, 0) {
		return invalidInput("Project name must be nonempty UTF-8 text without NUL characters.")
	}
	return nil
}
func Create(ctx context.Context, dao store.ProjectCreationDAO, userID, id string, input CreateProject) (model.Project, model.ProjectAccess, error) {
	var teamID string
	if input.TeamID == nil {
		facts, err := dao.CreationPersonalTeam(ctx, true)
		if err != nil {
			return model.Project{}, model.ProjectAccess{}, err
		}
		if err := team.ValidatePersonalTeam(facts); err != nil {
			return model.Project{}, model.ProjectAccess{}, err
		}
		teamID = facts.ID
	} else {
		target, err := dao.LockCreationTeam(ctx, *input.TeamID)
		if err != nil {
			return model.Project{}, model.ProjectAccess{}, err
		}
		teamID = target.ID
		if target.PersonalUserID != nil {
			if *target.PersonalUserID != userID {
				return model.Project{}, model.ProjectAccess{}, model.ErrNotFound
			}
			facts, err := dao.CreationPersonalTeam(ctx, false)
			if err != nil {
				return model.Project{}, model.ProjectAccess{}, err
			}
			if err := team.ValidatePersonalTeam(facts); err != nil {
				return model.Project{}, model.ProjectAccess{}, err
			}
		} else {
			member, err := dao.CreationTeamMember(ctx, teamID)
			if err != nil {
				return model.Project{}, model.ProjectAccess{}, err
			}
			if !member {
				return model.Project{}, model.ProjectAccess{}, model.ErrNotFound
			}
		}
	}
	return dao.InsertProject(ctx, id, input.Name, input.RepoURL, teamID)
}

// ProjectWriteError maps a missing locked Project only after a confirmed rollback.
func ProjectWriteError(err error) error {
	var failure *store.TransactionError
	if errors.As(err, &failure) {
		if failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted || failure.Phase != "operation" {
			return err
		}
	}
	var fault *model.Fault
	if errors.As(err, &fault) {
		return err
	}
	return LookupError(err)
}

func ValidateRead(p model.Principal, id string) (string, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return "", err
	}
	return model.CanonicalID(id)
}

type ProjectAccessReader interface {
	ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

func RequireProjectRead(ctx context.Context, reader ProjectAccessReader, p model.Principal, id string) (model.ProjectAccess, error) {
	id, err := ValidateRead(p, id)
	if err != nil {
		return model.ProjectAccess{}, err
	}
	access, err := reader.ProjectAccess(ctx, p, id)
	return access, LookupError(err)
}
func RequireProjectWrite(ctx context.Context, dao store.ProjectWriteDAO, p model.Principal) (model.ProjectAccess, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return model.ProjectAccess{}, err
	}
	access, err := dao.ProjectAccess(ctx, p)
	return access, LookupError(err)
}
func RequireProjectAdmin(access model.ProjectAccess) error {
	if access.Role != model.ProjectAdmin {
		return &model.Fault{Code: "forbidden", Message: "Project administrator access is required."}
	}
	return nil
}
func Get(ctx context.Context, dao store.ProjectReader, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
	access, err := RequireProjectRead(ctx, dao, p, id)
	if err != nil {
		return model.Project{}, model.ProjectAccess{}, err
	}
	value, err := dao.Project(ctx, id)
	if errors.Is(err, model.ErrNotFound) {
		err = ProjectNotFound(err)
	}
	return value, access, err
}
func listScope(p model.Principal, request ProjectListRequest) (model.Principal, store.ProjectScope, store.Page, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return p, store.ProjectScope{}, store.Page{}, err
	}
	userID, _ := model.CanonicalID(p.UserID)
	p.UserID = userID
	scope := store.ProjectScope{Kind: store.ProjectScopeAll}
	if request.TeamID != nil {
		if request.Shared {
			return p, scope, store.Page{}, invalidInput("teamId and shared are mutually exclusive.")
		}
		teamID, err := model.CanonicalID(*request.TeamID)
		if err != nil {
			return p, scope, store.Page{}, err
		}
		scope = store.ProjectScope{Kind: store.ProjectScopeTeam, TeamID: teamID}
	} else if request.Shared {
		scope.Kind = store.ProjectScopeShared
	}
	page, err := query.ProjectListPage(request.Page, userID, scope)
	return p, scope, page, err
}
func ValidateList(p model.Principal, request ProjectListRequest) error {
	_, _, _, err := listScope(p, request)
	return err
}
func ReadList(ctx context.Context, dao store.ProjectReader, p model.Principal, request ProjectListRequest) (store.ProjectPage, error) {
	return ReadListBounded(ctx, dao, p, request, 0)
}

func ReadListBounded(ctx context.Context, dao store.ProjectReader, p model.Principal, request ProjectListRequest, maxItemBytes int) (store.ProjectPage, error) {
	p, scope, page, err := listScope(p, request)
	if err != nil {
		return store.ProjectPage{}, err
	}
	scope.MaxItemBytes = maxItemBytes
	result, err := dao.ScopedProjects(ctx, p, scope, page)
	if errors.Is(err, model.ErrNotFound) {
		return store.ProjectPage{}, &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: err}
	}
	return result, err
}

func FinishList(p model.Principal, request ProjectListRequest, result store.ProjectPage) (ProjectPage, error) {
	p, scope, _, err := listScope(p, request)
	if err != nil {
		return ProjectPage{}, err
	}
	response := ProjectPage{Items: result.Items, Oversized: result.Oversized}
	if result.HasMore && result.Oversized == nil {
		last := result.Items[len(result.Items)-1]
		cursor, err := query.EncodeProjectCursor(last, p.UserID, scope)
		if err != nil {
			return ProjectPage{}, fmt.Errorf("encode project cursor: %w", err)
		}
		response.NextCursor = &cursor
	}
	return response, nil
}
