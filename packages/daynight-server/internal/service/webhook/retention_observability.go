package webhook

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
)

// RetentionObservation describes the latest completed pass, not total retained
// data. OldestObservedLag is a lower bound sampled from candidates rechecked
// under lock; LagKnown is false when no such candidate was observed.
type RetentionObservation struct {
	Available, ContinueSoon, Unknown, Failed            bool
	ConfirmedRows, ConfigRows, ReceiptRows, HistoryRows int
	LagKnown                                            bool
	OldestObservedLag                                   time.Duration
	LagObservedAt                                       time.Time
	DroppedEvents                                       uint64
}

type retentionLag struct {
	known    bool
	duration time.Duration
	at       time.Time
}

// RetentionEvent contains only confirmed counts, actual identities and safe
// error codes. Its optional observation describes a completed maintenance pass.
type RetentionEvent struct {
	Phase                                                          string
	ConfirmedRows                                                  int
	EventID, DeliveryID, EndpointID, OwnerKind, OwnerID, ProjectID string
	AdapterVersion, Generation                                     int64
	Trigger, ErrorCode                                             string
	Observation                                                    *RetentionObservation
}

// Events returns a bounded stream. Emission never waits for a consumer; when
// full, events are dropped and Observation reports the cumulative drop count.
// Stop does not close this stream, so callers may drain it after shutdown.
func (r *Retention) Events() <-chan RetentionEvent { return r.events }

// Observation returns a consistent copy of the most recently completed pass.
func (r *Retention) Observation() RetentionObservation {
	r.observationMu.RLock()
	obs := r.observation
	r.observationMu.RUnlock()
	obs.DroppedEvents = r.droppedEvents.Load()
	return obs
}

func (r *Retention) emitRetentionEvent(event RetentionEvent) {
	select {
	case r.events <- event:
	default:
		r.droppedEvents.Add(1)
	}
}

func (r *Retention) recordLag(now, due time.Time) {
	if due.IsZero() || now.Before(due) {
		return
	}
	lag := now.Sub(due)
	if !r.passLag.known || lag > r.passLag.duration {
		r.passLag = retentionLag{known: true, duration: lag, at: now}
	}
}

func (r *Retention) publishObservation(obs RetentionObservation, cause error) {
	var receiptUnknown *core.ReceiptGCUnknownError
	var configUnknown *core.ConfigGCUnknownError
	obs.Available = true
	if errors.Is(cause, errDeliveryOutcomeUnknown) || errors.As(cause, &receiptUnknown) || errors.As(cause, &configUnknown) {
		r.unknownPending = true
	}
	obs.Unknown = r.unknownPending
	obs.Failed = cause != nil
	obs.LagKnown, obs.OldestObservedLag, obs.LagObservedAt = r.passLag.known, r.passLag.duration, r.passLag.at
	obs.DroppedEvents = r.droppedEvents.Load()
	r.observationMu.Lock()
	r.observation = obs
	r.observationMu.Unlock()
	event := RetentionEvent{Phase: "retention_pass", ConfirmedRows: obs.ConfirmedRows, Observation: &obs}
	if cause != nil {
		event.ErrorCode = "maintenance_error"
		if obs.Unknown {
			event.ErrorCode = "transaction_unknown"
		}
	}
	r.emitRetentionEvent(event)
}

func (r *Retention) emitRetentionStep(phase, kind, id string, d store.WebhookDelivery, rows int, cause error) {
	if phase == "" {
		phase = "retention"
	}
	event := RetentionEvent{Phase: phase, ConfirmedRows: rows}
	if kind == "event" && id != "" {
		event.EventID = id
	}
	if kind == "delivery" && id != "" {
		event.EventID, event.DeliveryID, event.EndpointID = d.EventID, id, d.EndpointID
		event.OwnerKind, event.OwnerID, event.ProjectID = d.Owner.Kind, d.Owner.ID, d.ProjectID
		event.AdapterVersion, event.Trigger, event.Generation = d.AdapterVersion, d.Trigger, d.Generation
	}
	if cause != nil {
		event.ErrorCode = "maintenance_error"
		if errors.Is(cause, errDeliveryOutcomeUnknown) {
			event.ErrorCode = "transaction_unknown"
		}
	}
	r.emitRetentionEvent(event)
}

// Log writes one sanitized event. Invoke it outside the maintenance activation;
// a slog handler can block and must not run inside Pass or Stop.
func (e RetentionEvent) Log(ctx context.Context, logger *slog.Logger) {
	if logger == nil {
		return
	}
	fields := []any{"component", "webhook", "phase", e.Phase, "confirmed_rows", e.ConfirmedRows}
	if e.EventID != "" {
		fields = append(fields, "event_id", e.EventID)
	}
	if e.DeliveryID != "" {
		fields = append(fields, "delivery_id", e.DeliveryID, "endpoint_id", e.EndpointID, "owner_kind", e.OwnerKind, "owner_id", e.OwnerID, "project_id", e.ProjectID, "adapter_version", e.AdapterVersion, "trigger", e.Trigger, "generation", e.Generation)
	}
	if e.Observation != nil {
		o := e.Observation
		fields = append(fields, "config_rows", o.ConfigRows, "receipt_rows", o.ReceiptRows, "history_rows", o.HistoryRows, "continue_soon", o.ContinueSoon, "lag_known", o.LagKnown, "unknown", o.Unknown, "dropped_events", o.DroppedEvents)
		if o.LagKnown {
			fields = append(fields, "oldest_observed_lag_ms", o.OldestObservedLag.Milliseconds(), "lag_observed_at", o.LagObservedAt)
		}
	}
	if e.ErrorCode != "" {
		logger.ErrorContext(ctx, "webhook retention", append(fields, "error_code", e.ErrorCode)...)
		return
	}
	logger.InfoContext(ctx, "webhook retention", fields...)
}
