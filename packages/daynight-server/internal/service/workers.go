package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type Workers struct{ store *store.Store }

func NewWorkers(database *store.Store) *Workers { return &Workers{store: database} }

type WorkerReportResult struct {
	Configuration  *model.WorkerConfigurationReceipt
	ObservedAt     time.Time
	LastReportedAt time.Time
}

type WorkerPage struct {
	ObservedAt time.Time
	Items      []model.WorkerSnapshot
	NextCursor *string
}

type WorkerDetailResult struct {
	ObservedAt time.Time
	Worker     model.WorkerSnapshot
}

func (s *Workers) Report(ctx context.Context, principal model.Principal, workerID string, input model.WorkerReport) (WorkerReportResult, error) {
	if err := requirePrincipal(principal); err != nil {
		return WorkerReportResult{}, err
	}
	workerID, err := CanonicalID(workerID)
	if err != nil {
		return WorkerReportResult{}, err
	}
	input, err = validateWorkerReport(input)
	if err != nil {
		return WorkerReportResult{}, err
	}
	if input.Configuration != nil {
		raw, marshalErr := json.Marshal(input.Configuration)
		if marshalErr != nil {
			return WorkerReportResult{}, invalidInput("Worker configuration exchange is invalid.")
		}
		input.Configuration, err = ParseWorkerConfigurationExchange(raw)
		if err != nil {
			return WorkerReportResult{}, err
		}
	}
	var result WorkerReportResult
	err = s.store.WriteWorker(ctx, func(tx *store.WorkerTx) error {
		observedAt, err := tx.ObservedAt(ctx)
		if err != nil {
			return err
		}
		observation := model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
		if input.TaskInventory != nil {
			items, err := tx.ReportTaskSnapshots(ctx, principal.UserID, workerID, *input.TaskInventory)
			if err != nil {
				return err
			}
			observation = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &observedAt,
				InventoryObservedAt: &input.TaskInventory.ObservedAt, Items: items}
		}
		stored, err := tx.UpsertWorker(ctx, model.WorkerSnapshot{UserID: principal.UserID, WorkerID: workerID,
			CreatedAt: observedAt, LastReportedAt: observedAt, Telemetry: input.Telemetry, TaskSnapshot: observation})
		if err != nil {
			return err
		}
		if input.Configuration != nil {
			result.Configuration, err = exchangeWorkerConfiguration(ctx, tx, principal, workerID, *input.Configuration)
			if err != nil {
				return err
			}
		}
		result.LastReportedAt = stored.LastReportedAt
		result.ObservedAt, err = tx.ObservedAt(ctx)
		return err
	})
	if err != nil {
		return WorkerReportResult{}, workerConfigurationError("report worker", err)
	}
	return result, nil
}

func (s *Workers) List(ctx context.Context, principal model.Principal, request model.PageRequest) (WorkerPage, error) {
	if err := requirePrincipal(principal); err != nil {
		return WorkerPage{}, err
	}
	scope := listScope{Kind: "workers", WorkerUserID: &principal.UserID}
	page, err := listPage(request, scope)
	if err != nil {
		return WorkerPage{}, err
	}
	var result WorkerPage
	var records store.WorkerPage
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		var err error
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		records, err = snapshot.Workers(ctx, principal.UserID, result.ObservedAt, page)
		return err
	})
	if err != nil {
		return WorkerPage{}, fmt.Errorf("list workers: %w", err)
	}
	result.Items = records.Items
	if records.HasMore {
		last := records.Items[len(records.Items)-1]
		cursor, err := encodeListCursor(scope, last.CreatedAt, last.WorkerID)
		if err != nil {
			return WorkerPage{}, fmt.Errorf("encode worker cursor: %w", err)
		}
		result.NextCursor = &cursor
	}
	return result, nil
}

func (s *Workers) Get(ctx context.Context, principal model.Principal, workerID string) (WorkerDetailResult, error) {
	if err := requirePrincipal(principal); err != nil {
		return WorkerDetailResult{}, err
	}
	workerID, err := CanonicalID(workerID)
	if err != nil {
		return WorkerDetailResult{}, err
	}
	var result WorkerDetailResult
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		var err error
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		result.Worker, err = snapshot.Worker(ctx, principal.UserID, workerID, result.ObservedAt)
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
