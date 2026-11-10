package session

import (
	"encoding/json"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

// Positions retain only the source identity needed to authorize image capture.
// Provider locators and their native identity remain in the capture journal.
type archiveLedgerOccurrence struct {
	EntryID          string  `json:"e"`
	ImageID          string  `json:"i"`
	Container        string  `json:"c"`
	PartID           *string `json:"p"`
	SourceRevision   *string `json:"r"`
	SourceTextSHA256 *string `json:"h"`
	CallIDSHA256     *string `json:"k"`
}

func archiveCallIDSHA256(callID *string) *string {
	if callID == nil {
		return nil
	}
	digest := archiveDigest([]byte(*callID))
	return &digest
}

func archiveHistoryOccurrences(entries []sp.TimelineEntry) ([]archiveLedgerOccurrence, error) {
	out := []archiveLedgerOccurrence{}
	ids := map[string]bool{}
	appendOccurrence := func(position archiveLedgerOccurrence) error {
		if ids[position.ImageID] || len(out) >= maxArchiveHistoryOccurrences {
			return archiveConflict()
		}
		ids[position.ImageID] = true
		out = append(out, position)
		return nil
	}
	for _, entry := range entries {
		container := "content"
		var callID *string
		if entry.Kind == "tool_call" {
			container = "tool_output"
			if err := json.Unmarshal(entry.Data["callId"], &callID); err != nil {
				return nil, err
			}
		}
		var markdown func(json.RawMessage) error
		markdown = func(raw json.RawMessage) error {
			var part struct {
				PartID, Revision, TextSHA256 string
				Bindings, RetainedImages     []json.RawMessage
			}
			if err := json.Unmarshal(raw, &part); err != nil {
				return err
			}
			for group, bindings := range [][]json.RawMessage{part.Bindings, part.RetainedImages} {
				for _, rawBinding := range bindings {
					var binding struct{ ImageID, SourceRevision, SourceTextSHA256 string }
					if err := json.Unmarshal(rawBinding, &binding); err != nil {
						return err
					}
					revision, digest := part.Revision, part.TextSHA256
					if group == 1 {
						revision, digest = binding.SourceRevision, binding.SourceTextSHA256
					}
					partID := part.PartID
					if err := appendOccurrence(archiveLedgerOccurrence{EntryID: entry.EntryID, ImageID: binding.ImageID, Container: container, PartID: &partID, SourceRevision: &revision, SourceTextSHA256: &digest, CallIDSHA256: archiveCallIDSHA256(callID)}); err != nil {
						return err
					}
				}
			}
			return nil
		}
		if entry.Kind == "reasoning" {
			container = "reasoning"
			if raw := entry.Data["markdown"]; len(raw) != 0 {
				if err := markdown(raw); err != nil {
					return nil, err
				}
			}
			continue
		}
		name := "content"
		if container == "tool_output" {
			name = "output"
		}
		var parts []json.RawMessage
		if raw := entry.Data[name]; len(raw) != 0 {
			if err := json.Unmarshal(raw, &parts); err != nil {
				return nil, err
			}
		}
		for _, raw := range parts {
			var part struct{ Type, ImageID string }
			if err := json.Unmarshal(raw, &part); err != nil {
				return nil, err
			}
			switch part.Type {
			case "image", "image_unavailable":
				if err := appendOccurrence(archiveLedgerOccurrence{EntryID: entry.EntryID, ImageID: part.ImageID, Container: container, CallIDSHA256: archiveCallIDSHA256(callID)}); err != nil {
					return nil, err
				}
			case "markdown":
				if err := markdown(raw); err != nil {
					return nil, err
				}
			}
		}
	}
	return out, nil
}
