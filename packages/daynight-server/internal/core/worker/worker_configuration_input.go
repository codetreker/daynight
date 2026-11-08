package worker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

func configurationObject(raw json.RawMessage, path string, optional bool, keys ...string) (map[string]json.RawMessage, error) {
	fields, err := jsonobject.Decode(raw, path, keys...)
	if err != nil {
		return nil, invalidInput(err.Error())
	}
	if !optional {
		for _, key := range keys {
			if _, ok := fields[key]; !ok {
				return nil, invalidInput(path + "." + key + " is required.")
			}
		}
	}
	return fields, nil
}

func configurationNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func configurationDecode[T any](raw json.RawMessage, target *T) error {
	if configurationNull(raw) || json.Unmarshal(raw, target) != nil {
		return invalidInput("Worker configuration contains an invalid value.")
	}
	return nil
}

func ConfigurationRevision(value string, allowZero bool) (int64, error) {
	revision, err := strconv.ParseInt(value, 10, 64)
	if err != nil || revision < 0 || (!allowZero && revision == 0) || strconv.FormatInt(revision, 10) != value {
		return 0, invalidInput("Configuration revision must be a canonical decimal string.")
	}
	return revision, nil
}

func configurationText(value string) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" && !strings.ContainsFunc(value, unicode.IsControl)
}

func configurationInteger(raw json.RawMessage, minimum, maximum int64) (int64, error) {
	var value int64
	if err := configurationDecode(raw, &value); err != nil || value < minimum || value > maximum {
		return 0, invalidInput("Worker configuration integer is outside its allowed range.")
	}
	return value, nil
}

func configurationNative(raw json.RawMessage, overrides, admit bool) (model.WorkerNativeConfiguration, map[string]json.RawMessage, error) {
	fields, err := configurationObject(raw, "native", overrides, "agent", "model", "args")
	if err != nil {
		return model.WorkerNativeConfiguration{}, nil, err
	}
	var value model.WorkerNativeConfiguration
	if field, exists := fields["agent"]; exists {
		if err := configurationDecode(field, &value.Agent); err != nil || !value.Agent.Valid() {
			return value, nil, invalidInput("Native agent must be codex, claude or copilot.")
		}
	}
	if field, exists := fields["model"]; exists && !configurationNull(field) {
		var model string
		if err := configurationDecode(field, &model); err != nil || !configurationText(model) {
			return value, nil, invalidInput("Native model must be null or nonempty text without control characters.")
		}
		value.Model = &model
	}
	if field, exists := fields["args"]; exists {
		if err := configurationDecode(field, &value.Args); err != nil {
			return value, nil, err
		}
		if admit {
			if err := nativeLimits("native", value); err != nil {
				return value, nil, InputLimit(err)
			}
		}
		for _, arg := range value.Args {
			if !configurationText(arg) {
				return value, nil, invalidInput("Native arguments must be nonempty text without control characters.")
			}
		}
	}
	if admit {
		if err := nativeLimits("native", value); err != nil {
			return value, nil, InputLimit(err)
		}
	}
	// Re-encoding each node gives equal override values one canonical representation.
	normalized := make(map[string]json.RawMessage, len(fields))
	if _, ok := fields["agent"]; ok {
		normalized["agent"], _ = json.Marshal(value.Agent)
	}
	if _, ok := fields["model"]; ok {
		normalized["model"], _ = json.Marshal(value.Model)
	}
	if _, ok := fields["args"]; ok {
		normalized["args"], _ = json.Marshal(value.Args)
	}
	return value, normalized, nil
}

func ParseWorkerConfiguration(raw json.RawMessage) (model.WorkerConfiguration, error) {
	return parseWorkerConfiguration(raw, true)
}

// Stored values need structural normalization for semantic comparisons even
// when they predate current write limits. Only candidates are admitted.
func parseWorkerConfiguration(raw json.RawMessage, admit bool) (model.WorkerConfiguration, error) {
	var value model.WorkerConfiguration
	if !jsonunicode.Valid(raw) {
		return value, invalidInput("Worker configuration must contain valid Unicode.")
	}
	fields, err := configurationObject(raw, "configuration", false, "maxConcurrent", "pollIntervalMs", "recoveryLimit", "native", "projects")
	if err != nil {
		return value, err
	}
	value.MaxConcurrent, err = configurationInteger(fields["maxConcurrent"], 1, workerSafeInteger)
	if err != nil {
		return value, err
	}
	value.PollIntervalMs, err = configurationInteger(fields["pollIntervalMs"], 1, 2147483647)
	if err != nil {
		return value, err
	}
	value.RecoveryLimit, err = configurationInteger(fields["recoveryLimit"], 0, workerSafeInteger)
	if err != nil {
		return value, err
	}
	value.Native, _, err = configurationNative(fields["native"], false, admit)
	if err != nil {
		return value, err
	}
	var projects []json.RawMessage
	if err := configurationDecode(fields["projects"], &projects); err != nil {
		return value, err
	}
	if admit {
		if err := upper("projects", int64(len(projects)), MaxProjects, "items"); err != nil {
			return value, InputLimit(err)
		}
	}
	value.Projects = make([]model.WorkerProjectConfiguration, 0, len(projects))
	seen := make(map[string]bool, len(projects))
	for _, raw := range projects {
		fields, err := configurationObject(raw, "project", false, "projectId", "nativeOverrides")
		if err != nil {
			return value, err
		}
		var project model.WorkerProjectConfiguration
		if err := configurationDecode(fields["projectId"], &project.ProjectID); err != nil {
			return value, err
		}
		project.ProjectID, err = model.CanonicalID(project.ProjectID)
		if err != nil {
			return value, err
		}
		if seen[project.ProjectID] {
			return value, invalidInput("Configuration projects must be unique.")
		}
		seen[project.ProjectID] = true
		_, project.NativeOverrides, err = configurationNative(fields["nativeOverrides"], true, admit)
		if err != nil {
			return value, err
		}
		value.Projects = append(value.Projects, project)
	}
	slices.SortFunc(value.Projects, func(a, b model.WorkerProjectConfiguration) int { return strings.Compare(a.ProjectID, b.ProjectID) })
	if admit {
		if err := AdmitConfiguration(value); err != nil {
			return value, InputLimit(err)
		}
		if _, err := workerprotocol.EncodeConfiguration(io.Discard, value, MaxConfigurationJSONBytes); err != nil {
			return value, InputLimit(err)
		}
	}
	return value, nil
}

func configurationFailure(raw json.RawMessage) (*model.WorkerConfigurationFailure, error) {
	if configurationNull(raw) {
		return nil, nil
	}
	fields, err := configurationObject(raw, "configuration failure", false, "code", "category", "phase", "occurredAt")
	if err != nil {
		return nil, err
	}
	var failure model.WorkerConfigurationFailure
	if err := json.Unmarshal(raw, &failure); err != nil {
		return nil, invalidInput("Configuration failure is invalid.")
	}
	if !slices.Contains([]string{"not_found", "permission_denied", "timeout", "command_failed", "invalid_output", "invalid_configuration", "io_error", "unavailable"}, failure.Code) ||
		!slices.Contains([]string{"validation", "repository", "agent", "runtime", "storage"}, failure.Category) ||
		!slices.Contains([]string{"validate", "prepare", "apply", "stop", "persist"}, failure.Phase) || !workerReportTime(failure.OccurredAt) || configurationNull(fields["occurredAt"]) {
		return nil, invalidInput("Configuration failure must contain allowed diagnostic identifiers and a valid time.")
	}
	failure.OccurredAt = failure.OccurredAt.UTC()
	return &failure, nil
}

func ParseWorkerConfigurationExchange(raw json.RawMessage) (*model.WorkerConfigurationExchange, error) {
	if !jsonunicode.Valid(raw) {
		return nil, invalidInput("Worker configuration exchange must contain valid Unicode.")
	}
	fields, err := configurationObject(raw, "configuration exchange", false, "bootstrap", "observation")
	if err != nil {
		return nil, err
	}
	exchange := &model.WorkerConfigurationExchange{}
	if !configurationNull(fields["bootstrap"]) {
		value, err := ParseWorkerConfiguration(fields["bootstrap"])
		if err != nil {
			return nil, err
		}
		exchange.Bootstrap = &value
	}
	if configurationNull(fields["observation"]) {
		return exchange, nil
	}
	observationFields, err := configurationObject(fields["observation"], "configuration observation", false, "baseRevision", "desiredRevision", "items")
	if err != nil {
		return nil, err
	}
	var header struct {
		BaseRevision    string `json:"baseRevision"`
		DesiredRevision string `json:"desiredRevision"`
	}
	if err := json.Unmarshal(fields["observation"], &header); err != nil {
		return nil, invalidInput("Configuration observation is invalid.")
	}
	observation := model.WorkerConfigurationObservation{BaseRevision: header.BaseRevision, DesiredRevision: header.DesiredRevision}
	if _, err := ConfigurationRevision(observation.BaseRevision, true); err != nil {
		return nil, err
	}
	desiredRevision, err := ConfigurationRevision(observation.DesiredRevision, false)
	if err != nil {
		return nil, err
	}
	var items []json.RawMessage
	if err := configurationDecode(observationFields["items"], &items); err != nil {
		return nil, err
	}
	if err := upper("observation.items", int64(len(items)), MaxObservationItems, "items"); err != nil {
		return nil, InputLimit(err)
	}
	observation.Items = make([]model.WorkerConfigurationItem, 0, len(items))
	seen := make(map[model.WorkerConfigurationItemKey]bool, len(items))
	for _, raw := range items {
		itemFields, err := configurationObject(raw, "configuration item", false, "key", "targetRevision", "appliedValue", "state", "error", "lastFailure", "nextAttemptAt")
		if err != nil {
			return nil, err
		}
		keyFields, err := configurationObject(itemFields["key"], "configuration item key", true, "kind", "projectId")
		if err != nil {
			return nil, err
		}
		var item model.WorkerConfigurationItem
		if err := json.Unmarshal(raw, &item); err != nil {
			return nil, invalidInput("Configuration item is invalid.")
		}
		projectKind := slices.Contains([]string{"projectPreparation", "projectRemoval", "projectNative"}, item.Key.Kind)
		if !projectKind && !slices.Contains([]string{"maxConcurrent", "pollIntervalMs", "recoveryLimit", "native"}, item.Key.Kind) {
			return nil, invalidInput("Configuration item kind is invalid.")
		}
		if projectKind {
			item.Key.ProjectID, err = model.CanonicalID(item.Key.ProjectID)
			if err != nil {
				return nil, err
			}
		} else if _, exists := keyFields["projectId"]; exists {
			return nil, invalidInput("Global configuration items cannot contain projectId.")
		}
		if seen[item.Key] {
			return nil, invalidInput("Configuration observation contains duplicate item keys.")
		}
		seen[item.Key] = true
		targetRevision, err := ConfigurationRevision(item.TargetRevision, false)
		if err != nil {
			return nil, err
		}
		if targetRevision > desiredRevision {
			return nil, invalidInput("Configuration item revision exceeds the observed desired revision.")
		}
		if !slices.Contains([]string{"pending", "applying", "applied", "error"}, item.State) {
			return nil, invalidInput("Configuration item state is invalid.")
		}
		if !configurationNull(item.AppliedValue) {
			switch item.Key.Kind {
			case "native", "projectNative":
				_, _, err = configurationNative(item.AppliedValue, false, true)
			case "projectPreparation", "projectRemoval":
				var ready bool
				err = configurationDecode(item.AppliedValue, &ready)
				if err == nil && !ready {
					err = invalidInput("Successful project application must be true.")
				}
			default:
				minimum, maximum := int64(1), workerSafeInteger
				if item.Key.Kind == "recoveryLimit" {
					minimum = 0
				}
				if item.Key.Kind == "pollIntervalMs" {
					maximum = 2147483647
				}
				_, err = configurationInteger(item.AppliedValue, minimum, maximum)
			}
			if err != nil {
				return nil, err
			}
		} else if item.State == "applied" {
			return nil, invalidInput("Applied configuration items require an applied value.")
		}
		item.Error, err = configurationFailure(itemFields["error"])
		if err != nil {
			return nil, err
		}
		item.LastFailure, err = configurationFailure(itemFields["lastFailure"])
		if err != nil {
			return nil, err
		}
		if (item.State == "error") != (item.Error != nil) || (item.NextAttemptAt != nil && (item.State != "error" || !workerReportTime(*item.NextAttemptAt))) {
			return nil, invalidInput("Configuration item error and retry state are inconsistent.")
		}
		if item.NextAttemptAt != nil {
			utc := item.NextAttemptAt.UTC()
			item.NextAttemptAt = &utc
		}
		var canonical any
		if err := json.Unmarshal(item.AppliedValue, &canonical); err != nil {
			return nil, invalidInput("Applied configuration value is invalid.")
		}
		item.AppliedValue, err = json.Marshal(canonical)
		if err != nil {
			return nil, fmt.Errorf("canonicalize configuration application: %w", err)
		}
		observation.Items = append(observation.Items, item)
	}
	exchange.Observation = &observation
	if err := AdmitObservation(observation); err != nil {
		return nil, InputLimit(err)
	}
	return exchange, nil
}
