//go:build stress

package session

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestArchiveCleanupPhysicalCapacityStress(t *testing.T) {
	const archives, chunks, chunkBytes = 32, 64, 64 * 1024
	files := cleanupLocal(t)
	targets := make([]store.ArchiveCleanupTarget, archives)
	paths := make([]string, 0, archives*chunks)
	payload := strings.Repeat("a", chunkBytes)
	var written int64
	prepared := time.Now()
	for i := range targets {
		targets[i] = cleanupTarget()
		namespace, err := sessionarchive.NewNamespace(sessionarchive.Projects, targets[i].ProjectID, targets[i].SessionID)
		if err != nil {
			t.Fatal(err)
		}
		for chunk := range chunks {
			path := fmt.Sprintf("%s/staging/%03d", namespace.Directory(), chunk)
			info, err := files.Put(t.Context(), sessionarchive.Bucket, path, strings.NewReader(payload))
			if err != nil {
				t.Fatal(err)
			}
			if info.Size != chunkBytes {
				t.Fatalf("stored chunk length=%d", info.Size)
			}
			written += info.Size
			paths = append(paths, path)
		}
	}
	prepareElapsed := time.Since(prepared)
	resourceID := uuid.NewString()
	sharedPath, err := core.BlobAddress(targets[0].ProjectID, targets[0].OwnerID, targets[0].SessionID, resourceID)
	if err != nil {
		t.Fatal(err)
	}
	cleanupPut(t, files, sessionresource.Bucket, sharedPath, "shared resource remains owned")
	shared := store.SessionResourceRecord{SessionID: targets[0].SessionID, Resource: sp.Resource{ResourceID: resourceID, Status: "available"}, BlobID: resourceID, BlobPath: sharedPath}
	completed := 0
	db := cleanupStoreStub{
		list: func(_ context.Context, cursor string, limit int) ([]store.ArchiveCleanupTarget, error) {
			if cursor != "" || limit != archives {
				t.Fatal("unexpected capacity page")
			}
			return targets, nil
		},
		write: func(ctx context.Context, target store.ArchiveCleanupTarget, work func(store.ArchiveCleanupScope) error) (store.Completion, error) {
			dao := cleanupMediaStub{
				resources: func(context.Context, string) ([]store.SessionResourceRecord, error) {
					if target.SessionID == shared.SessionID {
						return []store.SessionResourceRecord{shared}, nil
					}
					return nil, nil
				},
				leases: func(context.Context, string) ([]store.SessionResourceLease, error) { return nil, nil },
				remove: func(context.Context, string, string) error { t.Fatal("shared resource reclaimed"); return nil },
			}
			scope := cleanupScopeStub{target: target, dao: dao, complete: func(context.Context, time.Time) error { completed++; return nil }}
			return store.Completion{Outcome: store.TransactionCommitted}, work(scope)
		},
	}
	cleanup := NewArchiveCleanup(db, files)
	cleanup.expire = func(context.Context, store.ArchiveCleanupScope, time.Time) (bool, error) { return true, nil }
	started := time.Now()
	cursor, err := cleanup.Sweep(t.Context(), "")
	elapsed := time.Since(started)
	if err != nil || completed != archives || cursor != targets[archives-1].SessionID {
		t.Fatalf("capacity cleanup: completed=%d cursor=%q error=%v", completed, cursor, err)
	}
	for _, path := range paths {
		cleanupAbsent(t, files, sessionarchive.Bucket, path)
	}
	cleanupContent(t, files, sessionresource.Bucket, sharedPath, "shared resource remains owned")
	if written != 128*1024*1024 {
		t.Fatalf("unexpected workload bytes=%d", written)
	}
	t.Logf("physical archive cleanup: archives=%d files=%d bytes=%d prepare_elapsed=%s cleanup_elapsed=%s shared_bytes_preserved=%d", archives, len(paths), written, prepareElapsed, elapsed, len("shared resource remains owned"))
}
