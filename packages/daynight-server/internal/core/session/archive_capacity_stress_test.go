//go:build stress

package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/jackc/pgx/v5"
)

// Run separately from routine CI: this exercises all three declared counts at
// the exact timeline byte boundary and measures PostgreSQL's stored metadata.
func TestArchiveMaximumLegalMetadataCapacity(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	const count = 100000
	id := func(kind, index int) string { return fmt.Sprintf("%08x-0000-4000-8000-%012x", kind, index+1) }
	resources := make([]sp.Resource, 1000)
	length, digest, mime := "1", strings.Repeat("a", 64), "image/png"
	dimension := 1
	for i := range resources {
		resources[i] = sp.Resource{Revision: "1", ResourceID: id(3, i), Status: "available", Name: "saved image", MediaType: &mime, ByteLength: &length, SHA256: &digest, Width: &dimension, Height: &dimension, FrameCount: &dimension}
	}
	entryBytes := func(i, padding int) []byte {
		text := strings.Repeat("x", padding+1)
		hash := archiveDigest([]byte(text))
		return []byte(fmt.Sprintf(`{"entryId":"%s","entrySeq":"%d","revision":"9223372036854775807","kind":"reasoning","text":"%s","imageProjectionError":null,"markdown":{"partId":"%s","revision":"9223372036854775807","textSha256":"%s","complete":true,"truncated":false,"bindings":[{"imageId":"%s","start":0,"end":1,"part":{"type":"image","imageId":"%s","resourceId":"%s","label":"i"}}],"retainedImages":[]}}`, id(1, i), int64(1000000000000000000)+int64(i), text, id(4, i), hash, id(2, i), id(2, i), resources[i%len(resources)].ResourceID))
	}
	sample := entryBytes(0, 0)
	if _, e := sp.DecodeTimeline(sample); e != nil {
		t.Fatal("capacity template invalid", e)
	}
	base := len(`{"entries":[]}`) + count*len(sample) + count - 1
	emptyHistory, e := sp.MarshalWire(map[string]any{"historyEpoch": "capacity-history", "sourceThrough": "9223372036854775807", "entries": []json.RawMessage{}, "resources": resources})
	if e != nil {
		t.Fatal(e)
	}
	targetTimeline := min(sp.MaxArchiveBytes, sp.MaxArchiveHistoryBytes-len(emptyHistory)+len(`{"entries":[]}`))
	remaining := targetTimeline - base
	if remaining < 0 {
		t.Fatal("declared counts cannot fit the valid fixture", base)
	}
	padding, remainder := remaining/count, remaining%count
	entries := make([]json.RawMessage, count)
	for i := range entries {
		extra := padding
		if i < remainder {
			extra++
		}
		entries[i] = entryBytes(i, extra)
	}
	timeline, e := sp.MarshalWire(map[string]any{"entries": entries})
	if e != nil {
		t.Fatal(e)
	}
	if len(timeline) != targetTimeline {
		t.Fatal("timeline boundary differs", len(timeline))
	}
	history, e := sp.MarshalWire(map[string]any{"historyEpoch": "capacity-history", "sourceThrough": "9223372036854775807", "entries": entries, "resources": resources})
	if e != nil {
		t.Fatal(e)
	}
	if len(history) != sp.MaxArchiveHistoryBytes {
		t.Fatal("complete synchronization boundary differs", len(history))
	}
	decoded, e := sp.DecodeArchiveHistory(history)
	if e != nil {
		t.Fatal("maximum legal history rejected", len(history), e)
	}
	ledger, e := makeArchiveLedger(decoded, decoded.HistoryEpoch, 9223372036854775807)
	if e != nil {
		t.Fatal(e)
	}
	ledger.HistoryID = id(5, 0)
	encoded := encode(ledger)
	estimate := archiveLedgerStorageBytes(encoded)
	if len(ledger.Entries) != count || len(ledger.Occurrences) != count || len(ledger.Resources) != 1000 || estimate > maxArchiveLedgerBytes {
		t.Fatal("legal capacity was truncated", len(ledger.Entries), len(ledger.Occurrences), len(ledger.Resources), estimate)
	}
	result := map[string]any{"entries": count, "occurrences": count, "resources": 1000, "timelineBytes": len(timeline), "historyBytes": len(history), "historyMaxBytes": sp.MaxArchiveHistoryBytes, "ledgerJSONBytes": len(encoded), "ledgerPostgresBoundBytes": estimate, "ledgerMaxBytes": maxArchiveLedgerBytes}
	if url := os.Getenv("DAYNIGHT_TEST_DATABASE_URL"); url != "" {
		db, e := pgx.Connect(ctx, url)
		if e != nil {
			t.Fatal(e)
		}
		defer db.Close(context.WithoutCancel(ctx))
		if _, e = db.Exec(ctx, `CREATE TEMP TABLE archive_capacity_probe(ledger jsonb NOT NULL CHECK(octet_length(ledger::text)<=67108864))`); e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, `INSERT INTO archive_capacity_probe VALUES($1)`, encoded); e != nil {
			t.Fatal("legal ledger did not persist", e)
		}
		var textBytes, storedBytes, totalBytes int64
		if e = db.QueryRow(ctx, `SELECT octet_length(ledger::text),pg_column_size(ledger),pg_total_relation_size('archive_capacity_probe') FROM archive_capacity_probe`).Scan(&textBytes, &storedBytes, &totalBytes); e != nil {
			t.Fatal(e)
		}
		if textBytes > int64(estimate) || textBytes > maxArchiveLedgerBytes {
			t.Fatal("jsonb exceeded its measured bound", textBytes, estimate)
		}
		result["postgresTextBytes"], result["postgresStoredColumnBytes"], result["postgresRelationBytes"] = textBytes, storedBytes, totalBytes
	}
	data, e := json.MarshalIndent(result, "", "  ")
	if e != nil {
		t.Fatal(e)
	}
	t.Log(string(data))
	if file := os.Getenv("DAYNIGHT_IMAGE_CAPACITY_RESULT"); file != "" {
		if e = os.WriteFile(file, append(data, '\n'), 0600); e != nil {
			t.Fatal(e)
		}
	}
}
