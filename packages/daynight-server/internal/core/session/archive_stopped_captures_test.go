package session

import (
	"context"
	"encoding/json"
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

func TestStoppedPreparationWaitsForOriginalWriters(t *testing.T) {
	for _, kind := range []string{"read", "write"} {
		t.Run(kind, func(t *testing.T) {
			op, d, r := archiveFlowFixture(t)
			d.bundle = nil
			policy := "task_body"
			r.HistoryContentPolicy = &policy
			d.leaseRows = map[string]store.SessionResourceLease{"original": {ID: "original", Kind: kind}}
			request := sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID}
			receipt, err := op.PrepareArchive(t.Context(), request)
			if kind == "write" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "resource_busy" || d.bundle != nil {
					t.Fatalf("writer allowed preparation: %+v %v", receipt, err)
				}
				delete(d.leaseRows, "original")
				receipt, err = op.PrepareArchive(t.Context(), request)
			}
			var ledger archiveLedger
			if err != nil || d.bundle == nil || json.Unmarshal(d.bundle.Ledger, &ledger) != nil || receipt.Phase != "settling" || ledger.StoppedContentPolicy != policy {
				t.Fatalf("stopped preparation: %+v %+v %v", receipt, d.bundle, err)
			}
		})
	}
}

type stoppedCaptureBoundaryDAO struct {
	*onlineImageRetirementDAO
	captures []store.SessionCaptureRecord
	leases   []store.SessionResourceLease
	listErr  error
	leaseErr error
}

func (d *stoppedCaptureBoundaryDAO) SessionCaptures(context.Context, string, string, int) ([]store.SessionCaptureRecord, error) {
	return d.captures, d.listErr
}

func (d *stoppedCaptureBoundaryDAO) ListSessionResourceLeases(context.Context, string) ([]store.SessionResourceLease, error) {
	return d.leases, d.leaseErr
}

func TestStoppedCaptureInventoryRefusalsPreserveOnlineReferences(t *testing.T) {
	for _, scenario := range []string{"inventory-error", "lease-error", "read-lease", "wildcard-read-lease", "unknown", "missing-resource", "failed"} {
		t.Run(scenario, func(t *testing.T) {
			id, resource := uuid.NewString(), uuid.NewString()
			position := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "reasoning", SourceKey: "image"}
			capture := store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{CaptureID: uuid.NewString(), Occurrence: position}, Receipt: sp.ImageCaptureReceipt{State: "committed", ResourceID: &resource}}
			d := &stoppedCaptureBoundaryDAO{onlineImageRetirementDAO: &onlineImageRetirementDAO{capture: capture}, captures: []store.SessionCaptureRecord{capture}}
			failure := errors.New("inventory unavailable")
			switch scenario {
			case "inventory-error":
				d.listErr = failure
			case "lease-error":
				d.leaseErr = failure
			case "read-lease":
				d.leases = []store.SessionResourceLease{{Kind: "read", ResourceID: resource}}
			case "wildcard-read-lease":
				d.leases = []store.SessionResourceLease{{Kind: "read"}}
			case "unknown":
				d.captures[0].Receipt.State = "unknown"
			case "missing-resource":
				d.captures[0].Receipt.ResourceID = nil
			case "failed":
				d.captures[0].Receipt.State = "failed"
				d.captures[0].Receipt.ResourceID = nil
				d.captures[0].Receipt.Error = &sp.ImageError{Code: "source_not_found", Message: "Original image was not found."}
			}
			r := &record{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}}}
			err := (&Execution{}).verifyStoppedCaptures(t.Context(), &operationTx{dao: d}, r, archiveLedger{ContentPolicy: "task_body"}, nil)
			switch scenario {
			case "inventory-error", "lease-error":
				if !errors.Is(err, failure) {
					t.Fatalf("storage error lost: %v", err)
				}
			case "read-lease", "wildcard-read-lease", "unknown", "missing-resource":
				var f *model.Fault
				want := "resource_busy"
				if scenario == "unknown" || scenario == "missing-resource" {
					want = "archive_conflict"
				}
				if !errors.As(err, &f) || f.Code != want {
					t.Fatalf("%s: %v", scenario, err)
				}
			case "failed":
				if err != nil {
					t.Fatal(err)
				}
			}
			if len(d.removed) != 0 || len(d.saved) != 0 {
				t.Fatalf("unsettled inventory released resources: %+v %+v", d.removed, d.saved)
			}
		})
	}
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
