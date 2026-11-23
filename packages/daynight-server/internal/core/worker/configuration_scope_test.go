package worker

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func configurationAuthorization(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	canonical, err := scopepolicy.Normalize(scopepolicy.PAT, scopes)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, canonical, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestConfigurationExchangeAuthorizesActualDesiredChanges(t *testing.T) {
	bootstrap := configurationFixture()
	paths := model.WorkerToolPaths{Codex: &model.ToolPathChoice{Kind: "path", Path: "/opt/codex"}}
	for _, tc := range []struct {
		name    string
		current func() *configurationDAO
		input   model.WorkerConfigurationExchange
		changed bool
	}{
		{"initial bootstrap", func() *configurationDAO {
			return &configurationDAO{current: model.WorkerConfigurationResource{ObservationRevision: "0"}}
		}, model.WorkerConfigurationExchange{Bootstrap: &bootstrap}, true},
		{"existing bootstrap no-op", func() *configurationDAO { return configuredDAO("7") }, model.WorkerConfigurationExchange{Bootstrap: &bootstrap}, false},
		{"typed independent tools", func() *configurationDAO { return configuredDAO("7") }, model.WorkerConfigurationExchange{ToolPathsBootstrap: &paths}, true},
		{"raw independent tools", func() *configurationDAO {
			dao := configuredDAO("7")
			raw, err := json.Marshal(bootstrap)
			if err != nil {
				t.Fatal(err)
			}
			dao.current.Desired.Raw = raw
			dao.current.Desired.ArchiveSessions = bootstrap.ArchiveSessions
			return dao
		}, model.WorkerConfigurationExchange{ToolPathsBootstrap: &paths}, true},
		{"already adopted tools", func() *configurationDAO {
			dao := configuredDAO("7")
			dao.current.Desired.Value.ToolPaths = paths
			return dao
		}, model.WorkerConfigurationExchange{ToolPathsBootstrap: &paths}, false},
		{"observation only", func() *configurationDAO { return configuredDAO("7") }, model.WorkerConfigurationExchange{Observation: &model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "7", Items: []model.WorkerConfigurationItem{}}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, configure := range []bool{false, true} {
				scopes := []scopepolicy.ScopeID{"worker:read"}
				if configure {
					scopes = append(scopes, "worker:configure")
				}
				dao := tc.current()
				result, err := ExchangeConfigurationAuthorized(t.Context(), dao, configurationAuthorization(t, scopes...), "worker", tc.input)
				if tc.changed && !configure {
					if !errors.Is(err, scopepolicy.ErrInsufficientScope) || result != nil || dao.desiredWrites != 0 || dao.observationWrites != 0 {
						t.Fatalf("denied change result=%+v err=%v desired=%d observation=%d", result, err, dao.desiredWrites, dao.observationWrites)
					}
				} else if err != nil || result == nil || dao.desiredWrites != boolCount(tc.changed) {
					t.Fatalf("configure=%v result=%+v err=%v writes=%d", configure, result, err, dao.desiredWrites)
				}
			}
		})
	}
}

func boolCount(value bool) int {
	if value {
		return 1
	}
	return 0
}

func TestConfigurationExchangeRequiresReadForExistingDesiredReceipt(t *testing.T) {
	dao := configuredDAO("7")
	result, err := ExchangeConfigurationAuthorized(t.Context(), dao, configurationAuthorization(t, "worker:configure"), "worker", model.WorkerConfigurationExchange{})
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || result != nil || dao.desiredWrites != 0 {
		t.Fatalf("result=%+v err=%v writes=%d", result, err, dao.desiredWrites)
	}
}
