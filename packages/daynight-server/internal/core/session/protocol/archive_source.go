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
