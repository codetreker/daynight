package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskHistorySchema3SharesPermitAndRechecksTaskReadScope(t *testing.T) {
	for _, scenario := range []string{"original", "revoked", "cancelled", "cancelled_after_recheck", "close_failure", "manifest_replaced", "manifest_identity_changed", "timeline_reference_changed", "timeline_corrupt", "timeline_missing", "timeline_identity_changed"} {
		t.Run(scenario, func(t *testing.T) {
			op, dao, record := archiveFlowFixture(t)
			timeline, fileID := publishArchiveRecoveryFixture(t, op, record)
			s := op.execution
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if scenario == "timeline_reference_changed" || scenario == "manifest_identity_changed" {
				archive, err := s.files.Open(ctx, archiveBucket, dao.archivePath)
				if err != nil {
					t.Fatal(err)
				}
				var manifest sp.ArchiveManifest
				if err = json.NewDecoder(archive.Body).Decode(&manifest); err != nil {
					t.Fatal(err)
				}
				if err = archive.Body.Close(); err != nil {
					t.Fatal(err)
				}
				manifest.Timeline.SHA256 = strings.Repeat("a", 64)
				if scenario == "manifest_identity_changed" {
					manifest.RecordID, manifest.Fence.SessionID = "11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"
				}
				changed := encode(manifest)
				if _, err = s.files.Put(ctx, archiveBucket, dao.archivePath, bytes.NewReader(changed)); err != nil {
					t.Fatal(err)
				}
				hash, size := archiveDigest(changed), decimal(int64(len(changed)))
				dao.status.SHA256, dao.status.ByteLength = &hash, &size
			}
			if scenario == "timeline_corrupt" {
				if _, err := s.files.Put(ctx, archiveBucket, dao.files[fileID].Path+"/content", strings.NewReader("broken")); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "timeline_missing" {
				if err := s.files.Delete(ctx, archiveBucket, dao.files[fileID].Path+"/content"); err != nil {
					t.Fatal(err)
				}
			}
			s.archivePreflightRun = func(context.Context, model.Principal, string, string, string, ArchiveMode) (string, error) {
				return record.Owner, nil
			}
			refused := errors.New("Task history credential revoked")
			closeFailure := errors.New("read lease release confirmation lost")
			if scenario == "close_failure" {
				s.SetMediaLeaseCleanup(func(ctx context.Context, id, lease string) error {
					return errors.Join(dao.ReleaseSessionResourceLease(ctx, id, lease), closeFailure)
				})
			}
			objectsClosed, taskScopes := 0, 0
			s.SetTaskReadRunners(
				func(context.Context, model.Principal, string, string, string, BrowserPurpose, func(*Access) error) error {
					t.Fatal("unexpected browser scope")
					return nil
				},
				func(context.Context, model.Principal, string, string, func(*Operation, store.SessionScope, *TaskAccess, func(string) (*Access, error)) error) error {
					t.Fatal("unexpected task scope")
					return nil
				},
				func(actual context.Context, principal model.Principal, project, task, id string, finalize bool, work func(*Access) error) error {
					taskScopes++
					if principal != op.principal || project != "project" || task != "task" || id != op.id || finalize {
						t.Fatal("Task archive authorization changed")
					}
					if scenario == "revoked" && objectsClosed == 2 {
						return refused
					}
					if scenario == "cancelled_after_recheck" && taskScopes == 3 {
						defer cancel()
					}
					return work(&Access{tx: &operationTx{dao: dao}, record: record})
				})
			s.archiveRun = func(context.Context, model.Principal, string, string, string, bool, func(*Access) error) error {
				t.Fatal("history used owner archive scope")
				return nil
			}
			s.files = archiveDeliveryReadStorage{Storage: s.files, afterClose: func() {
				objectsClosed++
				if scenario == "manifest_replaced" && objectsClosed == 1 {
					hash := archiveDigest([]byte("replacement manifest"))
					dao.status.SHA256 = &hash
				}
				if scenario == "cancelled" && objectsClosed == 2 {
					cancel()
				}
				if scenario == "timeline_identity_changed" && objectsClosed == 2 {
					dao.bundle.Revision++
				}
			}}
			archive, err := s.TaskArchiveContent(ctx, op.principal, "project", "task", op.id)
			if scenario == "original" || scenario == "close_failure" {
				if err != nil || archive == nil {
					t.Fatal("schema3 failed under its original permit", err)
				}
				if !bytes.Equal(archive.TimelineBytes(), timeline) || bytes.Equal(archive.Bytes(), timeline) || dao.leases != 1 || taskScopes != 3 || objectsClosed != 2 {
					t.Fatal("archive lost manifest, timeline, scope or lease", taskScopes, objectsClosed, dao.leases)
				}
				if _, e := s.TryReserveArchivePreflight(); e == nil {
					t.Fatal("history permit released before transport")
				}
				for range 2 {
					e := archive.Close()
					if scenario == "close_failure" {
						if !errors.Is(e, closeFailure) {
							t.Fatal("read lease release failure lost", e)
						}
					} else if e != nil {
						t.Fatal(e)
					}
				}
			} else {
				if err == nil || archive != nil {
					t.Fatal("changed or unavailable archive escaped", scenario, err)
				}
				if scenario == "revoked" && !errors.Is(err, refused) {
					t.Fatal("authorization failure lost", err)
				}
				if strings.HasPrefix(scenario, "cancelled") && !errors.Is(err, context.Canceled) {
					t.Fatal("cancellation lost", err)
				}
				if scenario == "timeline_corrupt" || scenario == "timeline_missing" {
					var fault *model.Fault
					if !errors.As(err, &fault) || fault.Code != "source_corrupt" {
						t.Fatal("ready timeline damage lost its classification", err)
					}
				}
			}
			if dao.leases != 0 || len(s.archiveSlots) != 0 || len(s.archivePreflightSlots) != 0 {
				t.Fatal("history leaked permit or read lease", dao.leases)
			}
		})
	}
}
