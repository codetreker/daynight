package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

// Historical migration fixtures deliberately construct projects in their source
// schema. Current-schema fixtures use the same complete writer as the service.
func (s *Store) CreateProject(ctx context.Context, id, name, repoURL string) (model.Project, error) {
	var current bool
	if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=32)`).Scan(&current); err != nil {
		return model.Project{}, err
	}
	if current {
		now := time.Now().UTC()
		hash := sha256.Sum256([]byte(uuid.NewString()))
		user, err := seedIdentitySession(s, ctx, model.User{ID: uuid.NewString(), UniAuthID: "fixture:" + uuid.NewString()},
			model.Session{ID: uuid.NewString(), TokenHash: hash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
		if err != nil {
			return model.Project{}, err
		}
		return s.CreatePrivateProject(ctx, model.Principal{UserID: user.ID}, id, name, repoURL)
	}
	var project model.Project
	err := s.Pool.QueryRow(ctx, `INSERT INTO projects(id,name,repo_url) VALUES ($1,$2,$3)
		RETURNING id::text,name,repo_url,created_at,updated_at,settings_version,execution_warning_minutes`, id, name, repoURL).
		Scan(&project.ID, &project.Name, &project.RepoURL, &project.CreatedAt, &project.UpdatedAt, &project.Settings.Version, &project.Settings.ExecutionWarningMinutes)
	if err != nil {
		return model.Project{}, queryError("create historical fixture project", err)
	}
	if err := seedHistoricalProjectAdmin(ctx, s, id); err != nil {
		return model.Project{}, err
	}
	return project, nil
}

func seedHistoricalProjectAdmin(ctx context.Context, s *Store, projectID string) error {
	userID := uuid.NewString()
	if _, err := s.Pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, userID, "historical:"+userID); err != nil {
		return err
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')`, projectID, userID)
	return err
}

func writeProjectForTest(s *Store, ctx context.Context, id string, operation func(ProjectWriteScope) error) error {
	_, err := s.WriteProject(ctx, id, operation)
	return err
}

func (s *Store) CreatePrivateProject(ctx context.Context, principal model.Principal, id, name, repoURL string) (model.Project, error) {
	project, _, err := s.CreateProjectInTeam(ctx, principal, id, name, repoURL, nil)
	return project, err
}

func (s *Store) CreateProjectInTeam(ctx context.Context, principal model.Principal, id, name, repoURL string, teamID *string) (model.Project, model.ProjectAccess, error) {
	var project model.Project
	var access model.ProjectAccess
	_, err := s.WriteProjectCreation(ctx, principal.UserID, func(dao ProjectCreationDAO) error {
		var err error
		team, err := creationTeamForTest(ctx, dao, principal.UserID, teamID)
		if err != nil {
			return err
		}
		project, access, err = dao.InsertProject(ctx, id, name, repoURL, team)
		return err
	})
	return project, access, err
}

func creationTeamForTest(ctx context.Context, dao ProjectCreationDAO, userID string, target *string) (string, error) {
	if target != nil {
		team, err := dao.LockCreationTeam(ctx, *target)
		if err != nil {
			return "", err
		}
		if team.PersonalUserID == nil {
			member, err := dao.CreationTeamMember(ctx, team.ID)
			if err != nil {
				return "", err
			}
			if !member {
				return "", model.ErrNotFound
			}
			return team.ID, nil
		}
		if *team.PersonalUserID != userID {
			return "", model.ErrNotFound
		}
	}
	facts, err := dao.CreationPersonalTeam(ctx, target == nil)
	if err != nil {
		return "", err
	}
	if facts.ID == "" {
		return "", errors.New("user Personal Team is missing")
	}
	if facts.MemberCount != 1 || facts.OwnerAdminCount != 1 {
		return "", errors.New("Personal Team owner membership is invalid")
	}
	return facts.ID, nil
}
