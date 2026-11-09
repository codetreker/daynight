package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// ErrMonitoringWriteOutcomeUnknown means the write may have reached Redis.
var ErrMonitoringWriteOutcomeUnknown = errors.New("monitoring write outcome unknown")

type MonitoringIdentity struct {
	UserID   string
	WorkerID string
}

type MonitoringCandidate struct {
	RunID    string
	Sequence string
	Body     json.RawMessage
	Summary  json.RawMessage
}

type MonitoringReceipt struct {
	Revision   string    `json:"revision"`
	RunID      string    `json:"runId"`
	Sequence   string    `json:"sequence"`
	ReceivedAt time.Time `json:"receivedAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

type MonitoringCASKind string

const (
	MonitoringAccepted         MonitoringCASKind = "accepted"
	MonitoringDuplicate        MonitoringCASKind = "duplicate"
	MonitoringRevisionConflict MonitoringCASKind = "revision-conflict"
	MonitoringSequenceStale    MonitoringCASKind = "sequence-stale"
	MonitoringSampleConflict   MonitoringCASKind = "sample-conflict"
	MonitoringStateLost        MonitoringCASKind = "state-lost"
)

type MonitoringCASResult struct {
	Kind    MonitoringCASKind
	Receipt *MonitoringReceipt
}

type MonitoringValue struct {
	Receipt MonitoringReceipt
	Body    json.RawMessage
	Summary json.RawMessage
}

type MonitoringReadResult struct {
	ObservedAt time.Time
	Value      *MonitoringValue // nil means the key is absent.
}

type MonitoringSummariesResult struct {
	ObservedAt time.Time
	Values     []*MonitoringValue // nil entries mean absent, in request order; bodies are nil.
}

type MonitoringStore interface {
	CompareAndSet(context.Context, MonitoringIdentity, *string, MonitoringCandidate) (MonitoringCASResult, error)
	Read(context.Context, MonitoringIdentity) (MonitoringReadResult, error)
	ReadSummaries(context.Context, []MonitoringIdentity) (MonitoringSummariesResult, error)
}

// MonitoringError classifies a storage failure without exposing driver text.
// Cause retains the original error for internal inspection.
type MonitoringError struct {
	Kind  string
	Cause error
}

func (e *MonitoringError) Error() string { return "monitoring storage failed" }
func (e *MonitoringError) Unwrap() error { return e.Cause }
