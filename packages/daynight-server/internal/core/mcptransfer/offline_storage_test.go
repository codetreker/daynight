package mcptransfer

import (
	"bytes"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestOfflineTransferClosureRetainsProvenAndUnknownOutcomes(t *testing.T) {
	now := time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC)
	for _, state := range []string{"receiving", "committing", "unknown", "committed", "cleanup_pending"} {
		previous := "committed"
		record := model.PrivateTransfer{ID: "ticket", State: state, Data: []byte(`{"operationId":"original","writeOutcome":"unknown"}`), ReservedBytes: 1024, OutstandingBytes: 256, LeaseUntil: &now}
		if state == "cleanup_pending" {
			record.CleanupFromState = &previous
		}
		after, err := CloseOfflineTransfer(record, now)
		want := state
		if state == "committing" {
			want = "unknown"
		} else if state == "cleanup_pending" {
			want = "committed"
		}
		if err != nil || after.State != "closed" || after.CleanupFromState == nil || *after.CleanupFromState != want || !bytes.Equal(after.Data, record.Data) || after.ReservedBytes != 0 || after.OutstandingBytes != 0 || after.LeaseUntil != nil || after.RetainUntil == nil || !after.RetainUntil.Equal(now.Add(Retention)) || record.State != state || record.ReservedBytes != 1024 {
			t.Fatalf("%s closure: %+v, %v", state, after, err)
		}
	}
	if _, err := CloseOfflineTransfer(model.PrivateTransfer{State: "closed"}, now); err == nil {
		t.Fatal("closed transfer accepted")
	}
	if _, err := CloseOfflineTransfer(model.PrivateTransfer{State: "cleanup_pending"}, now); err == nil {
		t.Fatal("missing cleanup provenance accepted")
	}
}
