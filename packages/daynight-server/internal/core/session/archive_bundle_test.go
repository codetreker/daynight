package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestArchiveLedgerRequiresCompleteContentAtExactSourceBarrier(t *testing.T) {
	entry := localEntry(t, "1")
	history := sp.ArchiveHistoryContent{HistoryEpoch: "history", SourceThrough: "7", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}}
	ledger, err := makeArchiveLedger(history, "history", 7)
	if err != nil {
		t.Fatal(err)
	}
	if err = verifyArchiveLedger(ledger, sp.ArchiveTimeline{Entries: history.Entries}); err != nil {
		t.Fatal(err)
	}
	history.SourceThrough = "8"
	if _, err = makeArchiveLedger(history, "history", 7); err == nil {
		t.Fatal("unacknowledged source accepted")
	}
	history.SourceThrough = "7"
	history.HistoryEpoch = "replacement"
	if _, err = makeArchiveLedger(history, "history", 7); err == nil {
		t.Fatal("replacement history accepted")
	}
	changed := entry
	changed.Revision = "2"
	if err = verifyArchiveLedger(ledger, sp.ArchiveTimeline{Entries: []sp.TimelineEntry{changed}}); err == nil {
		t.Fatal("different timeline accepted at same length")
	}
}

func TestArchiveChunkChecksExactBoundaryAndDurableBytes(t *testing.T) {
	f, _, _ := archiveFixture(t)
	ctx := context.Background()
	path := "tests/archive-chunk"
	original := []byte("original")
	sum := sha256.Sum256(original)
	if err := putArchiveChunk(ctx, f.s.files, path, original, hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
	if err := putArchiveChunk(ctx, f.s.files, path, original, hex.EncodeToString(sum[:])); err != nil {
		t.Fatal("same retry", err)
	}
	if err := verifyArchiveChunk(ctx, f.s.files, path, []byte("changed!")); err == nil {
		t.Fatal("different retry accepted")
	}
	if err := putArchiveChunk(ctx, f.s.files, path, original, "0000000000000000000000000000000000000000000000000000000000000000"); err == nil {
		t.Fatal("invalid chunk hash accepted")
	}
}
