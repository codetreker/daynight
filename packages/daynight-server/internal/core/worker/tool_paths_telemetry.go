package worker

import (
	"context"
	"encoding/json"
	"io"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

const MaxToolPathTelemetryBytes = 256 << 10

var windowsToolPath = regexp.MustCompile(`^([A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+([\\/]|$))`)

var toolSelectionKey = regexp.MustCompile(`^[0-9a-f]{64}$`)
var toolTimestamp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$`)
var toolErrorCodes = []string{"not_found", "permission_denied", "not_executable", "invalid_path", "unsupported_launcher", "unrecognized_output", "incompatible_runtime", "probe_timeout", "cleanup_unknown", "tool_identity_changed", "legacy_tool_identity_missing", "io_error", "unavailable"}

func validToolTime(value time.Time) bool {
	_, offset := value.Zone()
	return !value.IsZero() && value.Year() > 0 && value.Year() <= 9999 && offset == 0
}

func validPlatformToolPath(value string, platform model.TaskPlatform) bool {
	if !validToolPath(value) {
		return false
	}
	if platform == model.PlatformWindows {
		return windowsToolPath.MatchString(value)
	}
	return platform == "" || strings.HasPrefix(value, "/")
}

func validToolChoice(choice model.ToolPathChoice, platform model.TaskPlatform) bool {
	return choice.Kind == "auto" && choice.Path == "" || choice.Kind == "path" && validPlatformToolPath(choice.Path, platform)
}

func validateToolActual(actual *model.ToolPathActual, observed time.Time, platform model.TaskPlatform) error {
	if actual == nil {
		return nil
	}
	if !validToolChoice(actual.Selection, platform) || !toolSelectionKey.MatchString(actual.SelectionKey) ||
		!validPlatformToolPath(actual.EntryPath, platform) || !validPlatformToolPath(actual.ExecutablePath, platform) ||
		(actual.InterpreterPath != nil && !validPlatformToolPath(*actual.InterpreterPath, platform)) ||
		!slices.Contains([]string{"explicit", "path", "bundled"}, actual.Source) || (actual.Source == "explicit") != (actual.Selection.Kind == "path") ||
		!configurationText(actual.Version) || len(actual.Version) > MaxVersionBytes || !validToolTime(actual.CheckedAt) || actual.CheckedAt.After(observed) {
		return invalidInput("Tool path actual selection is invalid.")
	}
	return nil
}

// ValidateToolPaths checks observations without accessing the reported machine.
func ValidateToolPaths(value *model.ToolPathTelemetry, platform model.TaskPlatform) error {
	if value == nil {
		return nil
	}
	if value.SchemaVersion != 1 || !validToolTime(value.ObservedAt) || value.Entries == nil || len(value.Entries) > 5 {
		return invalidInput("Tool path telemetry schema, time or entries are invalid.")
	}
	seen := map[[2]string]bool{}
	for _, entry := range value.Entries {
		key := [2]string{entry.Tool, entry.Context}
		if !slices.Contains([]string{"codex", "copilot", "herdr"}, entry.Tool) || !slices.Contains([]string{"web", "herdr"}, entry.Context) || entry.Tool == "herdr" && entry.Context != "herdr" || seen[key] {
			return invalidInput("Tool path contexts must be unique supported tool/context pairs.")
		}
		seen[key] = true
		if !validToolChoice(entry.Target, "") {
			return invalidInput("Tool path target is invalid.")
		}
		switch entry.ConfigurationSource {
		case "local":
			if entry.TargetRevision != nil {
				return invalidInput("Local tool paths cannot have a target revision.")
			}
		case "cloud":
			if entry.TargetRevision == nil {
				return invalidInput("Cloud tool paths require a target revision.")
			}
			if _, err := ConfigurationRevision(*entry.TargetRevision, false); err != nil {
				return err
			}
		default:
			return invalidInput("Tool path configuration source is invalid.")
		}
		if !slices.Contains([]string{"not_checked", "checking", "pending", "applied", "error"}, entry.State) || (entry.State == "error") != (entry.Error != nil) {
			return invalidInput("Tool path application state and error are inconsistent.")
		}
		if entry.Reason != nil && (entry.State != "pending" || !slices.Contains([]string{"active_instance", "cleanup_unconfirmed", "configuration_unavailable", "report_budget_exceeded"}, *entry.Reason)) {
			return invalidInput("Tool path pending reason is invalid.")
		}
		if entry.State == "not_checked" && (entry.Actual != nil || entry.Candidate != nil) || entry.State == "applied" && (entry.Actual == nil || entry.Actual.Selection != entry.Target) {
			return invalidInput("Tool path application evidence is inconsistent.")
		}
		for _, actual := range []*model.ToolPathActual{entry.Actual, entry.Candidate} {
			if err := validateToolActual(actual, value.ObservedAt, platform); err != nil {
				return err
			}
		}
		if entry.Error != nil && (!slices.Contains(toolErrorCodes, entry.Error.Code) || !validToolTime(entry.Error.OccurredAt) || entry.Error.OccurredAt.After(value.ObservedAt)) {
			return invalidInput("Tool path failure is invalid.")
		}
		if entry.ActiveSelections == nil || len(entry.ActiveSelections) > 8 || entry.ActiveSelectionCount != nil && (!workerBytes(*entry.ActiveSelectionCount) || *entry.ActiveSelectionCount < int64(len(entry.ActiveSelections))) || entry.ActiveSelectionsComplete && (entry.ActiveSelectionCount == nil || *entry.ActiveSelectionCount != int64(len(entry.ActiveSelections)) || entry.ActiveObservationError != nil) {
			return invalidInput("Tool path active selection completeness is inconsistent.")
		}
		if entry.ActiveObservationError != nil && !slices.Contains([]string{"legacy_tool_identity_missing", "cleanup_unknown", "inventory_unavailable"}, *entry.ActiveObservationError) {
			return invalidInput("Tool path active observation error is invalid.")
		}
		previous := ""
		for _, active := range entry.ActiveSelections {
			if err := validateToolActual(&active.Actual, value.ObservedAt, platform); err != nil {
				return err
			}
			if active.Actual.SelectionKey <= previous || !workerBytes(active.UnconfirmedCount) || active.ExecutionCount != nil && !workerBytes(*active.ExecutionCount) || active.InstanceCount != nil && !workerBytes(*active.InstanceCount) {
				return invalidInput("Tool path active selections require ordered unique keys and safe nonnegative counts.")
			}
			previous = active.Actual.SelectionKey
		}
	}
	_, err := measure.JSON(io.Discard, "toolPaths", MaxToolPathTelemetryBytes, value, false)
	if err != nil {
		return InputLimit(err)
	}
	return nil
}

// ValidateToolPathTargets compares cloud observations with the locked target.
// Older revisions remain historical facts; a current revision must name its choice.
func ValidateToolPathTargets(ctx context.Context, dao store.WorkerWriteDAO, principal model.Principal, workerID string, value *model.ToolPathTelemetry) error {
	if value == nil {
		return nil
	}
	cloud := false
	for _, entry := range value.Entries {
		cloud = cloud || entry.ConfigurationSource == "cloud"
	}
	if !cloud {
		return nil
	}
	current, err := dao.WorkerConfiguration(ctx, principal.UserID, workerID)
	if err != nil {
		return err
	}
	if current.Desired == nil {
		return invalidInput("Cloud tool observations require a desired configuration.")
	}
	revision, err := ConfigurationRevision(current.Desired.Revision, false)
	if err != nil {
		return err
	}
	choices := map[string]*model.ToolPathChoice{"codex": current.Desired.Value.ToolPaths.Codex, "copilot": current.Desired.Value.ToolPaths.Copilot, "herdr": current.Desired.Value.ToolPaths.Herdr}
	for _, entry := range value.Entries {
		if entry.ConfigurationSource != "cloud" {
			continue
		}
		if entry.TargetRevision == nil {
			return invalidInput("Cloud tool paths require a target revision.")
		}
		observed, err := ConfigurationRevision(*entry.TargetRevision, false)
		if err != nil {
			return err
		}
		choice := choices[entry.Tool]
		if observed > revision || observed == revision && (choice == nil || *choice != entry.Target) {
			return invalidInput("Tool path observation does not match the desired revision.")
		}
	}
	return nil
}

// ParseToolPathTelemetry rejects unknown fields at every nesting level.
func ParseToolPathTelemetry(raw json.RawMessage) (*model.ToolPathTelemetry, error) {
	if !jsonunicode.Valid(raw) {
		return nil, invalidInput("Tool path telemetry must contain valid Unicode.")
	}
	fields, err := configurationObject(raw, "toolPaths", false, "schemaVersion", "observedAt", "entries")
	if err != nil {
		return nil, err
	}
	if err := toolTimeShape(fields["observedAt"]); err != nil {
		return nil, err
	}
	var entries []json.RawMessage
	if err := configurationDecode(fields["entries"], &entries); err != nil {
		return nil, err
	}
	for _, rawEntry := range entries {
		entry, err := configurationObject(rawEntry, "tool path observation", false, "tool", "context", "configurationSource", "targetRevision", "target", "state", "reason", "actual", "candidate", "activeSelectionCount", "activeSelectionsComplete", "activeObservationError", "activeSelections", "error")
		if err != nil {
			return nil, err
		}
		if _, err := parseToolPathChoice(entry["target"]); err != nil {
			return nil, err
		}
		for _, key := range []string{"actual", "candidate"} {
			if !configurationNull(entry[key]) {
				if err := toolActualShape(entry[key]); err != nil {
					return nil, err
				}
			}
		}
		if !configurationNull(entry["error"]) {
			failure, err := configurationObject(entry["error"], "tool path error", false, "code", "occurredAt")
			if err != nil {
				return nil, err
			}
			if err := toolTimeShape(failure["occurredAt"]); err != nil {
				return nil, err
			}
		}
		var active []json.RawMessage
		if err := configurationDecode(entry["activeSelections"], &active); err != nil {
			return nil, err
		}
		for _, rawActive := range active {
			group, err := configurationObject(rawActive, "active tool selection", false, "actual", "executionCount", "instanceCount", "unconfirmedCount")
			if err != nil {
				return nil, err
			}
			if err := toolActualShape(group["actual"]); err != nil {
				return nil, err
			}
			if configurationNull(group["unconfirmedCount"]) {
				return nil, invalidInput("Tool path unconfirmed count is required.")
			}
		}
		if configurationNull(entry["activeSelectionsComplete"]) {
			return nil, invalidInput("Tool path completeness must be a boolean.")
		}
	}
	var value model.ToolPathTelemetry
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, invalidInput("Tool path telemetry contains an invalid value.")
	}
	if err := ValidateToolPaths(&value, ""); err != nil {
		return nil, err
	}
	return &value, nil
}

func toolActualShape(raw json.RawMessage) error {
	fields, err := configurationObject(raw, "actual tool selection", false, "selection", "selectionKey", "entryPath", "executablePath", "interpreterPath", "source", "version", "checkedAt")
	if err != nil {
		return err
	}
	if err := toolTimeShape(fields["checkedAt"]); err != nil {
		return err
	}
	_, err = parseToolPathChoice(fields["selection"])
	return err
}

func toolTimeShape(raw json.RawMessage) error {
	var value string
	if err := configurationDecode(raw, &value); err != nil || !toolTimestamp.MatchString(value) {
		return invalidInput("Tool observation times must be UTC RFC3339 timestamps.")
	}
	return nil
}
