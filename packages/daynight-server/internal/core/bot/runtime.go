package bot

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func runtimeID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id.String() == value
}

func runtimeText(value string) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" && !strings.ContainsRune(value, 0)
}

// ValidBindingInput validates the frozen configuration and role before registration.
func ValidBindingInput(configuration model.BotConfiguration, role model.BotRoleConfiguration) bool {
	if !runtimeID(configuration.WorkerID) || !runtimeText(configuration.Cwd) || !model.WorkerAgent(configuration.Provider).Valid() || (configuration.Model != nil && !runtimeText(*configuration.Model)) {
		return false
	}
	for _, arg := range configuration.Args {
		if !utf8.ValidString(arg) || strings.ContainsRune(arg, 0) {
			return false
		}
	}
	sum := sha256.Sum256([]byte(role.Instructions))
	return runtimeText(role.Instructions) && len(role.Instructions) <= 65536 && runtimeText(role.Revision) && role.Digest == hex.EncodeToString(sum[:])
}

func runtimeConflict() error {
	return &model.Fault{Code: "session_conflict", Message: "Session identity or state no longer matches."}
}

// AuthorizeRuntime checks the locked Bot's owner, Worker binding and deletion state.
func AuthorizeRuntime(bot model.Bot, userID, workerID string) error {
	if bot.OwnerUserID != userID || bot.WorkerID != workerID {
		return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
	}
	if bot.Deletion != nil {
		return &model.Fault{Code: "resource_conflict", Message: "Bot is deleted."}
	}
	return nil
}

// CheckVersion validates the version supplied for a Bot runtime operation.
func CheckVersion(bot model.Bot, version int64) error {
	if version != bot.Version {
		return &model.Fault{Code: "version_conflict", Message: "Bot version has changed."}
	}
	return nil
}

func sameJSON(a, b any) bool {
	x, err := json.Marshal(a)
	if err != nil {
		return false
	}
	y, err := json.Marshal(b)
	return err == nil && bytes.Equal(x, y)
}

// BindingConfigurationMatches compares the submitted configuration with the frozen definition.
func BindingConfigurationMatches(bot model.Bot, configuration model.BotConfiguration, provider string) bool {
	return sameJSON(bot.ResolvedConfiguration, configuration) && provider == bot.ResolvedConfiguration.Provider
}

func BindingRoleMatches(bot model.Bot, role model.BotRoleConfiguration) bool {
	return bot.RoleConfiguration != nil && *bot.RoleConfiguration == role
}

// PrepareBinding validates a first binding after the caller has locked the Bot.
func PrepareBinding(bot model.Bot, version int64) error {
	if err := CheckVersion(bot, version); err != nil {
		return err
	}
	if bot.Version == math.MaxInt64 {
		return &model.Fault{Code: "version_exhausted", Message: "Bot version cannot advance."}
	}
	if bot.RoleConfiguration != nil {
		return runtimeConflict()
	}
	return nil
}

func ValidStartupResult(result model.BotStartupResult) bool {
	return result.State == "ready" && result.Code == nil || result.State == "failed" && result.Code != nil && runtimeText(*result.Code)
}

// PrepareStartup detects an idempotent result and ensures the version can advance.
// Session identity and live readiness proof must be checked before invoking it.
func PrepareStartup(bot model.Bot, result model.BotStartupResult) (bool, error) {
	if sameJSON(result, bot.StartupResult) {
		return false, nil
	}
	if bot.Version == math.MaxInt64 {
		return false, &model.Fault{Code: "version_exhausted", Message: "Bot version cannot advance."}
	}
	return true, nil
}
