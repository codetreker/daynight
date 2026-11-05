package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func workerConfigurationError(operation string, err error) error {
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
		return fmt.Errorf("%s: %w", operation, err)
	}
	var fault *model.Fault
	if errors.As(err, &fault) {
		return fault
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func configurationNotFound(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Worker was not found.", Cause: err}
	}
	return err
}

func (s *Workers) Configuration(ctx context.Context, principal model.Principal, workerID string) (model.WorkerConfigurationResource, error) {
	if err := requirePrincipal(principal); err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	workerID, err := CanonicalID(workerID)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	var result model.WorkerConfigurationResource
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		var err error
		result, err = snapshot.WorkerDAO().WorkerConfiguration(ctx, principal.UserID, workerID)
		return configurationNotFound(err)
	})
	if err != nil {
		return model.WorkerConfigurationResource{}, workerConfigurationError("get worker configuration", err)
	}
	return result, nil
}

func normalizeWorkerConfiguration(value model.WorkerConfiguration) (model.WorkerConfiguration, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return model.WorkerConfiguration{}, invalidInput("Worker configuration is invalid.")
	}
	return ParseWorkerConfiguration(raw)
}

func configurationProjects(ctx context.Context, tx *store.WorkerTx, userID string, current *model.WorkerDesiredConfiguration, value model.WorkerConfiguration) error {
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
		if err := tx.ConfigurationProjectAccess(ctx, userID, project.ProjectID); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return &model.Fault{Code: "not_found", Message: "A selected project was not found or is inaccessible.", Cause: err}
			}
			return err
		}
	}
	return nil
}

func (s *Workers) PutConfiguration(ctx context.Context, principal model.Principal, workerID, revision string, value model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
	if err := requirePrincipal(principal); err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	workerID, err := CanonicalID(workerID)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	expected, err := ConfigurationRevision(revision, false)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	value, err = normalizeWorkerConfiguration(value)
	if err != nil {
		return model.WorkerConfigurationResource{}, err
	}
	var result model.WorkerConfigurationResource
	err = s.store.WriteWorker(ctx, func(tx *store.WorkerTx) error {
		current, err := tx.WorkerConfiguration(ctx, principal.UserID, workerID)
		if err != nil {
			return configurationNotFound(err)
		}
		if current.Desired == nil {
			return &model.Fault{Code: "configuration_not_initialized", Message: "Worker has not imported its initial configuration."}
		}
		actual, _ := strconv.ParseInt(current.Desired.Revision, 10, 64)
		if actual != expected {
			return &model.Fault{Code: "version_conflict", Message: "Worker configuration revision does not match."}
		}
		current.Desired.Value, err = normalizeWorkerConfiguration(current.Desired.Value)
		if err != nil {
			return err
		}
		if err := configurationProjects(ctx, tx, principal.UserID, current.Desired, value); err != nil {
			return err
		}
		result = current
		if reflect.DeepEqual(current.Desired.Value, value) {
			return nil
		}
		if actual == math.MaxInt64 {
			return &model.Fault{Code: "version_exhausted", Message: "Worker configuration revision is exhausted."}
		}
		desired, err := tx.SetWorkerConfiguration(ctx, principal.UserID, workerID, actual+1, value)
		if err != nil {
			return err
		}
		result.Desired = &desired
		return nil
	})
	if err != nil {
		return model.WorkerConfigurationResource{}, workerConfigurationError("save worker configuration", err)
	}
	return result, nil
}

func exchangeWorkerConfiguration(ctx context.Context, tx *store.WorkerTx, principal model.Principal, workerID string, input model.WorkerConfigurationExchange) (*model.WorkerConfigurationReceipt, error) {
	current, err := tx.WorkerConfiguration(ctx, principal.UserID, workerID)
	if err != nil {
		return nil, err
	}
	if current.Desired == nil && input.Bootstrap != nil {
		if err := configurationProjects(ctx, tx, principal.UserID, nil, *input.Bootstrap); err != nil {
			return nil, err
		}
		desired, err := tx.SetWorkerConfiguration(ctx, principal.UserID, workerID, 1, *input.Bootstrap)
		if err != nil {
			return nil, err
		}
		current.Desired = &desired
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
		if err := tx.SetWorkerConfigurationObservation(ctx, principal.UserID, workerID, base+1, *input.Observation); err != nil {
			return nil, err
		}
		receipt.ObservationRevision = strconv.FormatInt(base+1, 10)
		receipt.ObservationAccepted = true
	}
	return receipt, nil
}
