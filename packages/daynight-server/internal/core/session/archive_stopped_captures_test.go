package session

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type stoppedInventoryDAO struct {
	*archiveFlowDAO
	captures []store.SessionCaptureRecord
}

func (d *stoppedInventoryDAO) SessionCaptures(_ context.Context, _ string, after string, _ int) ([]store.SessionCaptureRecord, error) {
	if after != "" {
		return nil, errors.New("unexpected cursor")
	}
	return d.captures, nil
}

func TestStoppedCaptureRequiresExactCommittedBodyOccurrence(t *testing.T) {
	for _, scenario := range []string{"exact", "missing", "wrong-resource", "wrong-position", "pending"} {
		t.Run(scenario, func(t *testing.T) {
			id, image, resource := uuid.NewString(), uuid.NewString(), uuid.NewString()
			position := sp.ImageOccurrence{ImageID: image, EntryID: uuid.NewString(), Container: "content", SourceKey: "source"}
			capture := store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{CaptureID: uuid.NewString(), Occurrence: position}, Receipt: sp.ImageCaptureReceipt{State: "committed", ResourceID: &resource}}
			ledger := archiveLedger{ContentPolicy: "task_body", Occurrences: []archiveLedgerOccurrence{{ImageID: image, EntryID: position.EntryID, Container: "content"}}}
			images := map[string]string{image: resource}
			switch scenario {
			case "missing":
				ledger.Occurrences = nil
			case "wrong-resource":
				images[image] = uuid.NewString()
			case "wrong-position":
				ledger.Occurrences[0].EntryID = uuid.NewString()
			case "pending":
				capture.Receipt.State = "copying"
			}
			d := &stoppedInventoryDAO{archiveFlowDAO: &archiveFlowDAO{}, captures: []store.SessionCaptureRecord{capture}}
			r := &record{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}}}
			err := (&Execution{}).verifyStoppedCaptures(t.Context(), &operationTx{dao: d}, r, ledger, images)
			if scenario == "exact" && err != nil {
				t.Fatal(err)
			}
			if scenario != "exact" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "archive_incomplete" {
					t.Fatalf("%s: %v", scenario, err)
				}
			}
		})
	}
}

func TestStoppedPreparationKeepsInitiallyUnboundPolicy(t *testing.T) {
	op, _, r := archiveFlowFixture(t)
	policy := "task_body"
	r.HistoryContentPolicy = &policy
	history := sp.ArchiveHistoryContent{ContentPolicy: policy, HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: []sp.TimelineEntry{taskBodyEntry(t, "1")}, Resources: []sp.Resource{}}
	body := encode(history)
	_, err := op.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body)
	var refusal *model.Fault
	if !errors.As(err, &refusal) || refusal.Code != "archive_conflict" {
		t.Fatalf("late policy binding accepted: %v", err)
	}
}
