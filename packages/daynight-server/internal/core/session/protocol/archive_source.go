package sessionprotocol

import "encoding/json"

const MaxArchiveSourceTailBytes = MaxFrameBytes

func DecodeHistoryControllerFence(data []byte) (ControllerFence, error) {
	return decode[ControllerFence](data, nested(extend(fenceSchema, schema{"connectionEpoch": sequence})))
}

type ArchiveSourceTailRequest struct {
	Fence                Fence         `json:"fence"`
	ControllerID         string        `json:"controllerId"`
	ControllerInstanceID string        `json:"controllerInstanceId"`
	SourceEpoch          string        `json:"sourceEpoch"`
	BatchID              string        `json:"batchId"`
	Events               []SourceEvent `json:"events"`
}
type ArchiveSourceTailReceipt struct {
	SourceEpoch        string `json:"sourceEpoch"`
	BatchID            string `json:"batchId"`
	LastAckedSourceSeq string `json:"lastAckedSourceSeq"`
}

func DecodeArchiveSourceTail(data []byte) (ArchiveSourceTailRequest, error) {
	if len(data) < 1 || len(data) > MaxArchiveSourceTailBytes || !validUnicode(data) {
		return ArchiveSourceTailRequest{}, errInvalid
	}
	return decode[ArchiveSourceTailRequest](data, nested(schema{
		"fence": nested(fenceSchema), "controllerId": identifier, "controllerInstanceId": identifier, "sourceEpoch": identifier, "batchId": identifier,
		"events": many(func(raw json.RawMessage) bool {
			event, err := DecodeSourceEvent(raw)
			return err == nil && event.Kind != "gap"
		}, 1, MaxBatchEvents, "sourceSeq"),
	}))
}

// ArchiveSourceRecoveryRequest binds one durable recovery segment to its old
// pending batch and frozen local source boundary.
type ArchiveSourceRecoveryRequest struct {
	Fence                Fence         `json:"fence"`
	ControllerID         string        `json:"controllerId"`
	ControllerInstanceID string        `json:"controllerInstanceId"`
	SourceEpoch          string        `json:"sourceEpoch"`
	OldBatchID           string        `json:"oldBatchId"`
	RecoveryID           string        `json:"recoveryId"`
	Cutoff               string        `json:"cutoff"`
	Events               []SourceEvent `json:"events"`
}
type ArchiveSourceRecoveryReceipt struct {
	SourceEpoch     string `json:"sourceEpoch"`
	RecoveryID      string `json:"recoveryId"`
	VerifiedThrough string `json:"verifiedThrough"`
	CurrentThrough  string `json:"currentThrough"`
}

func DecodeArchiveSourceRecovery(data []byte) (ArchiveSourceRecoveryRequest, error) {
	if len(data) < 1 || len(data) > MaxArchiveSourceTailBytes || !validUnicode(data) {
		return ArchiveSourceRecoveryRequest{}, errInvalid
	}
	in, err := decode[ArchiveSourceRecoveryRequest](data, nested(schema{
		"fence": nested(fenceSchema), "controllerId": identifier, "controllerInstanceId": identifier, "sourceEpoch": identifier,
		"oldBatchId": identifier, "recoveryId": identifier, "cutoff": sequence,
		"events": many(func(raw json.RawMessage) bool {
			event, err := DecodeSourceEvent(raw)
			return err == nil && event.Kind != "gap"
		}, 1, MaxBatchEvents, "sourceSeq"),
	}))
	if err != nil || in.OldBatchID == in.RecoveryID {
		return ArchiveSourceRecoveryRequest{}, errInvalid
	}
	return in, nil
}

// Archive requests reach the core as decoded values. Re-encoding them with
// encoding/json's HTML and JavaScript separator escapes can make a valid HTTP
// frame appear larger than its original wire bytes. Validate a compact,
// equivalent JSON representation while the HTTP adapter enforces the actual
// received byte limit. This representation is never used for durable hashes.
func archiveSourceValidationWire(value any) ([]byte, error) {
	wire, err := MarshalWire(value)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(wire))
	for i := 0; i < len(wire); {
		if wire[i] == '\\' && i+1 < len(wire) {
			if wire[i+1] == '\\' {
				out = append(out, wire[i:i+2]...)
				i += 2
				continue
			}
			if i+6 <= len(wire) && string(wire[i:i+6]) == `\u2028` {
				out = append(out, 0xe2, 0x80, 0xa8)
				i += 6
				continue
			}
			if i+6 <= len(wire) && string(wire[i:i+6]) == `\u2029` {
				out = append(out, 0xe2, 0x80, 0xa9)
				i += 6
				continue
			}
			out = append(out, wire[i:i+2]...)
			i += 2
			continue
		}
		out = append(out, wire[i])
		i++
	}
	return out, nil
}

func ValidateArchiveSourceTail(in ArchiveSourceTailRequest) error {
	wire, err := archiveSourceValidationWire(in)
	if err != nil {
		return err
	}
	_, err = DecodeArchiveSourceTail(wire)
	return err
}
func ValidateArchiveSourceRecovery(in ArchiveSourceRecoveryRequest) error {
	wire, err := archiveSourceValidationWire(in)
	if err != nil {
		return err
	}
	_, err = DecodeArchiveSourceRecovery(wire)
	return err
}
