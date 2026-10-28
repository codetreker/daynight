package sessionprotocol

import "encoding/json"

const (
	MaxFrameBytes    = 2_097_152
	MaxBatchEvents   = 100
	MaxResourceBytes = 8_388_608
)

type ControllerFence struct {
	Fence
	ConnectionEpoch string `json:"connectionEpoch"`
}
type Registration struct {
	Protocol             string `json:"protocol"`
	RegistrationID       string `json:"registrationId"`
	ClaimID              string `json:"claimId"`
	WorkerID             string `json:"workerId,omitempty"`
	WorktreeID           string `json:"worktreeId,omitempty"`
	Provider             string `json:"provider"`
	ControllerID         string `json:"controllerId"`
	ControllerInstanceID string `json:"controllerInstanceId"`
}
type StopProof struct {
	Kind                         string `json:"kind,omitempty"`
	RecordID                     string `json:"recordId"`
	PreviousControllerInstanceID string `json:"previousControllerInstanceId"`
	StoppedAt                    string `json:"stoppedAt"`
}
type Grant struct {
	TestExecutionID      string     `json:"testExecutionId,omitempty"`
	Protocol             string     `json:"protocol"`
	ClaimID              string     `json:"claimId,omitempty"`
	ControllerID         string     `json:"controllerId"`
	ControllerInstanceID string     `json:"controllerInstanceId"`
	ExecutionGeneration  string     `json:"executionGeneration"`
	Kind                 string     `json:"kind"`
	PreviousGeneration   *string    `json:"previousGeneration"`
	StopProof            *StopProof `json:"stopProof"`
}
type Identity struct {
	OwnerUserID          string  `json:"ownerUserId,omitempty"`
	ProjectID            string  `json:"projectId,omitempty"`
	TaskID               string  `json:"taskId,omitempty"`
	WorkerID             string  `json:"workerId,omitempty"`
	WorktreeID           string  `json:"worktreeId,omitempty"`
	ControllerID         string  `json:"controllerId"`
	ControllerInstanceID string  `json:"controllerInstanceId"`
	AgentControlMode     string  `json:"agentControlMode"`
	Provider             string  `json:"provider"`
	NativeSessionID      *string `json:"nativeSessionId"`
}
type Capabilities struct {
	Send    bool `json:"send"`
	Steer   bool `json:"steer"`
	Cancel  bool `json:"cancel"`
	Respond bool `json:"respond"`
}
type Operations struct {
	CanSend    bool `json:"canSend"`
	CanCancel  bool `json:"canCancel"`
	CanRespond bool `json:"canRespond"`
}
type State struct {
	Controls              *Controls    `json:"controls,omitempty"`
	TurnStartedAt         *string      `json:"turnStartedAt,omitempty"`
	CleanupInteractionIDs []string     `json:"cleanupInteractionIds,omitempty"`
	NativeSessionID       *string      `json:"nativeSessionId"`
	InitialInputState     string       `json:"initialInputState"`
	Synchronized          bool         `json:"synchronized"`
	Activity              string       `json:"activity"`
	CurrentTurnID         *string      `json:"currentTurnId"`
	Capabilities          Capabilities `json:"capabilities"`
}
type Snapshot struct {
	Controls              *Controls `json:"controls,omitempty"`
	TurnStartedAt         *string   `json:"turnStartedAt,omitempty"`
	CleanupInteractionIDs []string  `json:"cleanupInteractionIds,omitempty"`
	ControllerFence
	Protocol          string       `json:"protocol"`
	SchemaVersion     int          `json:"schemaVersion"`
	ProjectionVersion int          `json:"projectionVersion"`
	Identity          Identity     `json:"identity"`
	SessionRevision   string       `json:"sessionRevision"`
	HistoryEpoch      string       `json:"historyEpoch"`
	LastEventSeq      string       `json:"lastEventSeq"`
	LastTimelineSeq   string       `json:"lastTimelineSeq"`
	InitialInputState string       `json:"initialInputState"`
	Synchronized      bool         `json:"synchronized"`
	Lifecycle         string       `json:"lifecycle"`
	ConnectionState   string       `json:"connectionState"`
	Activity          string       `json:"activity"`
	CurrentTurnID     *string      `json:"currentTurnId"`
	Capabilities      Capabilities `json:"capabilities"`
	Operations        Operations   `json:"operations"`
}
type OperationError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type Operation struct {
	Fence
	Protocol       string          `json:"protocol"`
	OperationID    string          `json:"operationId"`
	Kind           string          `json:"kind"`
	State          string          `json:"state"`
	ProviderResult *string         `json:"providerResult"`
	Error          *OperationError `json:"error"`
}
type Resource struct {
	ResourceID string  `json:"resourceId"`
	Status     string  `json:"status"`
	Name       string  `json:"name"`
	MediaType  *string `json:"mediaType"`
	ByteLength *string `json:"byteLength"`
	SHA256     *string `json:"sha256"`
	Error      *string `json:"error"`
}

// Data retains the validated union fields, including interaction callbacks.
// MarshalJSON uses the exported identity fields so the server can assign EntrySeq.
type TimelineEntry struct {
	EntryID  string
	EntrySeq string
	Revision string
	Kind     string
	Data     map[string]json.RawMessage
}

func (e TimelineEntry) MarshalJSON() ([]byte, error) {
	fields := make(map[string]json.RawMessage, len(e.Data)+4)
	for key, value := range e.Data {
		fields[key] = value
	}
	for key, value := range map[string]string{"entryId": e.EntryID, "revision": e.Revision, "kind": e.Kind} {
		fields[key], _ = json.Marshal(value)
	}
	if e.EntrySeq != "" {
		fields["entrySeq"], _ = json.Marshal(e.EntrySeq)
	} else {
		delete(fields, "entrySeq")
	}
	return json.Marshal(fields)
}

type SourceEvent struct {
	SourceSeq string          `json:"sourceSeq"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload"`
}
type Reconciliation struct {
	OperationID    string          `json:"operationId"`
	State          string          `json:"state"`
	ProviderResult *string         `json:"providerResult"`
	Error          *OperationError `json:"error"`
}

// ControllerMessage is a decoded inbound union. Only fields belonging to Type
// are populated; Raw preserves the exact validated union for durable hashing.
type ControllerMessage struct {
	ControllerFence
	Type                 string           `json:"type"`
	Protocol             string           `json:"protocol"`
	SchemaVersion        int              `json:"schemaVersion"`
	ProjectionVersion    int              `json:"projectionVersion"`
	ControllerID         string           `json:"controllerId"`
	ControllerInstanceID string           `json:"controllerInstanceId"`
	Provider             string           `json:"provider"`
	SourceEpoch          string           `json:"sourceEpoch"`
	SourceFloor          *string          `json:"sourceFloor,omitempty"`
	State                *State           `json:"state,omitempty"`
	PendingInteractions  []TimelineEntry  `json:"pendingInteractions,omitempty"`
	RequestID            string           `json:"requestId,omitempty"`
	SourceThrough        string           `json:"sourceThrough,omitempty"`
	ContentResult        *ContentResult   `json:"result,omitempty"`
	ContentError         *OperationError  `json:"error,omitempty"`
	LastAckedSourceSeq   string           `json:"lastAckedSourceSeq"`
	BatchID              string           `json:"batchId"`
	Events               []SourceEvent    `json:"events"`
	PreviousSourceEpoch  string           `json:"previousSourceEpoch"`
	NewSourceEpoch       string           `json:"newSourceEpoch"`
	Reason               string           `json:"reason"`
	OperationID          string           `json:"operationId"`
	Operation            *Operation       `json:"operation"`
	Operations           []Reconciliation `json:"operations"`
	Final                bool             `json:"final"`
	Raw                  json.RawMessage  `json:"-"`
}

func (m ControllerMessage) MarshalJSON() ([]byte, error) {
	fields := map[string]any{"type": m.Type, "protocol": m.Protocol, "sessionId": m.SessionID, "claimId": m.ClaimID, "executionGeneration": m.ExecutionGeneration}
	if m.TestExecutionID != "" {
		delete(fields, "claimId")
		fields["testExecutionId"] = m.TestExecutionID
	}
	if m.Type == "hello" {
		fields["schemaVersion"], fields["projectionVersion"] = m.SchemaVersion, m.ProjectionVersion
		fields["controllerId"], fields["controllerInstanceId"], fields["provider"] = m.ControllerID, m.ControllerInstanceID, m.Provider
		fields["sourceEpoch"], fields["lastAckedSourceSeq"] = m.SourceEpoch, m.LastAckedSourceSeq
		if m.SourceFloor != nil {
			fields["sourceFloor"] = *m.SourceFloor
		}
	} else {
		fields["connectionEpoch"] = m.ConnectionEpoch
		switch m.Type {
		case "events":
			fields["batchId"], fields["sourceEpoch"], fields["events"] = m.BatchID, m.SourceEpoch, m.Events
		case "source_reset":
			fields["previousSourceEpoch"], fields["newSourceEpoch"], fields["reason"] = m.PreviousSourceEpoch, m.NewSourceEpoch, m.Reason
		case "operation_begin":
			fields["operationId"] = m.OperationID
		case "operation_receipt":
			fields["operation"] = m.Operation
		case "reconcile":
			fields["operations"] = m.Operations
			fields["final"] = m.Final
		case "content_response":
			fields["requestId"], fields["sourceThrough"], fields["result"], fields["error"] = m.RequestID, m.SourceThrough, m.ContentResult, m.ContentError
		case "sync_state":
			fields["state"], fields["pendingInteractions"] = m.State, m.PendingInteractions
		case "heartbeat":
		default:
			return nil, errInvalid
		}
	}
	return json.Marshal(fields)
}
