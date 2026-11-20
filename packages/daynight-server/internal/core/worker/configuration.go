package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"reflect"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tag"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

func NormalizeConfiguration(value model.WorkerConfiguration) (model.WorkerConfiguration, error) {
	if err := AdmitConfiguration(value); err != nil {
		return model.WorkerConfiguration{}, InputLimit(err)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return model.WorkerConfiguration{}, invalidInput("Worker configuration is invalid.")
	}
	normalized, err := ParseWorkerConfiguration(raw)
	normalized.PreserveToolPaths = value.PreserveToolPaths
	normalized.ArchiveSessions = value.ArchiveSessions
	normalized.PreserveArchiveSessions = value.PreserveArchiveSessions
	normalized.PreserveSudoCleanup = value.PreserveSudoCleanup
	normalized.PreserveWindowsProcessCleanup = value.PreserveWindowsProcessCleanup
	normalized.PreserveTaskTagFilter = value.PreserveTaskTagFilter
	return normalized, err
}

func normalizeStoredConfiguration(value model.WorkerConfiguration) (model.WorkerConfiguration, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return model.WorkerConfiguration{}, invalidInput("Stored Worker configuration is invalid.")
	}
	normalized, err := parseWorkerConfiguration(raw, false)
	normalized.ArchiveSessions = value.ArchiveSessions
	return normalized, err
}

// storedConfigurationFields keeps the persisted JSON independent of admission.
func storedConfigurationFields(desired *model.WorkerDesiredConfiguration) (map[string]json.RawMessage, error) {
	raw := desired.Raw
	if raw == nil {
		var err error
		raw, err = json.Marshal(desired.Value)
		if err != nil {
			return nil, invalidInput("Stored Worker configuration is invalid.")
		}
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, invalidInput("Stored Worker configuration is invalid.")
	}
	return fields, nil
}

func storedArchive(desired *model.WorkerDesiredConfiguration) *bool {
	if desired.Raw != nil || desired.ArchiveSessions != nil {
		return desired.ArchiveSessions
	}
	return desired.Value.ArchiveSessions
}

// Each stored project is checked independently of unrelated unknown fields.
func retainedProjects(desired *model.WorkerDesiredConfiguration) map[string]model.WorkerProjectConfiguration {
	retained := map[string]model.WorkerProjectConfiguration{}
	if desired == nil {
		return retained
	}
	fields, err := storedConfigurationFields(desired)
	if err != nil {
		return retained
	}
	var projects []json.RawMessage
	if json.Unmarshal(fields["projects"], &projects) != nil {
		return retained
	}
	duplicates := map[string]bool{}
	seen := map[string]bool{}
	for _, raw := range projects {
		var identity struct {
			ProjectID string `json:"projectId"`
		}
		if err := json.Unmarshal(raw, &identity); err != nil {
			continue
		}
		id, err := model.CanonicalID(identity.ProjectID)
		if err != nil {
			continue
		}
		if seen[id] {
			delete(retained, id)
			duplicates[id] = true
			continue
		}
		seen[id] = true
		f, err := configurationObject(raw, "project", false, "projectId", "nativeOverrides")
		if err != nil {
			continue
		}
		_, overrides, err := configurationNative(f["nativeOverrides"], true, false)
		if err != nil {
			continue
		}
		if !duplicates[id] {
			retained[id] = model.WorkerProjectConfiguration{ProjectID: id, NativeOverrides: overrides}
		}
	}
	return retained
}

func storedPaths(fields map[string]json.RawMessage, value *model.WorkerConfiguration) error {
	paths := fields["toolPaths"]
	if value.PreserveToolPaths {
		if len(paths) != 0 && !configurationNull(paths) {
			parsed, err := parseToolPaths(paths, true)
			if err != nil {
				return err
			}
			value.ToolPaths = parsed
		} else {
			value.ToolPaths = model.WorkerToolPaths{}
		}
		value.PreserveToolPaths = false
	} else if len(paths) != 0 && !configurationNull(paths) {
		var slots map[string]json.RawMessage
		if json.Unmarshal(paths, &slots) != nil || slots == nil {
			if value.ToolPaths.Codex == nil || value.ToolPaths.Copilot == nil {
				return invalidInput("Stored tool paths are invalid.")
			}
			return nil
		}
		for tool, choice := range map[string]*model.ToolPathChoice{"codex": value.ToolPaths.Codex, "copilot": value.ToolPaths.Copilot} {
			if raw := slots[tool]; choice == nil && len(raw) != 0 && !configurationNull(raw) {
				return invalidInput("Adopted tool paths cannot be cleared.")
			}
		}
	}
	return nil
}

func sameStoredConfiguration(desired *model.WorkerDesiredConfiguration, fields map[string]json.RawMessage, value model.WorkerConfiguration) bool {
	// The archive capability is stored exclusively in its own column.
	// A JSONB member with that name is still a stored fact to replace.
	if _, exists := fields["archiveSessions"]; exists {
		return false
	}
	// Typed decoding collapses absent and null legacy slots. A complete replacement
	// must persist the actual wire shape even when the interpreted choices match.
	candidate, err := json.Marshal(value)
	if err != nil {
		return false
	}
	var candidateFields map[string]json.RawMessage
	if json.Unmarshal(candidate, &candidateFields) != nil {
		return false
	}
	_, storedMode := fields["agentControlMode"]
	if storedMode {
		return false
	}
	var storedPaths, candidatePaths map[string]json.RawMessage
	if json.Unmarshal(fields["toolPaths"], &storedPaths) != nil || storedPaths == nil ||
		json.Unmarshal(candidateFields["toolPaths"], &candidatePaths) != nil || candidatePaths == nil || len(storedPaths) != len(candidatePaths) {
		return false
	}
	for key := range candidatePaths {
		if _, exists := storedPaths[key]; !exists {
			return false
		}
	}
	raw, err := json.Marshal(fields)
	if err != nil {
		return false
	}
	stored, err := parseWorkerConfiguration(raw, false)
	if err != nil {
		return false
	}
	stored.ArchiveSessions = storedArchive(desired)
	return reflect.DeepEqual(stored, value)
}

// Bootstrap adopts only empty slots and preserves all other stored fields.
func adoptRawConfiguration(desired *model.WorkerDesiredConfiguration, input model.WorkerConfigurationExchange) (json.RawMessage, bool, error) {
	fields, err := storedConfigurationFields(desired)
	if err != nil {
		return nil, false, err
	}
	// Unsupported stored targets require explicit correction, never bootstrap conversion.
	if _, exists := fields["agentControlMode"]; exists {
		return nil, false, nil
	}
	var existingPaths map[string]json.RawMessage
	if raw := fields["toolPaths"]; input.ToolPathsBootstrap != nil && len(raw) != 0 && !configurationNull(raw) {
		if json.Unmarshal(raw, &existingPaths) != nil || existingPaths == nil {
			return nil, false, invalidInput("Stored tool paths are invalid.")
		}
		if _, exists := existingPaths["herdr"]; exists {
			return nil, false, nil
		}
	}
	changed := false
	if input.ToolPathsBootstrap != nil {
		var slots map[string]json.RawMessage
		if len(fields["toolPaths"]) == 0 || configurationNull(fields["toolPaths"]) {
			slots = map[string]json.RawMessage{"codex": json.RawMessage("null"), "copilot": json.RawMessage("null")}
		} else if err := json.Unmarshal(fields["toolPaths"], &slots); err != nil || slots == nil {
			return nil, false, invalidInput("Stored tool paths are invalid.")
		}
		pathsChanged := false
		for tool, choice := range map[string]*model.ToolPathChoice{"codex": input.ToolPathsBootstrap.Codex, "copilot": input.ToolPathsBootstrap.Copilot} {
			if choice != nil && (len(slots[tool]) == 0 || configurationNull(slots[tool])) {
				slots[tool], err = json.Marshal(choice)
				if err != nil {
					return nil, false, err
				}
				pathsChanged = true
			}
		}
		if pathsChanged {
			fields["toolPaths"], err = json.Marshal(slots)
			if err != nil {
				return nil, false, err
			}
			changed = true
		}
	}
	if !changed {
		return nil, false, nil
	}
	raw, err := json.Marshal(fields)
	if err != nil {
		return nil, false, err
	}
	if configurationRawSize(fields, raw) > MaxConfigurationJSONBytes {
		return nil, false, invalidInput("Worker configuration exceeds its size limit.")
	}
	return raw, true, nil
}

func configurationProjects(ctx context.Context, dao store.WorkerWriteDAO, userID string, current *model.WorkerDesiredConfiguration, value model.WorkerConfiguration) error {
	retained := retainedProjects(current)
	for _, project := range value.Projects {
		if previous, exists := retained[project.ProjectID]; exists && reflect.DeepEqual(previous, project) {
			continue
		}
		if err := dao.ConfigurationProjectAccess(ctx, userID, project.ProjectID); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return &model.Fault{Code: "not_found", Message: "A selected project was not found or is inaccessible.", Cause: err}
			}
			return err
		}
	}
	return nil
}

// PutConfiguration applies a desired configuration against its independent revision.
// The value and revision are validated before opening the write scope.
func PutConfiguration(ctx context.Context, dao store.WorkerWriteDAO, principal model.Principal, workerID string, expected int64, value model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
	current, err := dao.WorkerConfiguration(ctx, principal.UserID, workerID)
	if err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return model.WorkerConfigurationResource{}, &model.Fault{Code: "not_found", Message: "Worker was not found.", Cause: err}
		}
		return model.WorkerConfigurationResource{}, err
	}
	if current.Desired == nil {
		return model.WorkerConfigurationResource{}, &model.Fault{Code: "configuration_not_initialized", Message: "Worker has not imported its initial configuration."}
	}
	actual, _ := strconv.ParseInt(current.Desired.Revision, 10, 64)
	if actual != expected {
		return model.WorkerConfigurationResource{}, &model.Fault{Code: "version_conflict", Message: "Worker configuration revision does not match."}
	}
	fields, err := storedConfigurationFields(current.Desired)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	if err := prepareTaskTagFilter(current, fields, &value); err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	if current.Desired.Raw != nil && (value.PreserveToolPaths || value.PreserveSudoCleanup || value.PreserveWindowsProcessCleanup || value.PreserveTaskTagFilter) {
		return putWithPreservedRaw(ctx, dao, principal, workerID, current, fields, actual, value)
	}
	if err := storedPaths(fields, &value); err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	if value.PreserveArchiveSessions {
		value.ArchiveSessions = storedArchive(current.Desired)
		value.PreserveArchiveSessions = false
	}
	if value.PreserveSudoCleanup {
		if raw := fields["enableSudoCleanup"]; len(raw) != 0 {
			if err := configurationDecode(raw, &value.EnableSudoCleanup); err != nil {
				return model.WorkerConfigurationResource{}, err
			}
		} else {
			value.EnableSudoCleanup = false
		}
		value.PreserveSudoCleanup = false
	}
	if value.PreserveWindowsProcessCleanup {
		if raw := fields["enableWindowsProcessCleanup"]; len(raw) != 0 {
			if err := configurationDecode(raw, &value.EnableWindowsProcessCleanup); err != nil {
				return model.WorkerConfigurationResource{}, err
			}
		} else {
			value.EnableWindowsProcessCleanup = false
		}
		value.PreserveWindowsProcessCleanup = false
	}
	value, err = NormalizeConfiguration(value)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	if _, err := workerprotocol.EncodeConfiguration(io.Discard, value, MaxConfigurationJSONBytes); err != nil {
		return model.WorkerConfigurationResource{}, InputLimit(err)
	}
	if err := configurationProjects(ctx, dao, principal.UserID, current.Desired, value); err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	if sameStoredConfiguration(current.Desired, fields, value) {
		return current, nil
	}
	if actual == math.MaxInt64 {
		return model.WorkerConfigurationResource{}, &model.Fault{Code: "version_exhausted", Message: "Worker configuration revision is exhausted."}
	}
	desired, err := dao.SetWorkerConfiguration(ctx, principal.UserID, workerID, actual+1, value)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	current.Desired = &desired
	return current, nil
}

// ExchangeConfiguration bootstraps desired state once and compares observation
// revisions independently from desired writes.
func ExchangeConfiguration(ctx context.Context, dao store.WorkerWriteDAO, principal model.Principal, workerID string, input model.WorkerConfigurationExchange) (*model.WorkerConfigurationReceipt, error) {
	return exchangeConfiguration(ctx, dao, principal, workerID, input, nil)
}

// ExchangeConfigurationAuthorized admits the desired projection and checks
// configuration authority only when the locked candidate changes desired state.
func ExchangeConfigurationAuthorized(ctx context.Context, dao store.WorkerWriteDAO, authorization model.CredentialAuthorization, workerID string, input model.WorkerConfigurationExchange) (*model.WorkerConfigurationReceipt, error) {
	return exchangeConfiguration(ctx, dao, authorization.Principal, workerID, input, func(operation scopepolicy.Operation) error {
		return scopeadmission.Require(authorization, operation)
	})
}

func exchangeConfiguration(ctx context.Context, dao store.WorkerWriteDAO, principal model.Principal, workerID string, input model.WorkerConfigurationExchange, admit func(scopepolicy.Operation) error) (*model.WorkerConfigurationReceipt, error) {
	if input.Bootstrap != nil && input.Bootstrap.TaskTagFilter != nil {
		return nil, invalidInput("Bootstrap cannot set a task tag filter.")
	}
	current, err := dao.WorkerConfiguration(ctx, principal.UserID, workerID)
	if err != nil {
		return nil, err
	}
	if admit != nil {
		if err := admit(scopepolicy.WorkerRead); err != nil {
			return nil, err
		}
	}
	if current.Desired != nil && current.Desired.Raw != nil {
		raw, changed, err := adoptRawConfiguration(current.Desired, input)
		if err != nil {
			return nil, err
		}
		if changed {
			if admit != nil {
				if err := admit(scopepolicy.WorkerConfigure); err != nil {
					return nil, err
				}
			}
			revision, _ := strconv.ParseInt(current.Desired.Revision, 10, 64)
			if revision == math.MaxInt64 {
				return nil, &model.Fault{Code: "version_exhausted", Message: "Worker configuration revision is exhausted."}
			}
			archive := storedArchive(current.Desired)
			if archive == nil {
				return nil, invalidInput("Stored archive setting is invalid.")
			}
			desired, err := dao.SetWorkerConfigurationRaw(ctx, principal.UserID, workerID, revision+1, raw, *archive)
			if err != nil {
				return nil, err
			}
			current.Desired = &desired
		}
	} else if current.Desired != nil || input.Bootstrap != nil {
		var value model.WorkerConfiguration
		revision := int64(0)
		if current.Desired != nil {
			value, err = normalizeStoredConfiguration(current.Desired.Value)
			if err != nil {
				return nil, err
			}
			revision, _ = strconv.ParseInt(current.Desired.Revision, 10, 64)
		} else {
			value = *input.Bootstrap
			empty := model.TagNameFilter{Names: []string{}, Match: "any"}
			value.TaskTagFilter = &empty
			value.PreserveTaskTagFilter = false
			if value.ArchiveSessions == nil {
				archive := true
				value.ArchiveSessions = &archive
			}
			value.PreserveArchiveSessions = false
		}
		original := value
		if input.ToolPathsBootstrap != nil {
			value.ToolPaths = adoptToolPaths(value.ToolPaths, *input.ToolPathsBootstrap)
		}
		if current.Desired == nil || !reflect.DeepEqual(original, value) {
			if admit != nil {
				if err := admit(scopepolicy.WorkerConfigure); err != nil {
					return nil, err
				}
			}
			if revision == math.MaxInt64 {
				return nil, &model.Fault{Code: "version_exhausted", Message: "Worker configuration revision is exhausted."}
			}
			value, err = NormalizeConfiguration(value)
			if err != nil {
				return nil, err
			}
			if err := configurationProjects(ctx, dao, principal.UserID, current.Desired, value); err != nil {
				return nil, err
			}
			desired, err := dao.SetWorkerConfiguration(ctx, principal.UserID, workerID, revision+1, value)
			if err != nil {
				return nil, err
			}
			current.Desired = &desired
		}
	}
	receipt := &model.WorkerConfigurationReceipt{Desired: current.Desired, ObservationRevision: current.ObservationRevision}
	if input.Observation != nil && input.Observation.BaseRevision == current.ObservationRevision {
		if current.Desired == nil {
			return nil, invalidInput("Configuration observations require a desired configuration.")
		}
		observed, _ := strconv.ParseInt(input.Observation.DesiredRevision, 10, 64)
		desired, _ := strconv.ParseInt(current.Desired.Revision, 10, 64)
		if observed > desired {
			return nil, invalidInput("Configuration observation revision exceeds the current desired revision.")
		}
		base, _ := strconv.ParseInt(current.ObservationRevision, 10, 64)
		if base == math.MaxInt64 {
			return nil, &model.Fault{Code: "version_exhausted", Message: "Worker configuration observation revision is exhausted."}
		}
		if err := dao.SetWorkerConfigurationObservation(ctx, principal.UserID, workerID, base+1, *input.Observation); err != nil {
			return nil, err
		}
		receipt.ObservationRevision = strconv.FormatInt(base+1, 10)
		receipt.ObservationAccepted = true
	}
	return receipt, nil
}

func putWithPreservedRaw(ctx context.Context, dao store.WorkerWriteDAO, principal model.Principal, workerID string, current model.WorkerConfigurationResource, fields map[string]json.RawMessage, actual int64, value model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
	preservePaths, preserveSudo, preserveFilter := value.PreserveToolPaths, value.PreserveSudoCleanup, value.PreserveTaskTagFilter
	preserveWindows := value.PreserveWindowsProcessCleanup
	if preserveFilter {
		value.TaskTagFilter = nil
		value.PreserveTaskTagFilter = false
	}
	if preservePaths {
		value.ToolPaths = model.WorkerToolPaths{}
		value.PreserveToolPaths = false
	}
	if preserveSudo {
		value.EnableSudoCleanup = false
		value.PreserveSudoCleanup = false
	}
	if preserveWindows {
		value.EnableWindowsProcessCleanup = false
		value.PreserveWindowsProcessCleanup = false
	}
	if value.PreserveArchiveSessions {
		value.ArchiveSessions = storedArchive(current.Desired)
		value.PreserveArchiveSessions = false
	}
	checks := map[string]json.RawMessage{}
	if !preservePaths {
		checks["toolPaths"] = fields["toolPaths"]
	}
	if err := storedPaths(checks, &value); err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	value, err := NormalizeConfiguration(value)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	if _, err := workerprotocol.EncodeConfiguration(io.Discard, value, MaxConfigurationJSONBytes); err != nil {
		return model.WorkerConfigurationResource{}, InputLimit(err)
	}
	if err := configurationProjects(ctx, dao, principal.UserID, current.Desired, value); err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	var candidate map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &candidate); err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	comparison := make(map[string]json.RawMessage, len(fields))
	for key, raw := range fields {
		comparison[key] = raw
	}
	for key, preserve := range map[string]bool{"toolPaths": preservePaths, "enableSudoCleanup": preserveSudo, "enableWindowsProcessCleanup": preserveWindows, "taskTagFilter": preserveFilter} {
		if !preserve {
			continue
		}
		if projected, exists := candidate[key]; exists {
			comparison[key] = projected
		} else {
			delete(comparison, key)
		}
		if raw, exists := fields[key]; exists {
			candidate[key] = raw
		} else {
			delete(candidate, key)
		}
	}
	if sameStoredConfiguration(current.Desired, comparison, value) {
		return current, nil
	}
	if actual == math.MaxInt64 {
		return model.WorkerConfigurationResource{}, &model.Fault{Code: "version_exhausted", Message: "Worker configuration revision is exhausted."}
	}
	raw, err := json.Marshal(candidate)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	if configurationRawSize(candidate, raw) > MaxConfigurationJSONBytes {
		return model.WorkerConfigurationResource{}, invalidInput("Worker configuration exceeds its size limit.")
	}
	archive := true
	if value.ArchiveSessions != nil {
		archive = *value.ArchiveSessions
	}
	desired, err := dao.SetWorkerConfigurationRaw(ctx, principal.UserID, workerID, actual+1, raw, archive)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	current.Desired = &desired
	return current, nil
}

// configurationRawSize excludes only the canonical empty member from the historical budget.
func configurationRawSize(fields map[string]json.RawMessage, raw []byte) int64 {
	size := int64(len(raw))
	var value struct {
		Names []string `json:"names"`
		Match string   `json:"match"`
	}
	filter, err := ParseTaskTagFilter(fields["taskTagFilter"])
	if err == nil && json.Unmarshal(fields["taskTagFilter"], &value) == nil && value.Names != nil && len(value.Names) == 0 && value.Match == "any" && len(filter.Names) == 0 {
		size -= workerprotocol.EmptyTaskTagFilterMemberBytes
	}
	return size
}

// prepareTaskTagFilter checks enablement using the latest observation while retaining
// display spelling when the semantic filter has not changed.
func prepareTaskTagFilter(current model.WorkerConfigurationResource, fields map[string]json.RawMessage, value *model.WorkerConfiguration) error {
	if value.PreserveTaskTagFilter {
		if current.Desired.Raw == nil {
			value.TaskTagFilter = current.Desired.Value.TaskTagFilter
			value.PreserveTaskTagFilter = false
		}
		return nil
	}
	if value.TaskTagFilter == nil {
		return nil
	}
	normalized, err := tag.NormalizeNameFilter(*value.TaskTagFilter)
	if err != nil {
		return invalidInput("Task tag filter is invalid.")
	}
	old, oldErr := ParseTaskTagFilter(fields["taskTagFilter"])
	if oldErr == nil {
		oldDigest, _ := tag.NameFilterDigest(old)
		newDigest, _ := tag.NameFilterDigest(normalized)
		if oldDigest == newDigest {
			value.TaskTagFilter = &old
			return nil
		}
	}
	if len(normalized.Names) > 0 {
		supported := false
		if current.Observation != nil {
			for _, item := range current.Observation.Items {
				if item.Key.Kind == "taskTagFilter" {
					supported = true
					break
				}
			}
		}
		if !supported {
			return &model.Fault{Code: "worker_task_tag_filter_unsupported", Message: "Worker has not reported support for task tag filtering."}
		}
	}
	value.TaskTagFilter = &normalized
	return nil
}
