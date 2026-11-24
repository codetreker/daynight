package session

import (
	"bytes"
	"crypto/sha256"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func recoveryFixture(t *testing.T) (imageRuleFixture, *sourceCheckpointDAO, sp.ArchiveSourceRecoveryRequest) {
	f, d, tail := stoppedCheckpointFixture(t)
	return f, d, sp.ArchiveSourceRecoveryRequest{Fence: tail.Fence, ControllerID: tail.ControllerID, ControllerInstanceID: tail.ControllerInstanceID, SourceEpoch: tail.SourceEpoch, OldBatchID: tail.BatchID, RecoveryID: uuid.NewString(), Cutoff: "4", Events: tail.Events}
}
func TestSourceRecoveryPersistsReceiptAndLimitsAcknowledgement(t *testing.T) {
	f, d, in := recoveryFixture(t)
	tx := &operationTx{dao: d}
	// The first event was already acknowledged, while the second was lost.
	hash := sha256.Sum256(encode(in.Events[0]))
	d.hashes[d.key(store.SessionSourceHash{SessionID: f.r.Snapshot.SessionID, SourceEpoch: in.SourceEpoch, Kind: "event", Identity: "1"})] = hash[:]
	f.r.SourceSeq = 1
	receipt, err := f.s.applyStoppedSourceRecovery(t.Context(), tx, f.r, in)
	if err != nil || receipt.VerifiedThrough != "2" || receipt.CurrentThrough != "2" {
		t.Fatalf("recovery: %#v %v", receipt, err)
	}
	// A replay can observe later progress but cannot claim to have checked it.
	f.r.SourceSeq = 4
	receipt, err = f.s.applyStoppedSourceRecovery(t.Context(), tx, f.r, in)
	if err != nil || receipt.VerifiedThrough != "2" || receipt.CurrentThrough != "4" {
		t.Fatalf("replay: %#v %v", receipt, err)
	}
	f.r.SourceSeq = 5
	if _, err = f.s.applyStoppedSourceRecovery(t.Context(), tx, f.r, in); err == nil {
		t.Fatal("replay passed cutoff")
	}
	f.r.SourceSeq = 2
	changed := in
	changed.OldBatchID = uuid.NewString()
	if _, err = f.s.applyStoppedSourceRecovery(t.Context(), tx, f.r, changed); err == nil {
		t.Fatal("recovery ID accepted different pending batch")
	}
}
func TestSourceRecoveryRejectsOldBatchOrUnverifiableEvents(t *testing.T) {
	for _, scenario := range []string{"old batch", "missing hash", "different hash", "gap", "event above cutoff", "wrong epoch"} {
		t.Run(scenario, func(t *testing.T) {
			f, d, in := recoveryFixture(t)
			switch scenario {
			case "old batch":
				d.hashes[d.key(store.SessionSourceHash{SessionID: f.r.Snapshot.SessionID, SourceEpoch: in.SourceEpoch, Kind: "batch", Identity: in.OldBatchID})] = bytes.Repeat([]byte{1}, 32)
			case "missing hash":
				f.r.SourceSeq = 1
			case "different hash":
				f.r.SourceSeq = 1
				d.hashes[d.key(store.SessionSourceHash{SessionID: f.r.Snapshot.SessionID, SourceEpoch: in.SourceEpoch, Kind: "event", Identity: "1"})] = bytes.Repeat([]byte{2}, 32)
			case "gap":
				in.Events = in.Events[1:]
			case "event above cutoff":
				in.Cutoff = "1"
			case "wrong epoch":
				in.SourceEpoch = uuid.NewString()
			}
			if _, err := f.s.applyStoppedSourceRecovery(t.Context(), &operationTx{dao: d}, f.r, in); err == nil {
				t.Fatal("unsafe recovery succeeded")
			}
			if len(d.recoveries) != 0 {
				t.Fatal("refusal persisted recovery")
			}
		})
	}
}
