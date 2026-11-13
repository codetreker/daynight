package session

import (
	"context"
	"errors"
	"io/fs"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestReleaseCompletedUnsentUploadReclaimsOriginalAndQuotaButRetainsIdentity(t *testing.T) {
	raw := []byte("original image")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	if _, err := f.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	receipt, err := f.complete(t)
	if err != nil {
		t.Fatal(err)
	}
	original := f.d.resources[receipt.Resource.ResourceID]
	if !f.d.uploads[f.spec.UploadID].StorageReleased {
		t.Fatal("fixture did not finish staging cleanup")
	}
	out, err := f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID)
	if err != nil || out.State != "released" {
		t.Fatal(out, err)
	}
	if _, exists := f.d.resources[original.Resource.ResourceID]; exists {
		t.Fatal("released unsent original still consumes durable resource quota")
	}
	object, err := f.files.Open(t.Context(), sessionresource.Bucket, original.BlobPath)
	if err == nil {
		_ = object.Body.Close()
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("released unsent original still occupies storage", err)
	}
	if upload, exists := f.d.uploads[f.spec.UploadID]; !exists || upload.Spec != f.spec || upload.Receipt.State != "released" || !upload.StorageReleased {
		t.Fatal("reclamation lost immutable upload tombstone")
	}
	usage, err := f.d.SessionResourceUsage(t.Context(), f.r.Snapshot.SessionID)
	if err != nil || usage.Bytes != 0 || usage.Resources != 0 {
		t.Fatal("physical reclaim did not return quota", usage, err)
	}
}

func completedReclaimFixture(t *testing.T) (imageRuleFixture, store.SessionResourceRecord) {
	t.Helper()
	f := newImageRuleFixture(t, []byte("original"))
	f.prepare(t)
	if _, err := f.write(t, []byte("original"), 0); err != nil {
		t.Fatal(err)
	}
	u, err := f.complete(t)
	if err != nil {
		t.Fatal(err)
	}
	return f, f.d.resources[u.Resource.ResourceID]
}

func assertReclaimRetainsOriginal(t *testing.T, f imageRuleFixture, original store.SessionResourceRecord) {
	t.Helper()
	u, err := f.d.SessionResourceUsage(t.Context(), f.r.Snapshot.SessionID)
	if err != nil || u.Bytes != number(*original.Resource.ByteLength) || u.Resources != 1 {
		t.Fatal("unconfirmed physical cleanup returned quota", u, err)
	}
	object, err := f.files.Open(t.Context(), sessionresource.Bucket, original.BlobPath)
	if err != nil {
		t.Fatal("retained owner lost original", err)
	}
	_ = object.Body.Close()
}

func TestReleasedOriginalWaitsForExactReaderAndRejectsResurrection(t *testing.T) {
	f, original := completedReclaimFixture(t)
	lease := store.SessionResourceLease{SessionID: f.r.Snapshot.SessionID, ID: uuid.NewString(), ResourceID: original.Resource.ResourceID, Kind: "read", OwnerID: f.p.UserID}
	f.d.leases[lease.ID] = lease
	gate, err := f.files.AcquireGate(t.Context(), filestorage.MediaLeaseGate, "session-resource-lease/"+lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	if _, err = f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err == nil {
		t.Fatal("release reclaimed an actively read original")
	}
	assertReclaimRetainsOriginal(t, f, original)
	if !f.d.resources[original.Resource.ResourceID].GCPending || len(f.d.leases) != 1 {
		t.Fatal("busy reader lost durable reclamation or lease identity")
	}
	if err = f.d.AddSessionResourceReference(t.Context(), store.SessionResourceReference{SessionID: lease.SessionID, ResourceID: lease.ResourceID, Kind: "message", ReferenceID: "late"}); err == nil {
		t.Fatal("reclamation admitted a new durable pin")
	}
	lease.ID = uuid.NewString()
	if err = f.d.AcquireSessionResourceLease(t.Context(), lease); err == nil {
		t.Fatal("reclamation admitted a new reader")
	}
	if err = gate.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err != nil || len(f.d.resources) != 0 || len(f.d.leases) != 0 {
		t.Fatal("original identity retry did not reclaim the exited reader", err)
	}
}

func TestReleasedOriginalRetainsQuotaUntilPhysicalDeleteSucceeds(t *testing.T) {
	f, original := completedReclaimFixture(t)
	cause := errors.New("original unlink was not confirmed")
	f.s.files = imageBoundaryStorage{Storage: f.files, point: "delete", cause: cause}
	if _, err := f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); !errors.Is(err, cause) {
		t.Fatal("release hid physical cleanup failure", err)
	}
	assertReclaimRetainsOriginal(t, f, original)
	if !f.d.resources[original.Resource.ResourceID].GCPending || f.d.uploads[f.spec.UploadID].Receipt.State != "released" {
		t.Fatal("failed delete lost the retryable original identity")
	}
	f.s.files = f.files
	if _, err := f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err != nil || len(f.d.resources) != 0 {
		t.Fatal("failed delete could not settle under original identity", err)
	}
	if u, created, err := f.s.PrepareUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec); err != nil || created || u.State != "released" {
		t.Fatal("reclaimed upload identity did not retain its terminal receipt", u, created, err)
	}
}

func expiredReclaimFixture(t *testing.T) (imageRuleFixture, *ArchiveOperation, string) {
	t.Helper()
	f := newImageRuleFixture(t, []byte("original"))
	f.prepare(t)
	if _, err := f.write(t, []byte("orig"), 0); err != nil {
		t.Fatal(err)
	}
	u := f.d.uploads[f.spec.UploadID]
	u.ExpiresAt = time.Now().Add(-time.Hour)
	f.d.uploads[f.spec.UploadID] = u
	f.r.Snapshot.Lifecycle = "archived"
	f.s.archiveRun = func(ctx context.Context, p model.Principal, _, _, id string, finalize bool, fn func(*Access) error) error {
		if !finalize || p != f.p || id != f.r.Snapshot.SessionID {
			t.Fatal("incorrect settlement authority")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return fn(&Access{tx: &operationTx{dao: f.d}, record: f.r})
	}
	op := &ArchiveOperation{execution: f.s, principal: f.p, id: f.r.Snapshot.SessionID, owner: f.r.Owner, mode: ArchiveV1Upload}
	return f, op, f.d.chunks[f.spec.UploadID][0].Path
}

func TestArchiveExpiryWaitsForOriginalWriterAndPhysicalStagingCleanup(t *testing.T) {
	f, op, path := expiredReclaimFixture(t)
	gate, err := f.files.AcquireGate(t.Context(), filestorage.PrivateGate, "session-image-upload/"+op.id+"/"+f.spec.UploadID)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	if err = op.SettleExpiredUploads(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("expiry did not wait for the writer", err)
	}
	if u := f.d.uploads[f.spec.UploadID]; u.Receipt.State != "receiving" || u.StorageReleased {
		t.Fatal("expiry retired the live writer reservation", u)
	}
	if err = gate.Close(); err != nil {
		t.Fatal(err)
	}
	cause := errors.New("staging unlink failed")
	f.s.files = imageBoundaryStorage{Storage: f.files, point: "delete", cause: cause}
	if err = op.SettleExpiredUploads(t.Context()); !errors.Is(err, cause) {
		t.Fatal("expiry hid staging deletion failure", err)
	}
	if u := f.d.uploads[f.spec.UploadID]; u.Receipt.State != "expired" || u.StorageReleased {
		t.Fatal("failed expiry cleanup returned staging quota", u)
	}
	f.s.files = f.files
	if err = op.SettleExpiredUploads(t.Context()); err != nil {
		t.Fatal("expiry did not retry the original terminal identity", err)
	}
	if !f.d.uploads[f.spec.UploadID].StorageReleased {
		t.Fatal("settlement did not return quota after confirmed cleanup")
	}
	object, err := f.files.Open(t.Context(), sessionresource.Bucket, path)
	if err == nil {
		_ = object.Body.Close()
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("expiry retained original staging", err)
	}
}

type stoppingReclaimStorage struct {
	filestorage.Storage
	started, canceled, release chan struct{}
}

func (s stoppingReclaimStorage) DeleteSessionUpload(ctx context.Context, n sessionresource.Namespace, id string) error {
	return s.Storage.(filestorage.UploadStorage).DeleteSessionUpload(ctx, n, id)
}
func (s stoppingReclaimStorage) Delete(ctx context.Context, _, _ string) error {
	close(s.started)
	<-ctx.Done()
	close(s.canceled)
	<-s.release
	return ctx.Err()
}

func TestReleasedOriginalShutdownWaitsForPhysicalCleanupExit(t *testing.T) {
	f, original := completedReclaimFixture(t)
	files := stoppingReclaimStorage{Storage: f.files, started: make(chan struct{}), canceled: make(chan struct{}), release: make(chan struct{})}
	f.s.files = files
	result := make(chan error, 1)
	go func() {
		_, err := f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID)
		result <- err
	}()
	<-files.started
	stopped := make(chan error, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	go func() { stopped <- f.s.Stop(ctx) }()
	<-files.canceled
	select {
	case err := <-stopped:
		t.Fatal("shutdown completed before physical cleanup exited", err)
	default:
	}
	close(files.release)
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatal("shutdown lost cleanup cancellation", err)
	}
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	assertReclaimRetainsOriginal(t, f, original)
}

type failingReclaimDAO struct {
	*imageRuleDAO
	point string
	cause error
}

func (d failingReclaimDAO) MarkSessionResourceReclaim(ctx context.Context, s, id string) (bool, error) {
	if d.point == "mark" {
		return false, d.cause
	}
	if d.point == "retained" {
		return false, nil
	}
	return d.imageRuleDAO.MarkSessionResourceReclaim(ctx, s, id)
}
func (d failingReclaimDAO) SavedSessionResource(ctx context.Context, s, id string) (store.SessionResourceRecord, error) {
	if d.point == "resource" {
		return store.SessionResourceRecord{}, d.cause
	}
	r, err := d.imageRuleDAO.SavedSessionResource(ctx, s, id)
	if d.point == "identity" {
		r.BlobPath = "different/original"
	}
	return r, err
}
func (d failingReclaimDAO) ListSessionResourceLeases(ctx context.Context, s string) ([]store.SessionResourceLease, error) {
	if d.point == "list" {
		return nil, d.cause
	}
	return d.imageRuleDAO.ListSessionResourceLeases(ctx, s)
}
func (d failingReclaimDAO) ReleaseSessionResourceLease(ctx context.Context, s, id string) error {
	if d.point == "lease cleanup" {
		return d.cause
	}
	return d.imageRuleDAO.ReleaseSessionResourceLease(ctx, s, id)
}
func (d failingReclaimDAO) DeleteReclaimedSessionResource(ctx context.Context, s, id string) error {
	if d.point == "final cleanup" {
		return d.cause
	}
	return d.imageRuleDAO.DeleteReclaimedSessionResource(ctx, s, id)
}

func TestReleasedOriginalPreservesQuotaAcrossReclamationFailures(t *testing.T) {
	for _, point := range []string{"mark", "retained", "resource", "identity", "list", "lease cleanup", "final cleanup"} {
		t.Run(point, func(t *testing.T) {
			f, original := completedReclaimFixture(t)
			cause := errors.New("reclamation transaction failed")
			d := failingReclaimDAO{imageRuleDAO: f.d, point: point, cause: cause}
			bindImageBoundary(f, d, true)
			lease := store.SessionResourceLease{SessionID: f.r.Snapshot.SessionID, ID: uuid.NewString(), ResourceID: original.Resource.ResourceID}
			if point == "lease cleanup" {
				f.d.leases[lease.ID] = lease
			}
			_, err := f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID)
			if point == "identity" || point == "retained" {
				if err == nil {
					t.Fatal("unsafe reclamation was accepted")
				}
			} else if !errors.Is(err, cause) {
				t.Fatal("reclamation hid its failed transaction", err)
			}
			usage, err := f.d.SessionResourceUsage(t.Context(), f.r.Snapshot.SessionID)
			if err != nil || usage.Bytes != 8 || usage.Resources != 1 {
				t.Fatal("unconfirmed database cleanup returned quota", usage, err)
			}
			if point != "final cleanup" {
				assertReclaimRetainsOriginal(t, f, original)
			}
			bindImageBoundary(f, f.d, true)
			if _, err = f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err != nil || len(f.d.resources) != 0 {
				t.Fatal("reclamation could not resume after observing failure", err)
			}
		})
	}
}

func TestCompletedUploadExpiryReclaimsOnlyItsOwnUnsentReference(t *testing.T) {
	for _, kind := range []string{"unused", "operation", "unknown", "message", "archive", "native_resume"} {
		t.Run(kind, func(t *testing.T) {
			f, original := completedReclaimFixture(t)
			u := f.d.uploads[f.spec.UploadID]
			u.ExpiresAt = time.Now().Add(-time.Hour)
			f.d.uploads[f.spec.UploadID] = u
			if kind != "unused" {
				f.d.references[store.SessionResourceReference{SessionID: u.SessionID, ResourceID: u.BlobID, Kind: kind, ReferenceID: "retained"}] = true
			}
			out, err := f.s.GetUpload(t.Context(), f.p, "", "", u.SessionID, f.spec.UploadID)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "unused" {
				if out.State != "expired" || out.Resource != nil || len(f.d.resources) != 0 {
					t.Fatal("unused complete original did not expire and return quota", out)
				}
			} else {
				if out.State != "complete" || out.Resource == nil || f.d.resources[u.BlobID].GCPending {
					t.Fatal("TTL reclaimed a durable operation or history owner", out)
				}
				assertReclaimRetainsOriginal(t, f, original)
			}
		})
	}
}

func TestExpiredCompleteReplayDoesNotRenewUploadEligibility(t *testing.T) {
	for _, action := range []string{"prepare", "complete"} {
		t.Run(action, func(t *testing.T) {
			f, original := completedReclaimFixture(t)
			u := f.d.uploads[f.spec.UploadID]
			u.ExpiresAt = time.Now().Add(-time.Hour)
			f.d.uploads[f.spec.UploadID] = u
			if action == "prepare" {
				out, created, err := f.s.PrepareUpload(t.Context(), f.p, "", "", u.SessionID, f.spec)
				if err != nil || created || out.State != "expired" {
					t.Fatal("precise prepare replay renewed eligibility", out, created, err)
				}
			} else if _, err := f.complete(t); err == nil {
				t.Fatal("precise complete replay renewed eligibility")
			}
			if !f.d.uploads[f.spec.UploadID].ExpiresAt.Equal(u.ExpiresAt) {
				t.Fatal("replay changed fixed expiry")
			}
			assertReclaimRetainsOriginal(t, f, original)
		})
	}
}

func TestArchiveExpiryReclaimsOnlyUnoccupiedCompletedOriginal(t *testing.T) {
	for _, pinned := range []bool{false, true} {
		t.Run(map[bool]string{false: "unused", true: "unknown"}[pinned], func(t *testing.T) {
			f, original := completedReclaimFixture(t)
			u := f.d.uploads[f.spec.UploadID]
			u.ExpiresAt = time.Now().Add(-time.Hour)
			f.d.uploads[f.spec.UploadID] = u
			if pinned {
				f.d.references[store.SessionResourceReference{SessionID: u.SessionID, ResourceID: u.BlobID, Kind: "unknown", ReferenceID: "original-operation"}] = true
			}
			f.r.Snapshot.Lifecycle = "archived"
			f.s.archiveRun = func(ctx context.Context, _ model.Principal, _, _, _ string, finalize bool, fn func(*Access) error) error {
				if !finalize {
					t.Fatal("settlement omitted original finalization scope")
				}
				return fn(&Access{tx: &operationTx{dao: f.d}, record: f.r})
			}
			op := &ArchiveOperation{execution: f.s, principal: f.p, id: u.SessionID, owner: f.r.Owner, mode: ArchiveV1Upload}
			if err := op.SettleExpiredUploads(t.Context()); err != nil {
				t.Fatal(err)
			}
			if pinned {
				if f.d.uploads[f.spec.UploadID].Receipt.State != "complete" {
					t.Fatal("archive TTL changed occupied upload")
				}
				assertReclaimRetainsOriginal(t, f, original)
			} else if f.d.uploads[f.spec.UploadID].Receipt.State != "expired" || len(f.d.resources) != 0 {
				t.Fatal("archive did not reclaim unused complete original")
			}
		})
	}
}

type reclaimProposalDAO struct {
	*imageRuleDAO
	proposed bool
	audit    func()
}

func (d *reclaimProposalDAO) DeleteReclaimedSessionResource(context.Context, string, string) error {
	d.audit()
	d.proposed = true
	return nil
}

type reclaimGateAuditStorage struct {
	filestorage.Storage
	audit func()
}

func (s reclaimGateAuditStorage) DeleteSessionUpload(ctx context.Context, n sessionresource.Namespace, id string) error {
	return s.Storage.(filestorage.UploadStorage).DeleteSessionUpload(ctx, n, id)
}
func (s reclaimGateAuditStorage) Delete(ctx context.Context, bucket, path string) error {
	s.audit()
	return s.Storage.Delete(ctx, bucket, path)
}

func TestReleasedOriginalUnknownFinalCompletionRetainsQuotaAndExactGate(t *testing.T) {
	f, original := completedReclaimFixture(t)
	lease := store.SessionResourceLease{SessionID: f.r.Snapshot.SessionID, ID: uuid.NewString(), ResourceID: original.Resource.ResourceID}
	f.d.leases[lease.ID] = lease
	audits := 0
	audit := func() {
		audits++
		gate, err := filestorage.TryAcquireMediaLease(t.Context(), f.files, "session-resource-lease/"+lease.ID)
		if err == nil {
			_ = gate.Close()
		}
		if !errors.Is(err, filestorage.ErrGateBusy) {
			t.Fatal("GC released exact owner gate before physical and database cleanup", err)
		}
	}
	d := &reclaimProposalDAO{imageRuleDAO: f.d, audit: audit}
	lost := errors.New("final cleanup commit acknowledgement lost")
	f.s.files = reclaimGateAuditStorage{Storage: f.files, audit: audit}
	f.s.browserRun = func(ctx context.Context, _ model.Principal, _, _, _ string, _ BrowserPurpose, fn func(*Access) error) error {
		err := fn(&Access{tx: &operationTx{dao: d}, record: f.r, write: true})
		// Proposed DAO writes and transaction completion are independent. This
		// scope deliberately supplies no durable outcome for the final proposal.
		if err == nil && d.proposed {
			return &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: lost}
		}
		return err
	}
	_, err := f.s.ReleaseUpload(t.Context(), f.p, "", "", lease.SessionID, f.spec.UploadID)
	var failure *store.TransactionError
	if !errors.Is(err, lost) || !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown || audits != 2 {
		t.Fatal("unknown cleanup completion or held gates were lost", err, audits)
	}
	usage, err := f.d.SessionResourceUsage(t.Context(), lease.SessionID)
	if err != nil || usage.Bytes != 8 || usage.Resources != 1 || !f.d.resources[lease.ResourceID].GCPending {
		t.Fatal("unknown final outcome returned unconfirmed quota", usage, err)
	}
	f.s.files = f.files
	bindImageBoundary(f, f.d, true)
	if _, err = f.s.ReleaseUpload(t.Context(), f.p, "", "", lease.SessionID, f.spec.UploadID); err != nil || len(f.d.resources) != 0 {
		t.Fatal("original identity could not reconcile observed pending cleanup", err)
	}
}

func TestArchiveExpiryRequiresMatchingOriginalControllerRelease(t *testing.T) {
	for _, state := range []string{"missing", "pending", "failed", "changed image", "changed target", "validated residue", "confirmed"} {
		t.Run(state, func(t *testing.T) {
			f, op, path := expiredReclaimFixture(t)
			prepareID := mediaIdentity(f.spec.UploadID, "prepare")
			f.d.media[prepareID] = store.SessionMediaRequest{SessionID: op.id, RequestID: prepareID, Action: "prepare", Body: encode(f.spec)}
			if state != "missing" {
				receipt := sp.LocalImagePreparation{UploadID: f.spec.UploadID, ImageID: f.spec.ImageID, Target: f.spec.Target, State: "released"}
				row := store.SessionMediaRequest{SessionID: op.id, RequestID: mediaIdentity(f.spec.UploadID, "release"), Action: "release", Complete: state != "pending"}
				switch state {
				case "failed":
					row.Error = &sp.ImageError{Code: "source_unavailable", Message: "Original preparation unavailable."}
				case "changed image":
					receipt.ImageID = uuid.NewString()
				case "changed target":
					receipt.Target.ActorUserID = uuid.NewString()
				case "validated residue":
					receipt.Validated = &sp.ValidatedImage{}
				}
				row.Result = encode(receipt)
				f.d.media[row.RequestID] = row
			}
			err := op.SettleExpiredUploads(t.Context())
			if state == "confirmed" {
				if err != nil || !f.d.uploads[f.spec.UploadID].StorageReleased {
					t.Fatal("original confirmed release could not settle", err)
				}
				return
			}
			if err == nil || f.d.uploads[f.spec.UploadID].StorageReleased {
				t.Fatal("expiry treated unknown or mismatched Controller release as cleanup", err)
			}
			usage, err := f.d.SessionResourceUsage(t.Context(), op.id)
			if err != nil || usage.Bytes != 0 || usage.Resources != 0 {
				t.Fatal("unconfirmed remote cleanup changed accepted content", usage, err)
			}
			object, err := f.files.Open(t.Context(), sessionresource.Bucket, path)
			if err != nil {
				t.Fatal("unconfirmed remote release deleted recovery staging", err)
			}
			_ = object.Body.Close()
		})
	}
}
