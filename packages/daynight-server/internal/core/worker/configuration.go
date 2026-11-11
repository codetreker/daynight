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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	normalized.PreserveAgentControlMode = value.PreserveAgentControlMode
	normalized.PreserveToolPaths = value.PreserveToolPaths
	return normalized, err
}

func normalizeStoredConfiguration(value model.WorkerConfiguration) (model.WorkerConfiguration, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return model.WorkerConfiguration{}, invalidInput("Stored Worker configuration is invalid.")
	}
	return parseWorkerConfiguration(raw, false)
}

func configurationProjects(ctx context.Context, dao store.WorkerWriteDAO, userID string, current *model.WorkerDesiredConfiguration, value model.WorkerConfiguration) error {
	retained := map[string]model.WorkerProjectConfiguration{}
	if current != nil {
		for _, project := range current.Value.Projects {
			retained[project.ProjectID] = project
		}
	}
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
	current.Desired.Value, err = normalizeStoredConfiguration(current.Desired.Value)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	if value.PreserveAgentControlMode {
		value.AgentControlMode = current.Desired.Value.AgentControlMode
		value.PreserveAgentControlMode = false
	} else if value.AgentControlMode == nil && current.Desired.Value.AgentControlMode != nil {
		return model.WorkerConfigurationResource{}, invalidInput("An adopted agent control mode cannot be cleared.")
	}
	if value.PreserveToolPaths {
		value.ToolPaths = current.Desired.Value.ToolPaths
		value.PreserveToolPaths = false
	} else if clearsToolPaths(current.Desired.Value.ToolPaths, value.ToolPaths) {
		return model.WorkerConfigurationResource{}, invalidInput("Adopted tool paths cannot be cleared.")
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
	if reflect.DeepEqual(current.Desired.Value, value) {
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
	current, err := dao.WorkerConfiguration(ctx, principal.UserID, workerID)
	if err != nil {
		return nil, err
	}
	if current.Desired != nil || input.Bootstrap != nil {
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
		}
		original := value
		if value.AgentControlMode == nil {
			value.AgentControlMode = input.ControlModeBootstrap
		}
		if input.ToolPathsBootstrap != nil {
			value.ToolPaths = adoptToolPaths(value.ToolPaths, *input.ToolPathsBootstrap)
		}
		if current.Desired == nil || !reflect.DeepEqual(original, value) {
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
