package session

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type archiveDeliveryReadStorage struct {
	filestorage.Storage
	afterClose func()
}

type archiveDeliveryReadCloser struct {
	io.ReadCloser
	afterClose func()
}

func (r archiveDeliveryReadCloser) Close() error {
	err := r.ReadCloser.Close()
	r.afterClose()
	return err
}

func (s archiveDeliveryReadStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	object, err := s.Storage.Open(ctx, bucket, path)
	if err == nil {
		object.Body = archiveDeliveryReadCloser{ReadCloser: object.Body, afterClose: s.afterClose}
	}
	return object, err
}

type archiveDeliveryDAO struct {
	*archiveFlowDAO
	usage    store.SessionResourceUsage
	usageErr error
	postRead bool
	fail     string
	failure  error
}

func (d *archiveDeliveryDAO) SessionArchive(ctx context.Context, id string) (sp.ArchiveStatus, string, error) {
	if d.postRead && d.fail == "status-failure" {
		return sp.ArchiveStatus{}, "", d.failure
	}
	return d.archiveFlowDAO.SessionArchive(ctx, id)
}
func (d *archiveDeliveryDAO) SessionArchiveBundle(ctx context.Context, id string) (store.ArchiveBundle, error) {
	if d.postRead && d.fail == "bundle-failure" {
		return store.ArchiveBundle{}, d.failure
	}
	return d.archiveFlowDAO.SessionArchiveBundle(ctx, id)
}
func (d *archiveDeliveryDAO) SessionArchiveFile(ctx context.Context, id, file string) (store.ArchiveBundleFile, error) {
	if d.postRead && d.fail == "file-failure" {
		return store.ArchiveBundleFile{}, d.failure
	}
	return d.archiveFlowDAO.SessionArchiveFile(ctx, id, file)
}

func (d *archiveDeliveryDAO) SessionResourceUsage(context.Context, string) (store.SessionResourceUsage, error) {
	return d.usage, d.usageErr
}

func TestArchiveTimelineSuppressesDeliveryAfterPostReadScopeOrIdentityChange(t *testing.T) {
	for _, kind := range []string{"original", "membership-revoked", "credential-revoked", "deleted", "epoch-changed", "owner-changed", "archive-changed", "file-changed", "ledger-changed", "usage-failure", "status-failure", "bundle-failure", "file-failure", "archive-path-changed", "bundle-file-changed", "bundle-prepare-changed", "bundle-identity-changed", "bundle-revision-changed", "revoked-cleanup-failure"} {
		t.Run(kind, func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			timeline, fileID := publishArchiveRecoveryFixture(t, op, r)
			d := &archiveDeliveryDAO{archiveFlowDAO: base, usage: store.SessionResourceUsage{DeleteEpoch: 7}}
			readComplete := false
			scopeCalls := 0
			refusal := errors.New("ordinary archive scope revoked")
			storageFailure := errors.New("post-read storage unavailable")
			cleanupFailure := errors.New("read lease cleanup confirmation lost")
			if kind == "revoked-cleanup-failure" {
				op.execution.SetMediaLeaseCleanup(func(ctx context.Context, id, lease string) error {
					if e := d.ReleaseSessionResourceLease(ctx, id, lease); e != nil {
						return e
					}
					return cleanupFailure
				})
			}
			d.fail, d.failure = kind, storageFailure
			op.execution.archivePreflightRun = func(context.Context, model.Principal, string, string, string, ArchiveMode) (string, error) {
				return r.Owner, nil
			}
			op.execution.archiveRun = func(ctx context.Context, p model.Principal, project, task, id string, finalize bool, work func(*Access) error) error {
				scopeCalls++
				if p != op.principal || project != "" || task != "" || id != op.id || finalize {
					t.Fatal("timeline used another principal or owner finalization scope")
				}
				if readComplete && (kind == "membership-revoked" || kind == "credential-revoked" || kind == "revoked-cleanup-failure") {
					return refusal
				}
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			op.execution.files = archiveDeliveryReadStorage{Storage: op.execution.files, afterClose: func() {
				if readComplete {
					t.Fatal("timeline object closed more than once")
				}
				readComplete = true
				d.postRead = true
				switch kind {
				case "deleted":
					d.usage.Deleting = true
				case "epoch-changed":
					d.usage.DeleteEpoch++
				case "owner-changed":
					r.Owner = "changed-owner"
				case "archive-path-changed":
					d.archivePath += "/replacement"
				case "bundle-file-changed":
					d.bundle.TimelineID = "another-file"
				case "bundle-prepare-changed":
					d.bundle.PrepareID = "another-preparation"
				case "bundle-identity-changed":
					d.bundle.Identity = []byte(`{}`)
				case "bundle-revision-changed":
					d.bundle.Revision++
				case "archive-changed":
					h := archiveDigest([]byte("replacement archive"))
					d.status.SHA256 = &h
				case "file-changed":
					f := d.files[fileID]
					f.SHA256 = archiveDigest([]byte("replacement timeline"))
					d.files[fileID] = f
				case "ledger-changed":
					d.bundle.Ledger = []byte(`{}`)
				case "usage-failure":
					d.usageErr = storageFailure
				}
			}}
			reservation, e := op.execution.TryReserveArchivePreflight()
			if e != nil {
				t.Fatal(e)
			}
			retained, e := op.execution.ArchiveTimelineContentReserved(t.Context(), op.principal, "", "", op.id, fileID, reservation)
			if kind == "original" {
				if e != nil || retained == nil || !bytes.Equal(retained.Data, timeline) || !readComplete || scopeCalls != 2 || d.leases != 1 {
					t.Fatal("original timeline missed post-read authorization", e, scopeCalls, d.leases)
				}
			} else {
				if e == nil || retained != nil || !readComplete {
					if retained != nil {
						_ = retained.Close()
					}
					t.Fatal("late timeline bytes escaped changed authority or archive identity", kind, e)
				}
				if (kind == "membership-revoked" || kind == "credential-revoked" || kind == "revoked-cleanup-failure") && !errors.Is(e, refusal) {
					t.Fatal("lost ordinary scope refusal", e)
				}
				if kind == "revoked-cleanup-failure" && !errors.Is(e, cleanupFailure) {
					t.Fatal("scope refusal lost lease cleanup error", e)
				}
				if (kind == "usage-failure" || kind == "status-failure" || kind == "bundle-failure" || kind == "file-failure") && !errors.Is(e, storageFailure) {
					t.Fatal("lost post-read storage error", e)
				}
			}
			if retained != nil {
				if e := retained.Close(); e != nil {
					t.Fatal(e)
				}
			}
			if d.leases != 0 || len(op.execution.archiveSlots) != 0 || len(op.execution.archivePreflightSlots) != 0 {
				t.Fatal("timeline delivery leaked read or capacity leases", d.leases)
			}
		})
	}
}
