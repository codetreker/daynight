package team

import (
	"context"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type Settings struct {
	Version            int64
	AllowNestedSubtask bool
}

type ChangeSettings struct {
	Version            int64
	ExpectedUserID     string
	AllowNestedSubtask bool
}

func settingsFromTeam(t model.Team) Settings {
	return Settings{Version: t.Version, AllowNestedSubtask: t.AllowNestedSubtask}
}

func GetSettings(ctx context.Context, dao store.TeamReader, p model.Principal, id string) (Settings, error) {
	t, err := Get(ctx, dao, p, id)
	if err != nil {
		return Settings{}, err
	}
	return settingsFromTeam(t), nil
}

func ValidateSettingsChange(p model.Principal, id string, input ChangeSettings) (string, error) {
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
	return id, nil
}

func UpdateSettings(ctx context.Context, dao store.TeamWriteDAO, p model.Principal, input ChangeSettings) (Settings, error) {
	t, err := writableTeam(ctx, dao, p)
	if err != nil {
		return Settings{}, err
	}
	if err := checkScope(ctx, p, scopepolicy.TeamWrite, scopepolicy.TeamRead); err != nil {
		return Settings{}, err
	}
	if t.Membership.Role != model.ProjectAdmin {
		return Settings{}, &model.Fault{Code: "forbidden", Message: "Team administrator access is required."}
	}
	if t.Version != input.Version {
		return Settings{}, &model.Fault{Code: "version_conflict", Message: "Team version does not match."}
	}
	if t.AllowNestedSubtask == input.AllowNestedSubtask {
		return settingsFromTeam(t), nil
	}
	if t.Version == math.MaxInt64 {
		return Settings{}, &model.Fault{Code: "version_exhausted", Message: "Team version is exhausted."}
	}
	t, err = dao.SetNestedSubtask(ctx, p.UserID, input.AllowNestedSubtask)
	if err != nil {
		return Settings{}, err
	}
	return settingsFromTeam(t), nil
}
