package model

import (
	"time"
)

// UsageMetrics contains exact decimal strings; nil is not a known zero.
type UsageMetrics struct {
	Input         *string `json:"inputTokens"`
	Output        *string `json:"outputTokens"`
	CacheRead     *string `json:"cacheReadTokens"`
	CacheWrite    *string `json:"cacheWriteTokens"`
	Reasoning     *string `json:"reasoningTokens"`
	Total         *string `json:"totalTokens"`
	ProviderTotal *string `json:"providerTotalTokens"`
}

type UsageCapability struct {
	ProfileID         string            `json:"profileId"`
	Qualification     string            `json:"qualification"`
	MeasurementPlane  string            `json:"measurementPlane"`
	RevisionAuthority string            `json:"revisionAuthority"`
	Metrics           map[string]string `json:"metrics"`
	Subagents         string            `json:"subagents"`
	Recovery          string            `json:"recovery"`
	Completion        string            `json:"completion"`
}

type UsageRecord struct {
	ID                       string           `json:"id"`
	Kind                     string           `json:"recordKind"`
	Scope                    string           `json:"scope"`
	ProjectID                *string          `json:"projectId"`
	TaskID                   *string          `json:"taskId"`
	TestExecutionID          *string          `json:"testExecutionId"`
	SessionID                string           `json:"sessionId"`
	ClaimID                  *string          `json:"claimId"`
	Generation               string           `json:"executionGeneration"`
	WorkerID                 *string          `json:"workerId"`
	AuthorityUserID          string           `json:"nativeAuthorityUserId"`
	Provider                 string           `json:"provider"`
	NativeSessionID          string           `json:"nativeSessionId"`
	StateID                  *string          `json:"stateId"`
	AnchorStateID            *string          `json:"anchorStateId"`
	RegistrationID           *string          `json:"registrationId,omitempty"`
	SourceKey                *string          `json:"sourceKey,omitempty"`
	NativeTurnID             *string          `json:"nativeTurnId,omitempty"`
	NativeCallID             *string          `json:"nativeCallId,omitempty"`
	Model                    *string          `json:"model,omitempty"`
	ProfileID                string           `json:"profileId"`
	ProviderVersion          string           `json:"providerVersion"`
	RevisionAuthority        *string          `json:"revisionAuthority,omitempty"`
	SourceRevision           *string          `json:"sourceRevision,omitempty"`
	Finality                 *string          `json:"finality,omitempty"`
	Disposition              *string          `json:"disposition,omitempty"`
	AggregationRole          *string          `json:"aggregationRole,omitempty"`
	IncludedInSourceKey      *string          `json:"includedInSourceKey,omitempty"`
	Metrics                  UsageMetrics     `json:"metrics"`
	NativeMetrics            map[string]any   `json:"nativeMetrics,omitempty"`
	Capability               *UsageCapability `json:"capability,omitempty"`
	CollectionState          *string          `json:"collectionState,omitempty"`
	EffectiveCollectionState *string          `json:"effectiveCollectionState,omitempty"`
	ReasonCodes              []string         `json:"reasonCodes"`
	StateSequence            *string          `json:"stateSequence,omitempty"`
	GrantHash                []byte           `json:"-"`
	ParentCredentialID       *string          `json:"-"`
	GrantExpiresAt           *time.Time       `json:"grantExpiresAt,omitempty"`
	GrantRevokedAt           *time.Time       `json:"grantRevokedAt,omitempty"`
	SealedAt                 *time.Time       `json:"sealedAt,omitempty"`
	NativeStartedAt          *string          `json:"nativeStartedAt,omitempty"`
	NativeEndedAt            *string          `json:"nativeEndedAt,omitempty"`
	ObservedAt               time.Time        `json:"observedAt"`
	CreatedAt                time.Time        `json:"createdAt"`
	UpdatedAt                time.Time        `json:"updatedAt"`
	RowVersion               string           `json:"rowVersion"`
	BodyHash                 string           `json:"bodyHash"`
}

type UsageMetricSummary struct {
	Known               *string `json:"known"`
	ContributingRecords string  `json:"contributingRecords"`
	UnknownRecords      string  `json:"unknownRecords"`
}

type UsageCoverage struct {
	Executions   string `json:"executions"`
	Supported    string `json:"supportedExecutions"`
	Collecting   string `json:"collectingExecutions"`
	Complete     string `json:"completeExecutions"`
	Partial      string `json:"partialExecutions"`
	Unsupported  string `json:"unsupportedExecutions"`
	Unavailable  string `json:"unavailableExecutions"`
	Unregistered string `json:"unregisteredExecutions"`
}

type UsageSummary struct {
	Metrics            map[string]UsageMetricSummary `json:"metrics"`
	Scope              string                        `json:"scope"`
	Completeness       string                        `json:"completeness"`
	ReasonCodes        []string                      `json:"reasonCodes"`
	Coverage           UsageCoverage                 `json:"coverage"`
	MeasurementRecords string                        `json:"measurementRecords"`
	LastMeasuredAt     *time.Time                    `json:"lastMeasuredAt"`
	ObservedAt         time.Time                     `json:"observedAt"`
	ETag               string                        `json:"etag"`
}

type UsageEvent struct {
	EventID             string           `json:"eventId"`
	Kind                string           `json:"kind"`
	OriginatingStateID  string           `json:"originatingStateId,omitempty"`
	SourceKey           string           `json:"sourceKey,omitempty"`
	NativeTurnID        *string          `json:"nativeTurnId"`
	NativeCallID        *string          `json:"nativeCallId"`
	Model               *string          `json:"model"`
	ProfileID           string           `json:"profileId,omitempty"`
	RevisionAuthority   string           `json:"revisionAuthority,omitempty"`
	SourceRevision      string           `json:"sourceRevision,omitempty"`
	Finality            string           `json:"finality,omitempty"`
	Disposition         string           `json:"disposition,omitempty"`
	AggregationRole     string           `json:"aggregationRole,omitempty"`
	IncludedInSourceKey *string          `json:"includedInSourceKey"`
	Metrics             UsageMetrics     `json:"metrics"`
	NativeMetrics       map[string]any   `json:"nativeMetrics"`
	ReasonCodes         []string         `json:"reasonCodes"`
	ObservedAt          string           `json:"observedAt"`
	StateSequence       string           `json:"stateSequence,omitempty"`
	CollectionState     string           `json:"collectionState,omitempty"`
	Capability          *UsageCapability `json:"capability"`
	NativeStartedAt     *string          `json:"nativeStartedAt"`
	NativeEndedAt       *string          `json:"nativeEndedAt"`
	Seal                bool             `json:"seal,omitempty"`
}

// UsageFault carries safe conflict metadata independently of HTTP status codes.
type UsageFault struct {
	Code                string  `json:"code"`
	EventID             string  `json:"eventId,omitempty"`
	SourceKey           string  `json:"sourceKey,omitempty"`
	CurrentRevision     *string `json:"currentRevision,omitempty"`
	CurrentBodyHash     string  `json:"currentBodyHash,omitempty"`
	DiagnosticCommitted bool    `json:"diagnosticCommitted,omitempty"`
	RowVersion          string  `json:"rowVersion,omitempty"`
}

func (e *UsageFault) Error() string { return e.Code }
