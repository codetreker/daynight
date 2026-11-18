package usage_test

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

func TestUsageConfigurationAdvertisesOnlyExactQualifiedVersions(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	t.Setenv("DAYNIGHT_USAGE_WRITE_ENABLED", "true")
	t.Setenv("DAYNIGHT_USAGE_QUALIFIED_PROFILES", f.registration.ProfileID+"@"+f.registration.ProviderVersion)
	t.Setenv("DAYNIGHT_USAGE_CURSOR_KEY", base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("k", 32))))
	service, err := app.FromEnvironment(f.db, "")
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
	if _, err = app.New(f.db, app.Options{CursorKey: []byte(strings.Repeat("k", 32)), QualifiedProfiles: []string{f.registration.ProfileID}}); err == nil {
		t.Fatal("bare profile ID globally qualified all versions")
	}
}
