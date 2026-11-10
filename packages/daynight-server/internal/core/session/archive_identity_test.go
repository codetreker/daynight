package session

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
			configureArchiveFixture(f)
			f.dao.Expect("SetSessionArchiveReady", 1)
			f.dao.Expect("SetSessionArchiveState", 0)
			drainingUntil := now.Add(time.Minute)
			f.data.Session.DrainUntil = &drainingUntil
			f.data.Session.Snapshot.Lifecycle = "draining"

			// The controller's relay keeps its last acknowledged null identity;
			// another instance receives the archive after the native process stops.
			writer := New(f.writer, files)
			native := "native-created-after-last-ack"
			doc := sp.ArchiveDocument{Fence: v.Fence, SchemaVersion: 1, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, NativeSessionID: &native, Entries: []sp.TimelineEntry{localEntry(t, "1")}, Resources: []sp.ArchiveResource{}}
			data := encode(doc)
			status, err := fixtureArchivePut(f, writer, ctx, f.p, f.project, f.task, v.SessionID, data, map[string]int{"SetSessionArchiveReady": 1, "SaveSession": 1})
			if err != nil || status.State != "ready" {
				t.Fatal(status, err)
			}
			if f.writes.Session == nil || f.writes.Session.Snapshot.Identity.NativeSessionID == nil || *f.writes.Session.Snapshot.Identity.NativeSessionID != native {
				t.Fatal("writer did not propose finalized native identity")
			}
			f.SelectSessionWrite(t)
			acceptArchiveWrites(t, f, v.SessionID, data)
			cached := f.s.live[v.SessionID]
			if cached == nil || cached.value == nil || cached.value.Snapshot.Identity.NativeSessionID != nil {
				t.Fatal("original relay did not retain the old live snapshot")
			}
			if expire {
				now = now.Add(2 * time.Minute)
			}
			work := map[string]int{"CurrentTaskSession": 1, "SessionBotID": 1, "LockSession": 1}
			if expire {
				work["SaveSession"] = 1
			}
			phase := f.TaskPhase(ctx, work)
			current, err := f.s.Current(phase, f.p, f.project, f.task)
			f.dao.FinishContext(phase)
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
			if expire {
				if f.writes.Session == nil || f.writes.Session.Snapshot.Identity.NativeSessionID == nil || *f.writes.Session.Snapshot.Identity.NativeSessionID != native || f.writes.Session.Snapshot.Lifecycle != "archived" {
					t.Fatal("expiration did not preserve identity in its proposed archived snapshot")
				}
				f.SelectSessionWrite(t)
			}
			saved := f.data.Session.Snapshot
			if saved.Identity.NativeSessionID == nil || *saved.Identity.NativeSessionID != native || saved.Lifecycle != lifecycle {
				t.Fatal("terminal read regressed proposed identity", saved.Identity.NativeSessionID, saved.Lifecycle)
			}
			got, err := fixtureArchiveContent(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, nil)
			if err != nil || !bytes.Equal(got.Data, data) {
				t.Fatal("archive differs across relay instances", err)
			}
			if err := got.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, nil); err != nil {
				t.Fatal("original relay rejected identical archive retry", err)
			}
		})
	}
}
