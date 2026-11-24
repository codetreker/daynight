package session

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type botReclaimFailureDAO struct {
	failingReclaimDAO
	store.BotHistoryWindowDAO
	store.SessionResourceUploadDAO
}

func (d botReclaimFailureDAO) SessionResourceReferenceCount(ctx context.Context, session, resource string) (int, error) {
	if d.point == "references" {
		return 0, d.cause
	}
	return d.imageRuleDAO.SessionResourceReferenceCount(ctx, session, resource)
}

func (d botReclaimFailureDAO) SessionUploadByResource(_ context.Context, session, resource string) (store.SessionUploadRecord, error) {
	if d.point == "upload lookup" {
		return store.SessionUploadRecord{}, d.cause
	}
	for _, upload := range d.uploads {
		if upload.SessionID == session && upload.BlobID == resource {
			return upload, nil
		}
	}
	return store.SessionUploadRecord{}, model.ErrNotFound
}

func (d botReclaimFailureDAO) SaveSessionUpload(ctx context.Context, upload store.SessionUploadRecord) error {
	if d.point == "upload release" {
		return d.cause
	}
	return d.imageRuleDAO.SaveSessionUpload(ctx, upload)
}

func TestBotWindowReclaimPreservesResponsibilityUntilEveryDeletionBarrierConfirms(t *testing.T) {
	for _, point := range []string{"references", "resource", "identity", "mark", "retained", "upload lookup", "upload release", "list", "lease cleanup", "final cleanup"} {
		t.Run(point, func(t *testing.T) {
			f, original := completedReclaimFixture(t)
			bot := uuid.NewString()
			f.r.BotID = &bot
			resource, session := original.Resource.ResourceID, f.r.Snapshot.SessionID
			queued := &botReclaimDAO{imageRuleDAO: f.d, queued: map[string]bool{resource: true}}
			f.d.references = map[store.SessionResourceReference]bool{}
			cause := errors.New("reclamation dependency unavailable")
			dao := &botReclaimFailureDAO{failingReclaimDAO: failingReclaimDAO{imageRuleDAO: f.d, point: point, cause: cause}, BotHistoryWindowDAO: queued}
			// A persisted lease whose process has exited must be released under its
			// actual storage gate before the immutable file can be removed.
			lease := uuid.NewString()
			f.d.leases[lease] = store.SessionResourceLease{ID: lease, SessionID: session, ResourceID: resource, Kind: "read"}
			unrelated := uuid.NewString()
			f.d.leases[unrelated] = store.SessionResourceLease{ID: unrelated, SessionID: session, ResourceID: uuid.NewString(), Kind: "read"}
			run := func(ctx context.Context, work func(store.SessionDAO, store.SessionRecord) error) error {
				return work(dao, store.SessionRecord{BotID: &bot, Owner: f.r.Owner, Snapshot: f.r.Snapshot})
			}
			err := f.s.ReclaimBotHistoryResourcesUsing(t.Context(), session, run)
			switch point {
			case "retained":
				if err != nil {
					t.Fatal(err)
				}
			case "identity":
				if err == nil {
					t.Fatal("inconsistent storage identity allowed deletion")
				}
			default:
				if !errors.Is(err, cause) {
					t.Fatal("lost reclamation failure", err)
				}
			}
			if !queued.queued[resource] {
				t.Fatal("failed reclamation discarded retry responsibility")
			}
			usage, err := f.d.SessionResourceUsage(t.Context(), session)
			if err != nil || usage.Bytes != 8 || usage.Resources != 1 {
				t.Fatal("unconfirmed deletion returned quota", usage, err)
			}
			if point != "final cleanup" {
				assertReclaimRetainsOriginal(t, f, original)
			}
			dao.point = ""
			if err = f.s.ReclaimBotHistoryResourcesUsing(t.Context(), session, run); err != nil {
				t.Fatal("reclamation did not resume", err)
			}
			if len(queued.queued) != 0 || len(f.d.resources) != 0 {
				t.Fatal("successful retry retained deletion responsibility")
			}
			if _, present := f.d.leases[unrelated]; !present {
				t.Fatal("reclamation released another resource's lease")
			}
			upload := f.d.uploads[f.spec.UploadID]
			if upload.Receipt.State != "released" || upload.Receipt.Resource != nil || upload.Spec.UploadID != f.spec.UploadID {
				t.Fatal("reclaimed upload lost identity or advertised deleted bytes", upload)
			}
		})
	}
}

func TestBotWindowReclaimSettlesMarkerAfterIndependentResourceCleanup(t *testing.T) {
	f, original := completedReclaimFixture(t)
	bot := uuid.NewString()
	f.r.BotID = &bot
	resource := original.Resource.ResourceID
	dao := &botReclaimDAO{imageRuleDAO: f.d, queued: map[string]bool{resource: true}}
	dao.references = map[store.SessionResourceReference]bool{}
	// Other authorized resource settlement can finish deletion while the Bot
	// window's durable marker still awaits its own maintenance pass.
	if err := f.files.Delete(t.Context(), sessionresource.Bucket, original.BlobPath); err != nil {
		t.Fatal(err)
	}
	delete(dao.resources, resource)
	run := func(ctx context.Context, work func(store.SessionDAO, store.SessionRecord) error) error {
		return work(dao, store.SessionRecord{BotID: &bot, Owner: f.r.Owner, Snapshot: f.r.Snapshot})
	}
	if err := f.s.ReclaimBotHistoryResourcesUsing(t.Context(), f.r.Snapshot.SessionID, run); err != nil {
		t.Fatal(err)
	}
	if len(dao.queued) != 0 {
		t.Fatal("absent resource left a permanent retry marker")
	}
}
