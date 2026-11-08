package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

type workerStore interface {
	store.SnapshotReader
	store.WorkerWriter
}

type Workers struct{ store workerStore }

func NewWorkers(database workerStore) *Workers { return &Workers{store: database} }

type WorkerReportResult struct {
	Configuration  *model.WorkerConfigurationReceipt
	ObservedAt     time.Time
	LastReportedAt time.Time
}

type WorkerPage struct {
	ObservedAt time.Time
	Items      []workerprotocol.WorkerSummary
	NextCursor *string
}

type WorkerDetailResult struct {
	ObservedAt time.Time
	Worker     model.WorkerSnapshot
}

func (s *Workers) Report(ctx context.Context, principal model.Principal, workerID string, input model.WorkerReport) (WorkerReportResult, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return WorkerReportResult{}, err
	}
	workerID, err := model.CanonicalID(workerID)
	if err != nil {
		return WorkerReportResult{}, err
	}
	input, err = workercore.ValidateReport(input)
	if err != nil {
		return WorkerReportResult{}, err
	}
	if _, err := workerprotocol.EncodeTelemetry(io.Discard, input.Telemetry, workercore.MaxTelemetryJSONBytes); err != nil {
		return WorkerReportResult{}, workercore.InputLimit(err)
	}
	if input.Configuration != nil {
		raw, marshalErr := json.Marshal(input.Configuration)
		if marshalErr != nil {
			return WorkerReportResult{}, &model.Fault{Code: "invalid_input", Message: "Worker configuration exchange is invalid."}
		}
		input.Configuration, err = workercore.ParseWorkerConfigurationExchange(raw)
		if err != nil {
			return WorkerReportResult{}, err
		}
	}
	var result WorkerReportResult
	completion, err := s.store.WriteWorker(ctx, func(scope store.WorkerScope) error {
		tx := scope.WorkerDAO()
		admission, err := scope.AdmitWorker(ctx, principal.UserID, workerID, workercore.ActiveWindow)
		if err != nil {
			return err
		}
		if err := workercore.AdmitActiveWorker(admission); err != nil {
			return err
		}
		observedAt := admission.ObservedAt
		var items []model.WorkerObservedTask
		if input.TaskInventory != nil {
			sources, err := tx.ReportTaskSnapshots(ctx, principal.UserID, *input.TaskInventory)
			if err != nil {
				return err
			}
			items, err = workercore.MatchTaskSnapshots(sources, *input.TaskInventory, principal.UserID, workerID)
			if err != nil {
				return err
			}
		}
		stored, err := tx.UpsertWorker(ctx, workercore.SnapshotForReport(principal.UserID, workerID, input, observedAt, items))
		if err != nil {
			return err
		}
		if _, err := workerprotocol.EncodeItem(io.Discard, stored, workercore.MaxWorkerJSONBytes); err != nil {
			return workercore.InputLimit(err)
		}
		if input.Configuration != nil {
			result.Configuration, err = workercore.ExchangeConfiguration(ctx, tx, principal, workerID, *input.Configuration)
			if err != nil {
				return err
			}
			if result.Configuration.ObservationAccepted {
				configuration, err := tx.WorkerConfiguration(ctx, principal.UserID, workerID)
				if err != nil {
					return err
				}
				if configuration.Observation == nil {
					return fmt.Errorf("accepted worker configuration observation is missing")
				}
				if _, err := workerprotocol.EncodeObservation(io.Discard, *configuration.Observation, workercore.MaxConfigurationJSONBytes); err != nil {
					return workercore.InputLimit(err)
				}
			}
		}
		result.LastReportedAt = stored.LastReportedAt
		result.ObservedAt, err = scope.ObservedAt(ctx)
		return err
	})
	if err != nil {
		return WorkerReportResult{}, workerConfigurationError("report worker", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return WorkerReportResult{}, fmt.Errorf("report worker: transaction did not confirm commit")
	}
	return result, nil
}

func (s *Workers) List(ctx context.Context, principal model.Principal, request model.PageRequest) (WorkerPage, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return WorkerPage{}, err
	}
	page, err := workercore.ListPage(request, principal.UserID)
	if err != nil {
		return WorkerPage{}, err
	}
	result := WorkerPage{Items: []workerprotocol.WorkerSummary{}}
	var cursors []string
	pendingLast := false
	limitError := func() error {
		return &model.Fault{Code: "resource_limit_exceeded", Message: "Worker summary exceeds the encoded page limit."}
	}
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		var err error
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		return snapshot.WorkerDAO().WorkerSummaries(ctx, principal.UserID, result.ObservedAt, page, func(item store.WorkerSummary) (bool, error) {
			// An item which only fits without a cursor is valid only at the end.
			if pendingLast {
				if len(result.Items) == 1 {
					return false, limitError()
				}
				result.Items = result.Items[:len(result.Items)-1]
				cursor := cursors[len(cursors)-2]
				result.NextCursor = &cursor
				return false, nil
			}
			if len(result.Items) == page.Limit || item.Oversized {
				if len(result.Items) == 0 {
					return false, limitError()
				}
				cursor := cursors[len(cursors)-1]
				result.NextCursor = &cursor
				return false, nil
			}
			cursor, err := workercore.ListCursor(principal.UserID, item.CreatedAt, item.WorkerID)
			if err != nil {
				return false, err
			}
			summary := workerprotocol.WorkerSummary{WorkerID: item.WorkerID, Machine: workerprotocol.WorkerMachine{ID: item.Machine.ID, Name: item.Machine.Name}, Platform: string(item.Platform), LastReportedAt: item.LastReportedAt, TaskObservationState: string(item.TaskObservationState), TaskObservedAt: item.TaskObservedAt, ActiveTaskCount: item.ActiveTaskCount}
			result.Items = append(result.Items, summary)
			cursors = append(cursors, cursor)
			wire := workerprotocol.WorkerPage{ObservedAt: result.ObservedAt.UTC(), Items: result.Items, NextCursor: &cursor}
			_, err = measure.JSON(io.Discard, "worker.page", workercore.MaxPageResponseJSONBytes, wire, true)
			if err == nil {
				return true, nil
			}
			var violation *limit.Violation
			if !errors.As(err, &violation) {
				return false, err
			}
			wire.NextCursor = nil
			_, noCursorErr := measure.JSON(io.Discard, "worker.page", workercore.MaxPageResponseJSONBytes, wire, true)
			if noCursorErr == nil {
				pendingLast = true
				return true, nil
			}
			if !errors.As(noCursorErr, &violation) {
				return false, noCursorErr
			}
			result.Items = result.Items[:len(result.Items)-1]
			if len(result.Items) == 0 {
				return false, limitError()
			}
			previous := cursors[len(cursors)-2]
			result.NextCursor = &previous
			return false, nil
		})
	})
	if err != nil {
		return WorkerPage{}, fmt.Errorf("list workers: %w", err)
	}
	return result, nil
}

func (s *Workers) Get(ctx context.Context, principal model.Principal, workerID string) (WorkerDetailResult, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return WorkerDetailResult{}, err
	}
	workerID, err := model.CanonicalID(workerID)
	if err != nil {
		return WorkerDetailResult{}, err
	}
	var result WorkerDetailResult
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		var err error
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		result.Worker, err = snapshot.WorkerDAO().Worker(ctx, principal.UserID, workerID, result.ObservedAt)
		if errors.Is(err, model.ErrNotFound) {
			refusal = &model.Fault{Code: "not_found", Message: "Worker was not found.", Cause: err}
			return nil
		}
		return err
	})
	if err != nil {
		return WorkerDetailResult{}, fmt.Errorf("get worker: %w", err)
	}
	if refusal != nil {
		return WorkerDetailResult{}, refusal
	}
	return result, nil
}
