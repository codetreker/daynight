package bot

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestBindingRulesFreezeConfigurationAndRole(t *testing.T) {
	configuration := model.BotConfiguration{WorkerID: "624f73c9-e6b5-4806-8c8d-4c04690d1d1b", Cwd: "/work", Provider: "codex", Args: []string{}}
	role := model.BotRoleConfiguration{Instructions: "work", Revision: "1"}
	sum := sha256.Sum256([]byte(role.Instructions))
	role.Digest = hex.EncodeToString(sum[:])
	if !ValidBindingInput(configuration, role) {
		t.Fatal("valid frozen binding rejected")
	}
	badConfig := configuration
	badConfig.Args = []string{"bad\x00"}
	if ValidBindingInput(badConfig, role) {
		t.Fatal("invalid argument accepted")
	}
	badConfig.WorkerID = "invalid"
	if ValidBindingInput(badConfig, role) {
		t.Fatal("invalid worker accepted")
	}
	bad := role
	bad.Digest = "wrong"
	if ValidBindingInput(configuration, bad) {
		t.Fatal("invalid role digest accepted")
	}
	bot := model.Bot{Version: 4, ResolvedConfiguration: configuration, RoleConfiguration: &role}
	if !BindingConfigurationMatches(bot, configuration, "codex") || !BindingRoleMatches(bot, role) {
		t.Fatal("identical frozen binding rejected")
	}
	configuration.Args = nil
	if BindingConfigurationMatches(bot, configuration, "codex") || BindingRoleMatches(bot, bad) {
		t.Fatal("changed frozen binding accepted")
	}
	checkFault := func(err error, code string) {
		t.Helper()
		var f *model.Fault
		if !errors.As(err, &f) || f.Code != code {
			t.Fatalf("expected %s, got %v", code, err)
		}
	}
	checkFault(PrepareBinding(bot, 3), "version_conflict")
	checkFault(PrepareBinding(bot, 4), "session_conflict")
	bot.RoleConfiguration = nil
	if err := PrepareBinding(bot, 4); err != nil {
		t.Fatal(err)
	}
	bot.Version = math.MaxInt64
	checkFault(PrepareBinding(bot, bot.Version), "version_exhausted")
}

func TestStartupRulesPreserveReplayAndVersionLimit(t *testing.T) {
	code := "launch_failed"
	failed := model.BotStartupResult{State: "failed", Code: &code}
	if !ValidStartupResult(failed) || !ValidStartupResult(model.BotStartupResult{State: "ready"}) || ValidStartupResult(model.BotStartupResult{State: "failed"}) || ValidStartupResult(model.BotStartupResult{State: "ready", Code: &code}) {
		t.Fatal("startup validation changed")
	}
	bot := model.Bot{Version: math.MaxInt64, StartupResult: failed}
	if write, err := PrepareStartup(bot, failed); write || err != nil {
		t.Fatalf("replay at version limit: %v %v", write, err)
	}
	if write, err := PrepareStartup(bot, model.BotStartupResult{State: "ready"}); write || err == nil {
		t.Fatalf("version exhaustion: %v %v", write, err)
	}
	bot.Version--
	if write, err := PrepareStartup(bot, model.BotStartupResult{State: "ready"}); !write || err != nil {
		t.Fatalf("valid startup transition: %v %v", write, err)
	}
}

func TestRuntimeAuthorizationAndVersion(t *testing.T) {
	bot := model.Bot{OwnerUserID: "owner", WorkerID: "worker", Version: 2}
	check := func(err error, code, message string) {
		t.Helper()
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != code || fault.Message != message {
			t.Fatalf("expected %s %q, got %v", code, message, err)
		}
	}
	if err := AuthorizeRuntime(bot, "owner", "worker"); err != nil {
		t.Fatal(err)
	}
	if err := CheckVersion(bot, 2); err != nil {
		t.Fatal(err)
	}
	check(CheckVersion(bot, 1), "version_conflict", "Bot version has changed.")
	check(AuthorizeRuntime(bot, "other", "worker"), "forbidden", "Session access is not available.")
	check(AuthorizeRuntime(bot, "owner", "other"), "forbidden", "Session access is not available.")
	bot.Deletion = &model.BotDeletion{}
	check(AuthorizeRuntime(bot, "owner", "worker"), "resource_conflict", "Bot is deleted.")
	check(AuthorizeRuntime(bot, "other", "worker"), "forbidden", "Session access is not available.")
}
