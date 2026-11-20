package usage_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

func TestClaudeUnqualifiedRuntimeRecordsUnavailableStateWithoutClaimingUsage(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	f.registration.ProfileID = "claude-message-input-0.3.247-v1"
	testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{identity,provider}','"claude"') WHERE id=$1`, f.session)
	testutil.MustExec(t, f.db.Pool, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{agent}','"claude"')::text WHERE task_id=$1 AND name='worker'`, f.task)
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil || reg.State.Capability == nil || reg.State.Capability.Qualification != "unverified" {
		t.Fatal(reg, err)
	}
	event := stateEvent(reg.State, "1", "unavailable", true)
	event.ReasonCodes = reg.State.ReasonCodes
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(event)); err != nil {
		t.Fatal("unqualified Claude runtime cannot record its own limitation", err)
	}
	counted := measurement(reg.State.ID, "0")
	counted.ProfileID = f.registration.ProfileID
	counted.SourceKey = "claude-message-input-v1:message"
	counted.NativeMetrics = map[string]any{"input_tokens": "2", "cache_read_input_tokens": "0", "cache_creation_input_tokens": "0"}
	counted.Metrics = model.UsageMetrics{Input: core.Ptr("2"), CacheRead: core.Ptr("0"), CacheWrite: core.Ptr("0")}
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(counted))
	requireCode(t, err, "profile_unverified")
	state, err := f.service.State(ctx, f.actor, reg.State.ID)
	if err != nil || state.SealedAt == nil || core.Value(state.CollectionState) != "unavailable" {
		t.Fatal(state, err)
	}
}

func TestUsageConfigurationAdvertisesOnlyExactQualifiedVersions(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	t.Setenv("DAYNIGHT_USAGE_WRITE_ENABLED", "true")
	t.Setenv("DAYNIGHT_USAGE_QUALIFIED_PROFILES", f.registration.ProfileID+"@"+f.registration.ProviderVersion)
	service, err := app.FromEnvironment(f.db)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(service.Capabilities())
	if err != nil {
		t.Fatal(err)
	}
	var registry struct {
		Profiles []struct {
			ID                string                `json:"id"`
			Capability        model.UsageCapability `json:"capability"`
			QualifiedVersions []struct {
				ProviderVersion string                `json:"providerVersion"`
				Capability      model.UsageCapability `json:"capability"`
			} `json:"qualifiedVersions"`
		} `json:"profiles"`
	}
	if err = json.Unmarshal(raw, &registry); err != nil {
		t.Fatal(err)
	}
	var qualified model.UsageCapability
	for _, entry := range registry.Profiles {
		if entry.ID == f.registration.ProfileID {
			if entry.Capability.Qualification != "unverified" || len(entry.QualifiedVersions) != 1 || entry.QualifiedVersions[0].ProviderVersion != f.registration.ProviderVersion || entry.QualifiedVersions[0].Capability.Qualification != "verified" {
				t.Fatal(entry)
			}
			qualified = entry.QualifiedVersions[0].Capability
		}
	}
	reg, err := service.Register(ctx, f.actor, f.registration)
	if err != nil || reg.State.Capability == nil || !reflect.DeepEqual(*reg.State.Capability, qualified) {
		t.Fatal(reg, qualified, err)
	}
	unlisted := f.registration
	unlisted.StateID = uuid.NewString()
	unlisted.RegistrationID = uuid.NewString()
	unlisted.Generation = "2"
	unlisted.ProviderVersion = "unlisted-version"
	testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{executionGeneration}','"2"') WHERE id=$1`, f.session)
	unverified, err := service.Register(ctx, f.actor, unlisted)
	if err != nil || unverified.State.Capability.Qualification != "unverified" {
		t.Fatal(unverified, err)
	}
	_, err = service.Batch(ctx, unverified.State.ID, unverified.Grant.Token, batch(measurement(unverified.State.ID, "7")))
	requireCode(t, err, "profile_unverified")
	if _, err = app.New(f.db, app.Options{QualifiedProfiles: []string{f.registration.ProfileID}}); err == nil {
		t.Fatal("bare profile ID globally qualified all versions")
	}
}
