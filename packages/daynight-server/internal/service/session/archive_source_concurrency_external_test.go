package session_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
)

// Two independently admitted instances contend on the actual PostgreSQL
// Session lock, as when an old writer outlives its external permit.
func TestConcurrentStoppedTailAndRecoverySerializeOnSessionLock(t *testing.T) {
	for _, first := range []string{"old", "recovery"} {
		t.Run(first, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			db, owner, _, _, _ := archiveFixture(t)
			services := make([]*sessionservice.Service, 2)
			for i := range services {
				files, err := local.New(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
				engine := core.NewEngine(files)
				t.Cleanup(func() {
					if err := engine.Stop(context.Background()); err != nil {
						t.Error(err)
					}
					if err := files.Close(); err != nil {
						t.Error(err)
					}
				})
				services[i] = sessionservice.New(db, engine)
			}
			s := services[0]
			reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
			snapshot, err := s.RegisterTest(ctx, owner, reg)
			if err != nil {
				t.Fatal(err)
			}
			grant, err := s.Grant(ctx, owner, "", "", snapshot.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: reg.TestExecutionID, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, ExecutionGeneration: snapshot.ExecutionGeneration, Kind: "bootstrap"})
			if err != nil {
				t.Fatal(err)
			}
			epoch := uuid.NewString()
			conn, err := s.Connect(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, Provider: reg.Provider, SourceEpoch: epoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			if err = s.Disconnect(ctx, conn.ControllerFence); err != nil {
				t.Fatal(err)
			}
			stop := sp.TestStop{Protocol: sp.Protocol, Fence: snapshot.Fence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: reg.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
			if _, err = s.StopTest(ctx, owner, snapshot.SessionID, stop); err != nil {
				t.Fatal(err)
			}
			ops := make([]*core.ArchiveOperation, 2)
			for i := range ops {
				ops[i], err = services[i].BeginArchive(ctx, owner, "", "", snapshot.SessionID, core.ArchiveV1Upload)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if e := ops[i].Close(); e != nil {
						t.Error(e)
					}
				})
			}
			entry := uuid.NewString()
			oldBatch := uuid.NewString()
			recoveryID := uuid.NewString()
			oldEvent := sp.SourceEvent{SourceSeq: "1", Kind: "timeline_upsert", Payload: json.RawMessage(`{"kind":"reasoning","text":"source","revision":"1","entryId":"` + entry + `"}`)}
			original := sp.SourceEvent{SourceSeq: "1", Kind: "timeline_upsert", Payload: json.RawMessage(`{"entryId":"` + entry + `","revision":"1","kind":"reasoning","text":"source"}`)}
			tail := sp.ArchiveSourceTailRequest{Fence: snapshot.Fence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, SourceEpoch: epoch, BatchID: oldBatch, Events: []sp.SourceEvent{oldEvent}}
			recovery := sp.ArchiveSourceRecoveryRequest{Fence: snapshot.Fence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, SourceEpoch: epoch, OldBatchID: oldBatch, RecoveryID: recoveryID, Cutoff: "1", Events: []sp.SourceEvent{original}}
			lock, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Rollback(context.Background())
			if _, err = lock.Exec(ctx, `SELECT 1 FROM task_sessions WHERE id=$1 FOR UPDATE`, snapshot.SessionID); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 2)
			launch := func(kind string, op *core.ArchiveOperation) {
				go func() {
					if kind == "old" {
						_, e := op.AppendArchiveSourceTail(ctx, tail)
						result <- e
					} else {
						_, e := op.RecoverArchiveSourceTail(ctx, recovery)
						result <- e
					}
				}()
			}
			waitBlocked := func(want int) {
				t.Helper()
				deadline := time.Now().Add(8 * time.Second)
				for time.Now().Before(deadline) {
					var n int
					e := db.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM task_sessions WHERE id=%FOR UPDATE%'`).Scan(&n)
					if e != nil {
						t.Fatal(e)
					}
					if n >= want {
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
				t.Fatal("database operations did not reach the lock barrier", want)
			}
			second := "old"
			if first == "old" {
				second = "recovery"
			}
			launch(first, ops[0])
			waitBlocked(1)
			launch(second, ops[1])
			waitBlocked(2)
			if err = lock.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			a, b := <-result, <-result
			var fault *model.Fault
			if (a == nil) == (b == nil) {
				t.Fatalf("one operation must succeed: %v %v", a, b)
			}
			failure := a
			if failure == nil {
				failure = b
			}
			if !errors.As(failure, &fault) || fault.Code != "session_conflict" {
				t.Fatal("unexpected concurrent refusal", failure)
			}
			var sourceSeq int64
			var digest []byte
			var batches, receipts int
			err = db.Pool.QueryRow(ctx, `SELECT s.last_source_seq, (SELECT digest FROM session_source_hashes WHERE session_id=s.id AND source_epoch=$2 AND kind='event' AND identity='1'), (SELECT count(*) FROM session_source_hashes WHERE session_id=s.id AND source_epoch=$2 AND kind='batch' AND identity=$3), (SELECT count(*) FROM session_source_recoveries WHERE session_id=s.id AND recovery_id=$4) FROM task_sessions s WHERE s.id=$1`, snapshot.SessionID, epoch, oldBatch, recoveryID).Scan(&sourceSeq, &digest, &batches, &receipts)
			winner := original
			if first == "old" {
				winner = oldEvent
			}
			raw, _ := json.Marshal(winner)
			want := sha256.Sum256(raw)
			if err != nil || sourceSeq != 1 || string(digest) != string(want[:]) || batches != map[bool]int{true: 1, false: 0}[first == "old"] || receipts != map[bool]int{true: 0, false: 1}[first == "old"] {
				t.Fatal(fmt.Sprintf("wrong serialized result: seq=%d batch=%d recovery=%d", sourceSeq, batches, receipts), err)
			}
		})
	}
}
