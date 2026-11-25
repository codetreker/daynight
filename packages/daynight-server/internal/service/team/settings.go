package team

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

func (s *Teams) GetSettings(ctx context.Context, p model.Principal, id string) (core.Settings, error) {
	ctx = s.admission.context(ctx)
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return core.Settings{}, err
	}
	var result core.Settings
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		return completion.Capture(func() error {
			var err error
			result, err = core.GetSettings(ctx, scope.TeamDAO(), p, id)
			return err
		}, &refusal)
	})
	if err != nil {
		return core.Settings{}, err
	}
	if refusal != nil {
		return core.Settings{}, refusal
	}
	return result, nil
}

func (s *Teams) UpdateSettings(ctx context.Context, p model.Principal, id string, input core.ChangeSettings) (core.Settings, error) {
	ctx = s.admission.context(ctx)
	id, err := core.ValidateSettingsChange(p, id, input)
	if err != nil {
		return core.Settings{}, err
	}
	var result core.Settings
	err = s.write(ctx, id, func(scope store.TeamWriteScope) error {
		var err error
		result, err = core.UpdateSettings(ctx, scope.TeamDAO(), p, input)
		return err
	})
	if err != nil {
		return core.Settings{}, err
	}
	return result, nil
}
