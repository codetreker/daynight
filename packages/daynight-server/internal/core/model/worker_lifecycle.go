package model

import (
	"encoding/json"
	"time"
)

// WorkerLifecycle is the persistent cloud admission authority for one Worker.
type WorkerLifecycle struct {
	UserID, WorkerID                    string
	ProtocolVersion                     int
	IntentVersion                       int64
	Desired, Admission                  string
	CurrentOperationID, InstanceID      *string
	InstanceEpoch                       int64
	CapabilityVersion                   *int
	BootstrapConsumed, ReconnectAllowed bool
	UpdatedAt                           time.Time
}

// LifecycleOperation retains the original request and receipt, including a
// separately resolved activation phase for a resume intent.
type LifecycleOperation struct {
	UserID, WorkerID, OperationID, Action, Source, RequestKind string
	RequestHash                                                []byte
	Request                                                    json.RawMessage
	IntentVersion                                              int64
	State                                                      string
	Receipt, Activation, ActivationRequest                     json.RawMessage
	ActivationHash                                             []byte
	ActivationOutcome                                          string
	ErrorCode                                                  *string
	CreatedAt, UpdatedAt                                       time.Time
}

type LifecycleCapabilities struct {
	Disable       bool `json:"disable"`
	Resume        bool `json:"resume"`
	Inventory     int  `json:"inventory"`
	DispatchFence int  `json:"dispatchFence"`
}

type LifecycleInstanceRequest struct {
	ProtocolVersion       int                   `json:"protocolVersion"`
	OperationID           string                `json:"operationId"`
	InstanceID            string                `json:"instanceId"`
	PreviousInstanceEpoch *string               `json:"previousInstanceEpoch"`
	Capabilities          LifecycleCapabilities `json:"capabilities"`
	Platform              string                `json:"platform"`
}

// LifecycleIntentRequest carries one of the two intent variants. The protocol
// encoder preserves each variant's required nulls and excludes the other fields.
type LifecycleIntentRequest struct {
	ProtocolVersion                              int
	OperationID, Action, ExpectedVersion, Source string
	LocalEpoch, OriginOperationID, InstanceEpoch *string
}

func (r LifecycleIntentRequest) MarshalJSON() ([]byte, error) {
	if r.Action == "disable" {
		return json.Marshal(struct {
			ProtocolVersion   int     `json:"protocolVersion"`
			OperationID       string  `json:"operationId"`
			Action            string  `json:"action"`
			ExpectedVersion   string  `json:"expectedVersion"`
			Source            string  `json:"source"`
			LocalEpoch        *string `json:"localEpoch"`
			OriginOperationID *string `json:"originOperationId"`
		}{r.ProtocolVersion, r.OperationID, r.Action, r.ExpectedVersion, r.Source, r.LocalEpoch, r.OriginOperationID})
	}
	return json.Marshal(struct {
		ProtocolVersion int     `json:"protocolVersion"`
		OperationID     string  `json:"operationId"`
		Action          string  `json:"action"`
		ExpectedVersion string  `json:"expectedVersion"`
		Source          string  `json:"source"`
		LocalEpoch      *string `json:"localEpoch"`
		InstanceEpoch   *string `json:"instanceEpoch"`
	}{r.ProtocolVersion, r.OperationID, r.Action, r.ExpectedVersion, r.Source, r.LocalEpoch, r.InstanceEpoch})
}

func (r *LifecycleIntentRequest) UnmarshalJSON(b []byte) error {
	var v struct {
		ProtocolVersion   int     `json:"protocolVersion"`
		OperationID       string  `json:"operationId"`
		Action            string  `json:"action"`
		ExpectedVersion   string  `json:"expectedVersion"`
		Source            string  `json:"source"`
		LocalEpoch        *string `json:"localEpoch"`
		OriginOperationID *string `json:"originOperationId"`
		InstanceEpoch     *string `json:"instanceEpoch"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*r = LifecycleIntentRequest{v.ProtocolVersion, v.OperationID, v.Action, v.ExpectedVersion, v.Source, v.LocalEpoch, v.OriginOperationID, v.InstanceEpoch}
	return nil
}

type LifecycleActivationRequest struct {
	ProtocolVersion int    `json:"protocolVersion"`
	OperationID     string `json:"operationId"`
	Action          string `json:"action,omitempty"`
	InstanceID      string `json:"instanceId"`
	InstanceEpoch   string `json:"instanceEpoch"`
	IntentVersion   string `json:"intentVersion"`
	LocalEpoch      string `json:"localEpoch"`
	ScopeGeneration string `json:"scopeGeneration"`
	ReportSequence  string `json:"reportSequence"`
}

type LifecycleResolveRequest struct {
	ProtocolVersion int             `json:"protocolVersion"`
	RequestKind     string          `json:"requestKind"`
	Request         json.RawMessage `json:"request"`
}

type LifecycleResourceObservation struct {
	ResourceID          string  `json:"resourceId"`
	OwnerKind           string  `json:"ownerKind"`
	ProjectID           *string `json:"projectId"`
	TaskID              *string `json:"taskId"`
	BotID               *string `json:"botId"`
	ExecutionID         *string `json:"executionId"`
	SessionID           *string `json:"sessionId"`
	ExecutionGeneration *string `json:"executionGeneration"`
	Stage               string  `json:"stage"`
	Stop                string  `json:"stop"`
	Save                string  `json:"save"`
	ErrorCode           *string `json:"errorCode"`
}

type LifecycleRecoveryObservation struct {
	ResourceID     string  `json:"resourceId"`
	Recoverability string  `json:"recoverability"`
	ReasonCode     *string `json:"reasonCode"`
}

type LifecycleObservation struct {
	Phase             string                         `json:"phase"`
	Stop              string                         `json:"stop"`
	Save              string                         `json:"save"`
	Sync              string                         `json:"sync"`
	InventoryComplete bool                           `json:"inventoryComplete"`
	DetailsComplete   bool                           `json:"detailsComplete"`
	InventoryRevision string                         `json:"inventoryRevision"`
	InventoryDigest   string                         `json:"inventoryDigest"`
	ResourceCount     *int64                         `json:"resourceCount"`
	StoppedCount      *int64                         `json:"stoppedCount"`
	PendingCount      *int64                         `json:"pendingCount"`
	BlockedCount      *int64                         `json:"blockedCount"`
	Resources         []LifecycleResourceObservation `json:"resources"`
	Recovery          []LifecycleRecoveryObservation `json:"recovery"`
	ErrorCode         *string                        `json:"errorCode"`
}

type LifecycleObservationEnvelope struct {
	ProtocolVersion int                  `json:"protocolVersion"`
	InstanceID      string               `json:"instanceId"`
	InstanceEpoch   string               `json:"instanceEpoch"`
	IntentVersion   string               `json:"intentVersion"`
	OperationID     *string              `json:"operationId"`
	LocalEpoch      string               `json:"localEpoch"`
	ScopeGeneration string               `json:"scopeGeneration"`
	ReportSequence  string               `json:"reportSequence"`
	Observation     LifecycleObservation `json:"observation"`
}

type LifecycleStoredObservation struct {
	UserID, WorkerID string
	Envelope         LifecycleObservationEnvelope
	ReceivedAt       time.Time
}

type LifecycleObservedObservation struct {
	LifecycleObservation
	ReceivedAt time.Time `json:"receivedAt"`
	FreshUntil time.Time `json:"freshUntil"`
}

type LifecycleObservedEnvelope struct {
	ProtocolVersion int                          `json:"protocolVersion"`
	InstanceID      string                       `json:"instanceId"`
	InstanceEpoch   string                       `json:"instanceEpoch"`
	IntentVersion   string                       `json:"intentVersion"`
	OperationID     *string                      `json:"operationId"`
	LocalEpoch      string                       `json:"localEpoch"`
	ScopeGeneration string                       `json:"scopeGeneration"`
	ReportSequence  string                       `json:"reportSequence"`
	Observation     LifecycleObservedObservation `json:"observation"`
}

type LifecycleInstance struct {
	InstanceID    string `json:"instanceId"`
	InstanceEpoch string `json:"instanceEpoch"`
}

type LifecycleResource struct {
	ProtocolVersion int                        `json:"protocolVersion"`
	WorkerID        string                     `json:"workerId"`
	IntentVersion   string                     `json:"intentVersion"`
	Desired         string                     `json:"desired"`
	Admission       string                     `json:"admission"`
	OperationID     *string                    `json:"operationId"`
	Instance        *LifecycleInstance         `json:"instance"`
	Capability      string                     `json:"capability"`
	Observation     *LifecycleObservedEnvelope `json:"observation"`
	ObservedAt      time.Time                  `json:"observedAt"`
}

type LifecycleInstanceReceipt struct {
	ProtocolVersion  int       `json:"protocolVersion"`
	WorkerID         string    `json:"workerId"`
	InstanceID       string    `json:"instanceId"`
	InstanceEpoch    string    `json:"instanceEpoch"`
	IntentVersion    string    `json:"intentVersion"`
	Desired          string    `json:"desired"`
	Admission        string    `json:"admission"`
	OperationID      string    `json:"operationId"`
	ReconnectAllowed bool      `json:"reconnectAllowed"`
	ObservedAt       time.Time `json:"observedAt"`
}

type LifecycleIntentReceipt struct {
	ProtocolVersion int       `json:"protocolVersion"`
	WorkerID        string    `json:"workerId"`
	OperationID     string    `json:"operationId"`
	Action          string    `json:"action"`
	IntentVersion   string    `json:"intentVersion"`
	Desired         string    `json:"desired"`
	Admission       string    `json:"admission"`
	State           string    `json:"state"`
	ErrorCode       *string   `json:"errorCode"`
	ObservedAt      time.Time `json:"observedAt"`
}

type LifecycleActivationReceipt struct {
	ProtocolVersion int       `json:"protocolVersion"`
	WorkerID        string    `json:"workerId"`
	OperationID     string    `json:"operationId"`
	Action          string    `json:"action"`
	InstanceEpoch   string    `json:"instanceEpoch"`
	IntentVersion   string    `json:"intentVersion"`
	LocalEpoch      string    `json:"localEpoch"`
	ScopeGeneration string    `json:"scopeGeneration"`
	Admission       string    `json:"admission"`
	ObservedAt      time.Time `json:"observedAt"`
}

type LifecycleObservationReceipt struct {
	ProtocolVersion int       `json:"protocolVersion"`
	Accepted        bool      `json:"accepted"`
	IntentVersion   string    `json:"intentVersion"`
	InstanceEpoch   string    `json:"instanceEpoch"`
	ReportSequence  string    `json:"reportSequence"`
	ReceivedAt      time.Time `json:"receivedAt"`
}

type LifecycleResolutionReceipt struct {
	ProtocolVersion int       `json:"protocolVersion"`
	WorkerID        string    `json:"workerId"`
	OperationID     string    `json:"operationId"`
	RequestKind     string    `json:"requestKind"`
	RequestHash     string    `json:"requestHash"`
	Outcome         string    `json:"outcome"`
	ObservedAt      time.Time `json:"observedAt"`
}

type LifecycleOperationResult struct {
	Kind              string
	Receipt           json.RawMessage
	Activation        json.RawMessage
	ActivationOutcome string
}

func (r LifecycleOperationResult) MarshalJSON() ([]byte, error) {
	if r.Kind == "intent" {
		return json.Marshal(struct {
			Kind              string          `json:"kind"`
			Receipt           json.RawMessage `json:"receipt"`
			Activation        json.RawMessage `json:"activation"`
			ActivationOutcome string          `json:"activationOutcome"`
		}{r.Kind, r.Receipt, r.Activation, r.ActivationOutcome})
	}
	return json.Marshal(struct {
		Kind    string          `json:"kind"`
		Receipt json.RawMessage `json:"receipt"`
	}{r.Kind, r.Receipt})
}
