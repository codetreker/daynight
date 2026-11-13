package store

import (
	"context"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

// SessionResourceRecord binds one immutable descriptor to its durable blob.
// MigrationID preserves the original conversion identity until verified readback.
type SessionResourceRecord struct {
	GCPending bool
	// HasInlineContent reports legacy column presence without loading its bytes.
	HasInlineContent              bool
	SessionID                     string
	Resource                      sp.Resource
	BlobID, BlobPath, MigrationID string
}
type SessionResourceReference struct{ SessionID, ResourceID, Kind, ReferenceID string }
type SessionUploadRecord struct {
	StorageReleased            bool
	SessionID, ActorID, BlobID string
	Spec                       sp.ImageUploadSpec
	Receipt                    sp.ImageUploadReceipt
	ExpiresAt                  time.Time
}
type SessionUploadChunk struct {
	SessionID, UploadID, Path, SHA256 string
	Offset, ByteLength                int64
}
type SessionCaptureRecord struct {
	Expected  *SessionCaptureState
	Validated *sp.ValidatedImage
	SessionID string
	Request   sp.ImageCaptureRequest
	Receipt   sp.ImageCaptureReceipt
}

// SessionCaptureState is an observed write precondition, never persisted data.
// A nil Expected requires absence; updates compare the original request and state.
type SessionCaptureState struct {
	Receipt   sp.ImageCaptureReceipt
	Validated *sp.ValidatedImage
}
type SessionResourceUsage struct {
	Frozen      bool
	Bytes       int64
	Resources   int
	DeleteEpoch int64
	Deleting    bool
}

// SessionResourceLeaseAdmission contains caller-decided occupancy upper bounds.
// Acquisition checks all three against actual counts under the deployment gate.
// Zero bounds refuse admission; they never disable a capacity check.
type SessionResourceLeaseAdmission struct {
	Global, Owner, Session int
}

type SessionResourceLease struct {
	Admission                                SessionResourceLeaseAdmission
	SessionID, ID, Kind, OwnerID, ResourceID string
	DeleteEpoch                              int64
}

// SessionResourceDAO is an optional, transaction-bound capability. Old adapters
// cannot claim media support by silently implementing successful empty methods.
// Callers hold the authorized Session lock before all methods, except admission
// which also serializes the shared account/deployment counters.
type SessionResourceDAO interface {
	SavedSessionResource(context.Context, string, string) (SessionResourceRecord, error)
	SessionResourceReadableBy(context.Context, string, string, string) (bool, error)
	ListSessionResources(context.Context, string) ([]SessionResourceRecord, error)
	InsertSessionResource(context.Context, SessionResourceRecord) error
	AddSessionResourceReference(context.Context, SessionResourceReference) error
	RemoveSessionResourceReference(context.Context, SessionResourceReference) error
	SessionResourceReferenceCount(context.Context, string, string) (int, error)
	SessionResourceReferenceExists(context.Context, SessionResourceReference) (bool, error)
	SessionResourceUsage(context.Context, string) (SessionResourceUsage, error)
	SessionUpload(context.Context, string, string) (SessionUploadRecord, error)
	SessionImageUploadExists(context.Context, string, string) (bool, error)
	SaveSessionUpload(context.Context, SessionUploadRecord) error
	SessionUploadChunks(context.Context, string, string) ([]SessionUploadChunk, error)
	InsertSessionUploadChunk(context.Context, SessionUploadChunk) error
	SessionCapture(context.Context, string, string) (SessionCaptureRecord, error)
	SessionCaptureByImage(context.Context, string, string) (SessionCaptureRecord, error)
	SaveSessionCapture(context.Context, SessionCaptureRecord) error
	AcquireSessionResourceLease(context.Context, SessionResourceLease) error
	ReleaseSessionResourceLease(context.Context, string, string) error
	BeginSessionResourceDeletion(context.Context, string) (int64, error)
	SessionResourceLeaseCount(context.Context, string) (int, error)
	ListSessionResourceLeases(context.Context, string) ([]SessionResourceLease, error)
	UnsettledSessionResourceWrites(context.Context, string) (int, error)
}

// SessionIntentDAO stores complete bytes for new operations without rewriting
// historical command summaries or their original body hashes.
type SessionIntentDAO interface {
	SessionOperationIntent(context.Context, string, string) ([]byte, error)
	InsertSessionOperationIntent(context.Context, string, string, []byte) error
}

type SessionMediaRequest struct {
	Expected                     *SessionMediaState
	SessionID, RequestID, Action string
	Fence                        sp.ControllerFence
	Body, Result                 []byte
	Error                        *sp.ImageError
	Complete                     bool
}

// SessionMediaState is the exact observed precondition for an intentional
// representation rewrite. It is never persisted as part of the receipt.
type SessionMediaState struct {
	Fence        sp.ControllerFence
	Body, Result []byte
	Error        *sp.ImageError
	Complete     bool
}

type SessionUploadMediaDAO interface {
	SessionUploadMediaRequests(context.Context, string, string, string) ([]SessionMediaRequest, error)
}
type SessionMediaDAO interface {
	SessionMediaRequest(context.Context, string, string) (SessionMediaRequest, error)
	SaveSessionMediaRequest(context.Context, SessionMediaRequest) error
	// PendingSessionMediaRequests filters the exact execution fence before the
	// offer limit. Connection epochs remain eligible for same-generation rebind.
	PendingSessionMediaRequests(context.Context, sp.Fence) ([]SessionMediaRequest, error)
}
