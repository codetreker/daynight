// Package model contains persisted webhook data shared by the service and DAO.
package model

import "time"

type Owner struct{ Kind, ID string }

type Endpoint struct {
	ID                                      string
	Owner                                   Owner
	Name                                    string
	Enabled                                 bool
	DeletedAt                               *time.Time
	ConfigVersion, DestinationRevision      int64
	DestinationKind, AdapterVersion, Origin string
	DestinationCiphertext                   []byte
	ActiveKeyID                             string
	CreatedAt, UpdatedAt                    time.Time
}

type SigningKey struct {
	EndpointID, ID                 string
	Slot                           string
	Ciphertext                     []byte
	CreatedAt                      time.Time
	OverlapStartedAt, OverlapUntil *time.Time
	RevokedAt                      *time.Time
}

type Operation struct {
	Owner                                                             Owner
	ID, ActorID, Kind, TargetID, IssuedAt, RequestSHA256, Fingerprint string
	Effect                                                            string
	ConfigVersion, DestinationRevisionAfter                           int64
	DeliveryID                                                        string
	GenerationAfter                                                   *int64
	ActiveKeyID, SigningMode                                          string
	OverlapUntil                                                      *time.Time
	RecordedAt, ExpiresAt                                             time.Time
}

// Policy is an immutable, versioned set of delivery and management rules.
type Policy struct {
	Version                                                                      int64
	MaxAutomaticAttempts, MaxManualOperations                                    int16
	AutomaticWindowSeconds                                                       int32
	AutomaticOffsetsSeconds                                                      []int32
	PayloadRetentionSeconds, MetadataRetentionSeconds, OperationRetentionSeconds int32
	OperationMaxAgeSeconds, OperationFutureSkewSeconds                           int32
	HTTPTimeoutSeconds, LeaseSeconds, MinimumFailureWaitSeconds                  int32
	JitterBasisPoints, JitterMaxSeconds                                          int32
	KeyOverlapDefaultSeconds, KeyOverlapMaxSeconds                               int32
}

// Subscription retains a project authorization identity across configuration edits.
type Subscription struct {
	ID, EndpointID, ProjectID string
	Owner                     Owner
	AuthorizationState        string
	AuthorizationEpoch        int64
	CreatedAt, UpdatedAt      time.Time
	DeletedAt                 *time.Time
}

// Binding identifies one continuous selection of an event type.
type Binding struct {
	ID, SubscriptionID, EventType string
	CreatedAt                     time.Time
	DeletedAt                     *time.Time
}
