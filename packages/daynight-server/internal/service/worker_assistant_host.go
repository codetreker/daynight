package service

import (
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

var workerAssistantReasons = []string{"unsupported_arguments", "invalid_cwd", "not_found", "permission_denied", "timeout", "command_failed", "invalid_output", "unavailable"}

func validateWorkerAssistantHost(host *model.WorkerAssistantHost, platform model.TaskPlatform) error {
	if host == nil {
		return nil
	}
	if host.ProtocolVersion != 1 || !workerReportTime(host.ObservedAt) || !host.DefaultProvider.Valid() || !workerAssistantAbsolutePath(host.DefaultCwd, platform) || len(host.Providers) != 3 {
		return invalidInput("Assistant host requires protocol v1, an observation time, an absolute directory, a default provider and all three providers.")
	}
	seen := make(map[model.WorkerAgent]bool, 3)
	for _, provider := range host.Providers {
		if !provider.Provider.Valid() || seen[provider.Provider] || provider.Available != (provider.Reason == nil) || (provider.Reason != nil && !slices.Contains(workerAssistantReasons, *provider.Reason)) {
			return invalidInput("Assistant provider identities and availability reasons must be valid and unique.")
		}
		seen[provider.Provider] = true
		if provider.Model != nil && !workerAssistantText(*provider.Model, 256) || provider.Args == nil || len(provider.Args) > 128 {
			return invalidInput("Assistant provider model and arguments must be bounded text and an explicit array.")
		}
		for _, arg := range provider.Args {
			if !workerAssistantText(arg, 4096) {
				return invalidInput("Assistant provider arguments must be bounded text without control characters.")
			}
		}
		if provider.Reason != nil && *provider.Reason == "unsupported_arguments" && (provider.Model != nil || len(provider.Args) != 0) {
			return invalidInput("Unsupported assistant configuration must not contain model or argument values.")
		}
	}
	return nil
}

func workerAssistantText(value string, limit int) bool {
	return workerText(value) && len(value) <= limit && !strings.ContainsFunc(value, unicode.IsControl)
}

func workerAssistantAbsolutePath(value string, platform model.TaskPlatform) bool {
	if !workerAssistantText(value, 4096) {
		return false
	}
	if platform != model.PlatformWindows {
		return strings.HasPrefix(value, "/")
	}
	path := strings.ReplaceAll(value, "\\", "/")
	if len(path) >= 3 && ((path[0] >= 'a' && path[0] <= 'z') || (path[0] >= 'A' && path[0] <= 'Z')) && path[1:3] == ":/" {
		return true
	}
	if !strings.HasPrefix(path, "//") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(path, "//"), "/")
	return len(parts) >= 2 && parts[0] != "" && parts[0] != "." && parts[0] != "?" && parts[1] != ""
}

// WorkerAssistantHostState combines server liveness with the age of the actual
// preflight. An available host still requires checking the selected provider.
func WorkerAssistantHostState(worker model.WorkerSnapshot, observedAt time.Time) string {
	host := worker.Telemetry.AssistantHost
	if host == nil || host.ProtocolVersion != 1 {
		return "unsupported"
	}
	if !workerAssistantFresh(worker.LastReportedAt, observedAt) {
		return "offline"
	}
	if !workerAssistantFresh(host.ObservedAt, observedAt) {
		return "stale"
	}
	for _, provider := range host.Providers {
		if provider.Available {
			return "available"
		}
	}
	return "unavailable"
}

func workerAssistantFresh(value, now time.Time) bool {
	return !value.IsZero() && !now.IsZero() && !value.After(now) && now.Sub(value) < 120*time.Second
}
