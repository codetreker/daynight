package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const sourceHashWindow int64 = 2048
const maxSourceHashes = 8192

// saveSourceHash runs under the authorized Session lock. Original replays are
// checked before retention changes; a missing old ACK is never reconstructed
// from the source checkpoint. Store preserves immutable identity at insertion.
func saveSourceHash(ctx context.Context, dao store.SessionSourceDAO, h store.SessionSourceHash) error {
	if (h.Kind != "event" && h.Kind != "batch") || h.Through < 0 || len(h.Identity) < 1 || len(h.Identity) > 36 || len(h.Digest) != sha256.Size {
		return fault("invalid_input", "Invalid original source acknowledgement.")
	}
	if previous, err := dao.SessionSourceHash(ctx, h); err == nil {
		if !bytes.Equal(previous, h.Digest) {
			return fault("resource_conflict", "The original source identity already has different content.")
		}
		return nil
	} else if !errors.Is(err, model.ErrNotFound) {
		return err
	}
	// Fixed identity/digest records keep at most 8192 rows, under 1 MiB of
	// logical metadata, retaining the current epoch's original 2048-sequence window.
	if err := dao.PruneSessionSourceHashes(ctx, h.SessionID, h.SourceEpoch, h.Through-sourceHashWindow); err != nil {
		return err
	}
	count, err := dao.SessionSourceHashCount(ctx, h.SessionID)
	if err != nil {
		return err
	}
	if count < 0 {
		return fault("source_corrupt", "The source acknowledgement count is invalid.")
	}
	if count >= maxSourceHashes {
		return fault("quota_exceeded", "The original source acknowledgement ledger is full.")
	}
	return dao.SaveSessionSourceHash(ctx, h)
}
