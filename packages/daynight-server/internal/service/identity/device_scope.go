package identity

import (
	"context"
	"errors"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// DeviceScopeCatalog exposes the same immutable snapshot used by decisions.
func (s *Identity) DeviceScopeCatalog() (scopepolicy.CatalogSnapshot, bool) {
	if s.deviceCatalog == nil {
		return scopepolicy.CatalogSnapshot{}, false
	}
	return s.deviceCatalog.Clone(), true
}

func (s *Identity) InspectDeviceV2(ctx context.Context, p model.Principal, code string) (core.DeviceInspectionV2, error) {
	if s.deviceCatalog == nil {
		return core.DeviceInspectionV2{}, errors.New("device scope catalog is unavailable")
	}
	view, err := s.InspectDevice(ctx, p, code)
	if err != nil {
		return core.DeviceInspectionV2{}, err
	}
	result := core.DeviceInspectionV2{DeviceInspection: view}
	if view.Status == "pending" {
		revision := s.deviceCatalog.CatalogRevision
		result.CatalogRevision = &revision
	}
	return result, nil
}

func (s *Identity) DecideDeviceV2(ctx context.Context, p model.Principal, code, decision, userID, revision string, scopes []scopepolicy.ScopeID) error {
	if s.deviceCatalog == nil {
		return errors.New("device scope catalog is unavailable")
	}
	if err := s.browserRate(ctx, p); err != nil {
		return err
	}
	if _, _, err := s.ops.validateDeviceDecision(p, code, decision, userID); err != nil {
		return err
	}
	if decision == "approve" {
		if revision != s.deviceCatalog.CatalogRevision {
			return &model.Fault{Code: "version_conflict", Message: "Scope catalog changed. Review the current options."}
		}
		var err error
		scopes, err = s.deviceCatalog.ValidateSelection(scopepolicy.PAT, scopes)
		if err != nil {
			return &model.Fault{Code: "invalid_input", Message: "Invalid device scopes."}
		}
	} else if revision != "" || scopes != nil {
		return &model.Fault{Code: "invalid_input", Message: "A denied device request cannot include scopes."}
	}
	return s.run(ctx, func(scope store.IdentityScope) error {
		dao := scope.IdentityDAO()
		scoped, ok := dao.(store.DeviceScopeDAO)
		if !ok {
			return errors.New("identity scope lacks scoped device capability")
		}
		return core.NewIdentity(s.callbackURL).DecideDeviceScoped(ctx, dao, scoped, p, code, decision, userID, scopes, s.now().UTC())
	})
}
