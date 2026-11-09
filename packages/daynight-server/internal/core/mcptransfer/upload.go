package mcptransfer

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// UploadData contains durable progress and only proven target-write facts.
type UploadData struct {
	NextOffset   int64             `json:"nextOffset"`
	OperationID  string            `json:"operationId,omitempty"`
	TotalBytes   *int64            `json:"totalBytes,omitempty"`
	SHA256       string            `json:"sha256,omitempty"`
	WriteOutcome string            `json:"writeOutcome,omitempty"`
	Attachment   *model.Attachment `json:"attachment,omitempty"`
	Created      *bool             `json:"created,omitempty"`
}

func DecodeUploadData(r model.PrivateTransfer) (UploadData, error) {
	var data UploadData
	err := json.Unmarshal(r.Data, &data)
	return data, err
}

func EncodeUploadData(data UploadData) json.RawMessage {
	result, _ := json.Marshal(data)
	return result
}

// UploadAdmitted checks ownership for an operation holding its original gate.
// External admission must independently validate current credentials and access.
func UploadAdmitted(r model.PrivateTransfer, a Actor) error {
	if !OwnedBy(r, a) || r.Direction != "upload" {
		return ErrConflict
	}
	return nil
}

func UploadChunkReadable(r model.PrivateTransfer) error {
	if r.State != "receiving" && r.State != "committing" {
		return ErrState
	}
	return nil
}

func UploadReservationAllowed(r model.PrivateTransfer, additional int64, now time.Time) error {
	if additional < 0 || r.State != "receiving" || !Live(r, now) {
		return ErrState
	}
	return nil
}

func UploadStartCommit(r model.PrivateTransfer, data json.RawMessage, now time.Time) (model.PrivateTransfer, error) {
	if r.State != "receiving" || !Live(r, now) || !Canonical(OperationID(data)) {
		return r, ErrState
	}
	lease := now.Add(time.Minute)
	return Transition(r, r.Version, "committing", data, &lease, now)
}

// UploadRenew never revives an expired commit lease or a cleanup barrier.
func UploadRenew(r model.PrivateTransfer, opID string, now time.Time) (model.PrivateTransfer, error) {
	if !Live(r, now) {
		return r, ErrState
	}
	switch r.State {
	case "receiving":
		return Renew(r, now), nil
	case "committing":
		if OperationID(r.Data) != opID || r.LeaseUntil == nil || !now.Before(*r.LeaseUntil) {
			return r, ErrState
		}
		lease := now.Add(time.Minute)
		return Transition(r, r.Version, "committing", r.Data, &lease, now)
	default:
		return r, ErrState
	}
}

func UploadMarkUnknown(r model.PrivateTransfer, opID string, data json.RawMessage) (model.PrivateTransfer, error) {
	if r.State != "committing" || !Canonical(opID) || OperationID(r.Data) != opID || OperationID(data) != opID {
		return r, ErrState
	}
	r.State, r.LeaseUntil, r.Data = "unknown", nil, data
	return r, nil
}

func UploadRequestCleanup(r model.PrivateTransfer, opID string) (model.PrivateTransfer, error) {
	if (r.State != "committed" && r.State != "failed") || !Canonical(opID) || OperationID(r.Data) != opID {
		return r, ErrState
	}
	r.State, r.LeaseUntil = "cleanup_pending", nil
	return r, nil
}

func ValidateUploadChunk(c model.UploadChunk) error {
	_, hashErr := hex.DecodeString(c.SHA256)
	if !Canonical(c.TransferID) || !Canonical(c.ChunkID) || !Canonical(c.ObjectID) || c.Offset < 0 || c.Size < 1 || c.Size > 524288 || c.Offset > math.MaxInt64-c.Size || len(c.SHA256) != 64 || strings.ToLower(c.SHA256) != c.SHA256 || hashErr != nil {
		return &model.Fault{Code: "invalid_input", Message: "Invalid upload chunk receipt."}
	}
	return nil
}

// AcceptUploadChunk advances only a contiguous receipt; its caller persists
// this change, the receipt and reservation consumption in one transaction.
func AcceptUploadChunk(r model.PrivateTransfer, c model.UploadChunk, now time.Time) (model.PrivateTransfer, error) {
	if err := UploadReservationAllowed(r, 0, now); err != nil {
		return r, err
	}
	if err := ValidateUploadChunk(c); err != nil {
		return r, err
	}
	if r.ID != c.TransferID {
		return r, ErrConflict
	}
	data, err := DecodeUploadData(r)
	if err != nil {
		return r, err
	}
	if data.NextOffset != c.Offset {
		return r, ErrState
	}
	data.NextOffset += c.Size
	r.Data = EncodeUploadData(data)
	return Renew(r, now), nil
}
