package model

import "time"

type OwnerKind string

const (
	PersonalOwner OwnerKind = "personal"
	TeamOwner     OwnerKind = "team"
)

type Owner struct {
	Kind OwnerKind `json:"kind"`
	ID   string    `json:"id"`
}

type OwnerAccess struct {
	CanRead   bool
	CanManage bool
}

type Destination struct {
	Kind           string            `json:"kind"`
	AdapterVersion int64             `json:"adapterVersion"`
	Configuration  HTTPConfiguration `json:"configuration"`
}

type HTTPConfiguration struct {
	URL string `json:"url"`
}

type AuthorizationState string

const (
	AuthorizationActive               AuthorizationState = "active"
	AuthorizationConfirmationRequired AuthorizationState = "confirmation_required"
)

type Eligibility string

const (
	Eligible             Eligibility = "eligible"
	AccessRevoked        Eligibility = "access_revoked"
	OwnerScopeChanged    Eligibility = "owner_scope_changed"
	ResourceUnavailable  Eligibility = "resource_unavailable"
	ConfirmationRequired Eligibility = "confirmation_required"
)

type Binding struct {
	ID        string
	EventType string
	DeletedAt *time.Time
}

type Subscription struct {
	ID                 string
	ProjectID          string
	AuthorizationState AuthorizationState
	AuthorizationEpoch int64
	Bindings           []Binding
	DeletedAt          *time.Time
}

type SigningKey struct {
	ID              string
	EncryptedSecret []byte
	CreatedAt       time.Time
	ExpiresAt       *time.Time
	RevokedAt       *time.Time
}

type Endpoint struct {
	ID                   string
	Owner                Owner
	Name                 string
	Enabled              bool
	ConfigVersion        int64
	DestinationRevision  int64
	DestinationKind      string
	AdapterVersion       int64
	DestinationOrigin    string
	EncryptedDestination []byte
	ActiveKeyID          string
	SigningKeys          []SigningKey
	Subscriptions        []Subscription
	CreatedAt            time.Time
	UpdatedAt            time.Time
	DeletedAt            *time.Time
}

type ProjectAccess struct {
	ProjectID   string
	ProjectName *string
	OwnerTeamID string
	Present     bool
	CanRead     bool
}

type OperationKind string

const (
	EndpointCreate OperationKind = "endpoint.create"
	EndpointPatch  OperationKind = "endpoint.patch"
	EndpointDelete OperationKind = "endpoint.delete"
	SecretRotate   OperationKind = "signing-secret.rotate"
)

type OperationEffect string

const (
	EffectApplied   OperationEffect = "applied"
	EffectUnchanged OperationEffect = "unchanged"
)

type OperationReceipt struct {
	OperationID              string
	Kind                     OperationKind
	IssuedAt                 string
	RequestSHA256            string
	Fingerprint              string
	ActorUserID              string
	Owner                    Owner
	EndpointID               string
	Effect                   OperationEffect
	ConfigVersionAfter       int64
	DestinationRevisionAfter int64
	DeliveryID               *string
	GenerationAfter          *int64
	KeyID                    *string
	SigningOverlapUntil      *time.Time
	RecordedAt               time.Time
	ExpiresAt                time.Time
}

type Policy struct {
	Version                        int64     `json:"version"`
	EndpointLimit                  int64     `json:"endpointLimit"`
	SubscriptionsPerEndpoint       int64     `json:"subscriptionsPerEndpoint"`
	BindingsPerSubscription        int64     `json:"bindingsPerSubscription"`
	MatchedEndpointsPerProject     int64     `json:"matchedEndpointsPerProject"`
	StorageBuckets                 int64     `json:"storageBuckets"`
	BucketRecordLimit              int64     `json:"bucketRecordLimit"`
	BucketBytesLimit               int64     `json:"bucketBytesLimit"`
	BucketActiveRecordLimit        int64     `json:"bucketActiveRecordLimit"`
	BucketActiveBytesLimit         int64     `json:"bucketActiveBytesLimit"`
	OwnerRecordLimit               int64     `json:"ownerRecordLimit"`
	OwnerBytesLimit                int64     `json:"ownerBytesLimit"`
	OwnerActiveRecordLimit         int64     `json:"ownerActiveRecordLimit"`
	OwnerActiveBytesLimit          int64     `json:"ownerActiveBytesLimit"`
	OperationOwnerLimit            int64     `json:"operationOwnerLimit"`
	OperationBucketLimit           int64     `json:"operationBucketLimit"`
	OperationBytes                 int64     `json:"operationBytes"`
	OperationRetentionSeconds      int64     `json:"operationRetentionSeconds"`
	OperationMaxAgeSeconds         int64     `json:"operationMaxAgeSeconds"`
	OperationFutureSkewSeconds     int64     `json:"operationFutureSkewSeconds"`
	ConfigurationRequestBytesLimit int64     `json:"configurationRequestBytesLimit"`
	AutomaticAttemptLimit          int64     `json:"automaticAttemptLimit"`
	AutomaticWindowSeconds         int64     `json:"automaticWindowSeconds"`
	AutomaticOffsetsSeconds        [10]int64 `json:"automaticOffsetsSeconds"`
	RetryMinimumWaitSeconds        int64     `json:"retryMinimumWaitSeconds"`
	RetryJitterPercent             int64     `json:"retryJitterPercent"`
	RetryJitterMaximumSeconds      int64     `json:"retryJitterMaximumSeconds"`
	ManualAttemptLimit             int64     `json:"manualAttemptLimit"`
	PayloadWindowSeconds           int64     `json:"payloadWindowSeconds"`
	MetadataRetentionSeconds       int64     `json:"metadataRetentionSeconds"`
	GlobalLeaseLimit               int64     `json:"globalLeaseLimit"`
	OwnerLeaseLimit                int64     `json:"ownerLeaseLimit"`
	EndpointLeaseLimit             int64     `json:"endpointLeaseLimit"`
	WorkersPerProcess              int64     `json:"workersPerProcess"`
	HTTPTimeoutSeconds             int64     `json:"httpTimeoutSeconds"`
	LeaseSeconds                   int64     `json:"leaseSeconds"`
	DBOperationSeconds             int64     `json:"dbOperationSeconds"`
	OwnerActiveQueueLimit          int64     `json:"ownerActiveQueueLimit"`
	EndpointActiveQueueLimit       int64     `json:"endpointActiveQueueLimit"`
	BucketActiveQueueLimit         int64     `json:"bucketActiveQueueLimit"`
	SigningOverlapSeconds          int64     `json:"signingOverlapSeconds"`
	SigningMaximumOverlapSeconds   int64     `json:"signingMaximumOverlapSeconds"`
	SigningKeyLimit                int64     `json:"signingKeyLimit"`
	GCBatchLimit                   int64     `json:"gcBatchLimit"`
	GCWorkSeconds                  int64     `json:"gcWorkSeconds"`
	GCBusyDelaySeconds             int64     `json:"gcBusyDelaySeconds"`
	GCIdleDelaySeconds             int64     `json:"gcIdleDelaySeconds"`
	ConnectTimeoutSeconds          int64     `json:"connectTimeoutSeconds"`
	TLSHandshakeSeconds            int64     `json:"tlsHandshakeSeconds"`
	ResponseHeaderSeconds          int64     `json:"responseHeaderSeconds"`
	HTTPBodyBytesLimit             int64     `json:"httpBodyBytesLimit"`
	HTTPResponseHeaderBytesLimit   int64     `json:"httpResponseHeaderBytesLimit"`
	HTTPClassificationBytesLimit   int64     `json:"httpClassificationBytesLimit"`
	PersistedResponseBytesLimit    int64     `json:"persistedResponseBytesLimit"`
	EventBatchLimit                int64     `json:"eventBatchLimit"`
	EventBytesLimit                int64     `json:"eventBytesLimit"`
	RecordEnvelopeBytes            int64     `json:"recordEnvelopeBytes"`
	DeliveryReservedRecords        int64     `json:"deliveryReservedRecords"`
	NameCharactersLimit            int64     `json:"nameCharactersLimit"`
	QueryCharactersLimit           int64     `json:"queryCharactersLimit"`
	ListDefaultLimit               int64     `json:"listDefaultLimit"`
	ListMaximumLimit               int64     `json:"listMaximumLimit"`
	URLBytesLimit                  int64     `json:"urlBytesLimit"`
}

func DefaultPolicy() Policy {
	return Policy{
		Version: 1, EndpointLimit: 20, SubscriptionsPerEndpoint: 50, BindingsPerSubscription: 6,
		MatchedEndpointsPerProject: 256, StorageBuckets: 16,
		BucketRecordLimit: 65_536, BucketBytesLimit: 256 << 20,
		BucketActiveRecordLimit: 32_768, BucketActiveBytesLimit: 128 << 20,
		OwnerRecordLimit: 32_768, OwnerBytesLimit: 64 << 20,
		OwnerActiveRecordLimit: 24_576, OwnerActiveBytesLimit: 48 << 20,
		OperationOwnerLimit: 1_024, OperationBucketLimit: 8_192, OperationBytes: 4 << 10,
		OperationRetentionSeconds: 30 * 24 * 60 * 60,
		OperationMaxAgeSeconds:    5 * 60, OperationFutureSkewSeconds: 60,
		ConfigurationRequestBytesLimit: 256 << 10,
		AutomaticAttemptLimit:          10, AutomaticWindowSeconds: 72 * 60 * 60,
		AutomaticOffsetsSeconds: [10]int64{0, 60, 5 * 60, 30 * 60, 2 * 60 * 60, 6 * 60 * 60, 12 * 60 * 60, 24 * 60 * 60, 48 * 60 * 60, 71 * 60 * 60},
		RetryMinimumWaitSeconds: 5, RetryJitterPercent: 10, RetryJitterMaximumSeconds: 30 * 60,
		ManualAttemptLimit: 3, PayloadWindowSeconds: 7 * 24 * 60 * 60, MetadataRetentionSeconds: 30 * 24 * 60 * 60,
		GlobalLeaseLimit: 32, OwnerLeaseLimit: 4, EndpointLeaseLimit: 1, WorkersPerProcess: 8,
		HTTPTimeoutSeconds: 15, LeaseSeconds: 45, DBOperationSeconds: 3,
		OwnerActiveQueueLimit: 1_024, EndpointActiveQueueLimit: 256, BucketActiveQueueLimit: 4_096,
		SigningOverlapSeconds: 24 * 60 * 60, SigningMaximumOverlapSeconds: 7 * 24 * 60 * 60, SigningKeyLimit: 2,
		GCBatchLimit: 500, GCWorkSeconds: 2, GCBusyDelaySeconds: 1, GCIdleDelaySeconds: 60,
		ConnectTimeoutSeconds: 5, TLSHandshakeSeconds: 5, ResponseHeaderSeconds: 10,
		HTTPBodyBytesLimit: 64 << 10, HTTPResponseHeaderBytesLimit: 16 << 10, HTTPClassificationBytesLimit: 2 << 10,
		PersistedResponseBytesLimit: 0, EventBatchLimit: 2, EventBytesLimit: 64 << 10,
		RecordEnvelopeBytes: 2 << 10, DeliveryReservedRecords: 63,
		NameCharactersLimit: 120, QueryCharactersLimit: 200, ListDefaultLimit: 50, ListMaximumLimit: 100, URLBytesLimit: 4 << 10,
	}
}
