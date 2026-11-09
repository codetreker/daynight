package bot

import (
	"context"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestFrozenConfigurationPreservesUnicodePathsAndExplicitOverrides(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*CreateBot)
	}{
		{"directory control", func(v *CreateBot) { v.ResolvedConfiguration.Cwd = "/foo\nbar" }},
		{"invalid model Unicode", func(v *CreateBot) { v.ResolvedConfiguration.Model = ptr(string([]byte{0xff})) }},
		{"invalid model NUL", func(v *CreateBot) { v.ResolvedConfiguration.Model = ptr("model\x00") }},
		{"invalid arg", func(v *CreateBot) { v.ResolvedConfiguration.Args = []string{"--model", "value\x00"} }},
		{"changed explicit Worker", func(v *CreateBot) { v.Overrides.WorkerID = ptr(botID) }},
		{"changed explicit directory", func(v *CreateBot) { v.Overrides.Cwd = ptr("/explicit") }},
		{"changed explicit provider", func(v *CreateBot) { v.Overrides.Provider = ptr("claude") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := input()
			tc.change(&v)
			_, err := normalizeBotConfiguration(v)
			assertFault(t, err, "invalid_input")
		})
	}
	for _, cwd := range []string{"/normal", `C:\ordinary\directory`, `D:/ordinary`, `\\machine\share\directory`} {
		v := input()
		v.Name = strings.Repeat("界", 40)
		v.ResolvedConfiguration.Cwd = cwd
		v.ResolvedConfiguration.Args = nil
		v.Overrides = model.BotOverrides{WorkerID: ptr(strings.ToUpper(workerID)), Cwd: &cwd, Provider: ptr("codex")}
		normalized, _, err := NormalizeBotRequest(v)
		if err != nil {
			t.Fatal(err)
		}
		got, err := normalizeBotConfiguration(normalized)
		if err != nil || got.Args == nil || *normalized.Overrides.WorkerID != workerID {
			t.Fatalf("valid configuration lost: %+v %+v %v", normalized, got, err)
		}
	}
}
func TestCreationReplayIgnoresUnavailableDefaultsAndDiscoveryError(t *testing.T) {
	v, fp, err := NormalizeBotRequest(input())
	if err != nil {
		t.Fatal(err)
	}
	current := model.Bot{ID: v.ID, Name: v.Name, OwnerUserID: "owner", RequestFingerprint: fp, Version: 2, ResolvedConfiguration: v.ResolvedConfiguration, Deletion: &model.BotDeletion{DeletionID: "deleted", WorkerCleanup: model.BotCleanupResult{State: "pending"}}}
	v.ResolutionError = &model.Fault{Code: "resource_conflict", Message: "discovery failed"}
	dao := &botDAO{current: &current, fail: map[string]error{"defaults": model.ErrNotFound, "worker": model.ErrNotFound}}
	got, err := Create(context.Background(), dao, model.Principal{UserID: "owner"}, v, fp, true)
	if err != nil || got.ID != current.ID || got.Version != current.Version || got.Deletion != current.Deletion || got.ResolvedConfiguration.Cwd != current.ResolvedConfiguration.Cwd {
		t.Fatalf("replay lost frozen deleted identity: %+v %v", got, err)
	}
}
