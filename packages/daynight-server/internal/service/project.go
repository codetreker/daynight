package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type Projects struct {
	store *store.Store
}

func NewProjects(database *store.Store) *Projects { return &Projects{store: database} }

type CreateProject struct {
	Name    string
	RepoURL string
}

type PageRequest struct {
	Limit  int
	Cursor *string
}

type ProjectPage struct {
	Items      []core.Project
	NextCursor *string
}

func (s *Projects) Create(ctx context.Context, principal core.Principal, input CreateProject) (core.Project, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.Project{}, err
	}
	if strings.TrimSpace(input.Name) == "" || !utf8.ValidString(input.Name) || strings.ContainsRune(input.Name, 0) {
		return core.Project{}, invalidInput("Project name must be nonempty UTF-8 text without NUL characters.")
	}
	if err := validateRepoURL(input.RepoURL); err != nil {
		return core.Project{}, err
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return core.Project{}, fmt.Errorf("generate project ID: %w", err)
	}
	project, err := s.store.CreatePrivateProject(ctx, principal, id.String(), input.Name, input.RepoURL)
	if err != nil {
		return core.Project{}, fmt.Errorf("create project: %w", err)
	}
	return project, nil
}

func (s *Projects) Get(ctx context.Context, principal core.Principal, id string) (core.Project, error) {
	project, _, err := s.GetWithAccess(ctx, principal, id)
	return project, err
}

func (s *Projects) GetWithAccess(ctx context.Context, principal core.Principal, id string) (core.Project, core.ProjectAccess, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.Project{}, core.ProjectAccess{}, err
	}
	id, err := CanonicalID(id)
	if err != nil {
		return core.Project{}, core.ProjectAccess{}, err
	}
	var project core.Project
	var access core.ProjectAccess
	var refusal *Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		var err error
		access, err = RequireProjectRead(ctx, snapshot, principal, id)
		if err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		project, err = snapshot.Project(ctx, id)
		if errors.Is(err, core.ErrNotFound) {
			refusal = &Fault{Code: "not_found", Message: "Project was not found.", Cause: err}
			return nil
		}
		return err
	})
	if err != nil {
		return core.Project{}, core.ProjectAccess{}, fmt.Errorf("get project: %w", err)
	}
	if refusal != nil {
		return core.Project{}, core.ProjectAccess{}, refusal
	}
	return project, access, nil
}

func (s *Projects) List(ctx context.Context, principal core.Principal, request PageRequest) (ProjectPage, error) {
	if err := requirePrincipal(principal); err != nil {
		return ProjectPage{}, err
	}
	page, err := projectListPage(request)
	if err != nil {
		return ProjectPage{}, err
	}
	var result store.ProjectPage
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		var err error
		result, err = snapshot.AccessibleProjects(ctx, principal, page)
		return err
	})
	if err != nil {
		return ProjectPage{}, fmt.Errorf("list projects: %w", err)
	}
	response := ProjectPage{Items: result.Items}
	if result.HasMore {
		last := result.Items[len(result.Items)-1]
		cursor, err := encodeProjectCursor(last)
		if err != nil {
			return ProjectPage{}, fmt.Errorf("encode project cursor: %w", err)
		}
		response.NextCursor = &cursor
	}
	return response, nil
}

func CanonicalID(value string) (string, error) {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return "", invalidInput("ID must be a hyphenated UUID.")
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return "", invalidInput("ID must be a hyphenated UUID.")
	}
	return id.String(), nil
}
