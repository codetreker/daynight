// Package v2 validates terminal recording contracts without changing the strict
// v1 timeline protocol. Decoding proves shape and integrity; callers authorize
// owners, check current fences and substantiate process and recording evidence.
package v2

import (
	"encoding/json"
	"reflect"
)

// MaxHistoryCursorBytes is the existing encoded Terminal history cursor limit.
const MaxHistoryCursorBytes = 1024

const (
	Protocol                 = "daynight.session.v2"
	ProtocolHeader           = "Daynight-Session-Protocol"
	MaxArchiveBytes          = 64 * 1024 * 1024
	MaxRecordingBytes        = 60 * 1024 * 1024
	MaxMetadataBytes         = 4 * 1024 * 1024
	MaxFrameBytes            = 256 * 1024
	MaxRowBytes              = 16 * 1024
	MaxFrames                = 100000
	MaxSegments              = 1000
	MaxGaps                  = 1000
	MaxRuns                  = 1000
	MaxDimension             = 1000
	MaxTextRuns              = 1000
	SampleIntervalMillis     = 350
	CheckpointIntervalMillis = 5000
)

type Envelope struct {
	Protocol            string `json:"protocol"`
	SchemaVersion       int    `json:"schemaVersion"`
	ProjectionVersion   int    `json:"projectionVersion"`
	Type                string `json:"type"`
	SessionID           string `json:"sessionId"`
	ClaimID             string `json:"claimId"`
	ExecutionGeneration string `json:"executionGeneration"`
	AgentControlMode    string `json:"agentControlMode"`
	ContentKind         string `json:"contentKind"`
}

type Payload interface{ sessionPayload() string }
type Message struct {
	Envelope
	Payload Payload `json:"payload"`
}

// MarshalJSON prevents producers from labeling a typed payload as another
// message variant.
func (message Message) MarshalJSON() ([]byte, error) {
	if message.Payload == nil || reflect.ValueOf(message.Payload).Kind() == reflect.Pointer && reflect.ValueOf(message.Payload).IsNil() || message.Type != message.Payload.sessionPayload() {
		return nil, invalid("invalid_payload")
	}
	type wireMessage Message
	return json.Marshal(wireMessage(message))
}

// NativePaneID preserves the RPC's opaque string or the native layout's uint32.
// Its decoder rejects fractional, negative and out-of-range numeric identities.
type NativePaneID struct {
	Text   *string
	Number *uint32
}

func (id NativePaneID) MarshalJSON() ([]byte, error) {
	if (id.Text == nil) == (id.Number == nil) {
		return nil, invalid("invalid_payload")
	}
	if id.Text != nil {
		return json.Marshal(*id.Text)
	}
	return json.Marshal(*id.Number)
}
func (id *NativePaneID) UnmarshalJSON(data []byte) error {
	value, err := strictJSON(data)
	if err != nil {
		return err
	}
	switch v := value.(type) {
	case string:
		if !native(v) {
			return invalid("invalid_payload")
		}
		id.Text = &v
		id.Number = nil
	case float64:
		if !integer(v, 0, 4294967295) {
			return invalid("invalid_payload")
		}
		n := uint32(v)
		id.Number = &n
		id.Text = nil
	default:
		return invalid("invalid_payload")
	}
	return nil
}

type Binding struct {
	InstanceID      string       `json:"instanceId"`
	SessionID       string       `json:"sessionId"`
	WorkspaceID     string       `json:"workspaceId"`
	PaneID          NativePaneID `json:"paneId"`
	TerminalID      string       `json:"terminalId"`
	NativeSessionID *string      `json:"nativeSessionId"`
}
type Owner struct {
	ProjectID    string `json:"projectId"`
	TaskID       string `json:"taskId"`
	WorkerID     string `json:"workerId"`
	WorktreeID   string `json:"worktreeId"`
	OwnerUserID  string `json:"ownerUserId"`
	ServerOrigin string `json:"serverOrigin"`
	Provider     string `json:"provider"`
}
type Run struct {
	ExecutionGeneration string     `json:"executionGeneration"`
	Owner               Owner      `json:"owner"`
	Binding             Binding    `json:"binding"`
	StartedAt           string     `json:"startedAt"`
	StoppedAt           *string    `json:"stoppedAt"`
	StopProof           *StopProof `json:"stopProof"`
	SegmentIDs          []string   `json:"segmentIds"`
}
type StopProof struct {
	RecordID            string               `json:"recordId"`
	ExecutionGeneration string               `json:"executionGeneration"`
	Binding             Binding              `json:"binding"`
	BootID              string               `json:"bootId"`
	StoppedAt           string               `json:"stoppedAt"`
	Method              string               `json:"method"`
	TerminalStopped     bool                 `json:"terminalStopped"`
	Processes           []ProcessProof       `json:"processes"`
	NativeLaunch        string               `json:"nativeLaunch,omitempty"`
	Daemon              *PreparedDaemonProof `json:"daemon,omitempty"`
}
type PreparedDaemonProof struct {
	PID        int    `json:"pid"`
	BirthToken string `json:"birthToken"`
	BootID     string `json:"bootId"`
}
type ProcessProof struct {
	Role       string `json:"role"`
	PID        int    `json:"pid"`
	BirthToken string `json:"birthToken"`
	BootID     string `json:"bootId"`
}
type StyledText struct {
	Text       string  `json:"text"`
	Foreground *string `json:"foreground"`
	Background *string `json:"background"`
	Bold       bool    `json:"bold"`
	Italic     bool    `json:"italic"`
	Underline  bool    `json:"underline"`
	Inverse    bool    `json:"inverse"`
}
type Frame struct {
	FrameSeq   string         `json:"frameSeq"`
	CapturedAt string         `json:"capturedAt"`
	ElapsedMs  string         `json:"elapsedMs"`
	Width      int            `json:"width"`
	Height     int            `json:"height"`
	Full       bool           `json:"full"`
	Rows       [][]StyledText `json:"rows"`
}
type RecordingResponsibility struct {
	ResponsibilityID string `json:"responsibilityId"`
	RecordingEnabled bool   `json:"recordingEnabled"`
}

// RecordingEvidence identifies a trusted Worker's durable journal and selected
// source. Digests prove byte consistency, not independent observation of its disk.
type RecordingEvidence struct {
	ResponsibilityID     string  `json:"responsibilityId"`
	EvidenceID           string  `json:"evidenceId"`
	Revision             string  `json:"revision"`
	SelectedFrameCount   string  `json:"selectedFrameCount"`
	RegisteredFrameCount string  `json:"registeredFrameCount"`
	CaptureError         *string `json:"captureError"`
	Closed               bool    `json:"closed"`
	JournalSHA256        string  `json:"journalSha256"`
	SourceSHA256         string  `json:"sourceSha256"`
}
type ArchiveStatus struct {
	State          string  `json:"state"`
	SHA256         *string `json:"sha256"`
	ByteLength     *string `json:"byteLength"`
	Completeness   *string `json:"completeness"`
	ErrorCode      *string `json:"errorCode"`
	FinalizationID *string `json:"finalizationId"`
}
type NoRecordingEvidence struct {
	RecordingEnabled     bool    `json:"recordingEnabled"`
	SelectedFrameCount   string  `json:"selectedFrameCount"`
	RegisteredFrameCount string  `json:"registeredFrameCount"`
	CaptureError         *string `json:"captureError"`
}
type Receipt struct {
	FinalizationID    string               `json:"finalizationId"`
	Disposition       string               `json:"disposition"`
	DispositionDigest string               `json:"dispositionDigest"`
	Reason            *string              `json:"reason"`
	SHA256            *string              `json:"sha256"`
	ByteLength        *string              `json:"byteLength"`
	Completeness      *string              `json:"completeness"`
	Evidence          *NoRecordingEvidence `json:"evidence"`
}

func (ArchiveStatus) sessionPayload() string { return "archive_status" }

type RecordingPolicy struct {
	SampleIntervalMs     int `json:"sampleIntervalMs"`
	CheckpointIntervalMs int `json:"checkpointIntervalMs"`
}
type Segment struct {
	SegmentID           string  `json:"segmentId"`
	SegmentOrdinal      string  `json:"segmentOrdinal"`
	ExecutionGeneration string  `json:"executionGeneration"`
	Binding             Binding `json:"binding"`
	StartedAt           string  `json:"startedAt"`
	EndedAt             string  `json:"endedAt"`
	DurationMs          string  `json:"durationMs"`
}
type FrameFile struct {
	FileID     string `json:"fileId"`
	SegmentID  string `json:"segmentId"`
	FrameSeq   string `json:"frameSeq"`
	SHA256     string `json:"sha256"`
	ByteLength string `json:"byteLength"`
	Data       string `json:"data"`
}
type FrameIndex struct {
	SegmentID      string `json:"segmentId"`
	FrameSeq       string `json:"frameSeq"`
	FileID         string `json:"fileId"`
	FirstElapsedMs string `json:"firstElapsedMs"`
	LastElapsedMs  string `json:"lastElapsedMs"`
}
type IntervalGap struct {
	SegmentID      string  `json:"segmentId"`
	Reason         string  `json:"reason"`
	StartElapsedMs string  `json:"startElapsedMs"`
	EndElapsedMs   *string `json:"endElapsedMs"`
}
type BoundaryEndpoint struct {
	ExecutionGeneration string  `json:"executionGeneration"`
	SegmentID           *string `json:"segmentId"`
}
type BoundaryGap struct {
	Kind   string           `json:"kind"`
	Reason string           `json:"reason"`
	From   BoundaryEndpoint `json:"from"`
	To     BoundaryEndpoint `json:"to"`
}

// Gap is an explicit union; interval gaps and restart boundaries have different
// ordering and overlap rules and cannot be substituted for one another.
type Gap struct {
	Interval *IntervalGap
	Boundary *BoundaryGap
}

func (gap Gap) MarshalJSON() ([]byte, error) {
	if (gap.Interval == nil) == (gap.Boundary == nil) {
		return nil, invalid("invalid_payload")
	}
	if gap.Interval != nil {
		return json.Marshal(gap.Interval)
	}
	return json.Marshal(gap.Boundary)
}
func (gap *Gap) UnmarshalJSON(data []byte) error {
	value, err := strictJSON(data)
	if err != nil {
		return err
	}
	if !validGap(value) {
		return invalid("invalid_payload")
	}
	if mapAt(value)["kind"] == "boundary" {
		var boundary BoundaryGap
		boundary, err = decodeValue[BoundaryGap](value)
		gap.Boundary = &boundary
		gap.Interval = nil
	} else {
		var interval IntervalGap
		interval, err = decodeValue[IntervalGap](value)
		gap.Interval = &interval
		gap.Boundary = nil
	}
	return err
}

type UnavailableRun struct {
	ExecutionGeneration string              `json:"executionGeneration"`
	Reason              string              `json:"reason"`
	Evidence            NoRecordingEvidence `json:"evidence"`
}

type Archive struct {
	SchemaVersion       int              `json:"schemaVersion"`
	ProjectionVersion   int              `json:"projectionVersion"`
	ContentKind         string           `json:"contentKind"`
	AgentControlMode    string           `json:"agentControlMode"`
	SessionID           string           `json:"sessionId"`
	ClaimID             string           `json:"claimId"`
	ExecutionGeneration string           `json:"executionGeneration"`
	Owner               Owner            `json:"owner"`
	FinalizationID      string           `json:"finalizationId"`
	StartedAt           string           `json:"startedAt"`
	EndedAt             string           `json:"endedAt"`
	Completeness        string           `json:"completeness"`
	Policy              RecordingPolicy  `json:"policy"`
	Runs                []Run            `json:"runs"`
	Segments            []Segment        `json:"segments"`
	Files               []FrameFile      `json:"files"`
	Index               []FrameIndex     `json:"index"`
	Gaps                []Gap            `json:"gaps"`
	UnavailableRuns     []UnavailableRun `json:"unavailableRuns"`
}
