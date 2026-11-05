package sessionrelay

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestArchiveNativeIdentitySurvivesAnotherRelayLiveCache(t *testing.T) {
	for _, expire := range []bool{false, true} {
		name := "read while draining"
		if expire {
			name = "expire draining session"
		}
		t.Run(name, func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			now := time.Now().UTC()
			f.s.now = func() time.Time { return now }
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := files.Close(); err != nil {
					t.Error(err)
				}
			})
			f.s.files = files
			archiveTerminal(t, f)
			if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET draining_until=$2,snapshot=jsonb_set(snapshot,'{lifecycle}','"draining"') WHERE id=$1`, v.SessionID, now.Add(time.Minute)); err != nil {
				t.Fatal(err)
			}

			// The controller's relay keeps its last acknowledged null identity;
			// another instance receives the archive after the native process stops.
			writer := New(f.s.DB, files)
			native := "native-created-after-last-ack"
			doc := sp.ArchiveDocument{Fence: v.Fence, SchemaVersion: 1, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, NativeSessionID: &native, Entries: []sp.TimelineEntry{localEntry(t, "1")}, Resources: []sp.ArchiveResource{}}
			data := encode(doc)
			status, err := writer.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data)
			if err != nil || status.State != "ready" {
				t.Fatal(status, err)
			}
			cached := f.s.live[v.SessionID]
			if cached == nil || cached.value == nil || cached.value.Snapshot.Identity.NativeSessionID != nil {
				t.Fatal("original relay did not retain the old live snapshot")
			}
			if expire {
				now = now.Add(2 * time.Minute)
			}
			current, err := f.s.Current(ctx, f.p, f.project, f.task)
			if err != nil {
				t.Fatal(err)
			}
			snapshot := current["session"].(sp.Snapshot)
			if snapshot.Identity.NativeSessionID == nil || *snapshot.Identity.NativeSessionID != native {
				t.Errorf("current lost finalized native identity: %#v", snapshot.Identity.NativeSessionID)
			}
			lifecycle := "draining"
			if expire {
				lifecycle = "archived"
			}
			if snapshot.Lifecycle != lifecycle || snapshot.Operations.CanSend || snapshot.Operations.CanRespond {
				t.Fatal("terminal read restored control", snapshot)
			}
			var savedNative *string
			var savedLifecycle string
			if err = f.s.DB.Pool.QueryRow(ctx, `SELECT snapshot->'identity'->>'nativeSessionId',snapshot->>'lifecycle' FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&savedNative, &savedLifecycle); err != nil || savedNative == nil || *savedNative != native || savedLifecycle != lifecycle {
				t.Fatal("terminal read regressed persisted identity", savedNative, savedLifecycle, err)
			}
			got, err := f.s.ArchiveContent(ctx, f.p, f.project, f.task, v.SessionID)
			if err != nil || !bytes.Equal(got, data) {
				t.Fatal("archive differs across relay instances", err)
			}
			if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err != nil {
				t.Fatal("original relay rejected identical archive retry", err)
			}
		})
	}
}
