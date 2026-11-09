package session

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// The actual writer and filesystem locks prove that the public entrypoints can
// recover an interrupted active round before its transaction-only retirement guard.
func TestProductionHistoryRecoveryEntrypointsRetainLiveOwnersAndReapExitedOwners(t *testing.T) {
	for _, path := range []string{"grant", "bot grant", "prepare", "source tail"} {
		t.Run(path, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			f := newServiceFixture(t)
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			engine := core.NewEngine(files)
			defer engine.Stop(context.Background())
			service := New(f.db, engine)
			snapshot := f.registerWeb(t)
			var bot core.BotRegistrationResult
			if path == "bot grant" {
				f, bot = serviceBoundBot(t, f, files)
				service, snapshot = f.service, bot.Session
				native := "original-native"
				snapshot.Identity.NativeSessionID = &native
				raw, e := json.Marshal(snapshot)
				if e != nil {
					t.Fatal(e)
				}
				if _, e = f.db.Pool.Exec(ctx, `UPDATE task_sessions SET snapshot=$2 WHERE id=$1`, snapshot.SessionID, raw); e != nil {
					t.Fatal(e)
				}
			}
			identity := sp.ArchivePrepareRequest{Fence: snapshot.Fence, ControllerID: snapshot.Identity.ControllerID, ControllerInstanceID: snapshot.Identity.ControllerInstanceID}
			identityRaw, _ := json.Marshal(identity)
			ledger, _ := json.Marshal(map[string]any{"HistoryEpoch": snapshot.HistoryEpoch, "SourceThrough": "0", "Entries": []any{}, "Resources": []any{}})
			fileID, leaseID := uuid.NewString(), uuid.NewString()
			completion, err := f.db.WriteSession(ctx, func(scope store.SessionScope) error {
				dao := scope.SessionDAO().(store.SessionArchiveDAO)
				media := scope.SessionDAO().(store.SessionResourceDAO)
				if _, e := media.SessionResourceUsage(ctx, snapshot.SessionID); e != nil {
					return e
				}
				if e := dao.SaveSessionArchiveBundle(ctx, store.ArchiveBundle{SessionID: snapshot.SessionID, PrepareID: snapshot.Identity.ControllerInstanceID, Phase: "active", Revision: 1, Identity: identityRaw, Resources: json.RawMessage(`[]`), Ledger: ledger}); e != nil {
					return e
				}
				file := store.ArchiveBundleFile{SessionID: snapshot.SessionID, FileID: fileID, Purpose: "history", SHA256: strings.Repeat("a", 64), State: "receiving", ByteLength: 10, AcceptedOffset: 5, Path: "original/history", TimelineRevision: 1}
				if e := dao.SaveSessionArchiveFile(ctx, file); e != nil {
					return e
				}
				if e := dao.InsertSessionArchiveChunk(ctx, store.ArchiveBundleChunk{SessionID: snapshot.SessionID, FileID: fileID, ByteLength: 5, SHA256: strings.Repeat("b", 64), Path: "original/chunk"}); e != nil {
					return e
				}
				return media.AcquireSessionResourceLease(ctx, store.SessionResourceLease{SessionID: snapshot.SessionID, ID: leaseID, OwnerID: f.owner.UserID, Kind: "archive"})
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatal(completion, err)
			}
			gate, err := files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-resource-lease/"+leaseID)
			if err != nil {
				t.Fatal(err)
			}
			defer gate.Close()
			if path == "prepare" || path == "source tail" {
				if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET status='done' WHERE id=$1`, f.task); err != nil {
					t.Fatal(err)
				}
			}
			epoch := uuid.NewString()
			if path == "source tail" {
				if _, err = f.db.Pool.Exec(ctx, `UPDATE task_sessions SET source_epoch=$2,last_source_seq=0 WHERE id=$1`, snapshot.SessionID, epoch); err != nil {
					t.Fatal(err)
				}
			}
			previous := "1"
			grant := sp.Grant{Protocol: sp.Protocol, ClaimID: snapshot.ClaimID, TestExecutionID: snapshot.TestExecutionID, ControllerID: snapshot.Identity.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: snapshot.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
			call := func() error {
				switch path {
				case "grant":
					_, e := service.Grant(ctx, f.owner, f.project, f.task, snapshot.SessionID, grant)
					return e
				case "bot grant":
					_, e := service.GrantBot(ctx, f.owner, bot.Bot.WorkerID, bot.Bot.ID, core.BotGrant{BotVersion: bot.Bot.Version, NativeSessionID: snapshot.Identity.NativeSessionID, Grant: grant})
					return e
				default:
					reservation, e := service.TryReserveArchivePreflight()
					if e != nil {
						return e
					}
					op, e := service.BeginArchiveReserved(ctx, f.owner, f.project, f.task, snapshot.SessionID, core.ArchiveV1Upload, reservation)
					if e != nil {
						return e
					}
					if path == "prepare" {
						_, e = op.PrepareArchive(ctx, identity)
					} else {
						state, _ := json.Marshal(sp.State{InitialInputState: "not_submitted", Activity: "initializing"})
						_, e = op.AppendArchiveSourceTail(ctx, sp.ArchiveSourceTailRequest{Fence: snapshot.Fence, ControllerID: snapshot.Identity.ControllerID, ControllerInstanceID: snapshot.Identity.ControllerInstanceID, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: state}}})
					}
					return errors.Join(e, op.Close())
				}
			}
			var refusal *model.Fault
			if err = call(); !errors.As(err, &refusal) || refusal.Code != "archive_conflict" {
				t.Fatal("live physical owner was not retained", err)
			}
			observe := func(wantLeases int, wantState, wantGeneration string) {
				t.Helper()
				var count, chunks int
				var state, generation string
				var offset int64
				e := f.db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM session_resource_leases WHERE session_id=$1),f.state,f.accepted_offset,(SELECT count(*) FROM session_archive_chunks WHERE session_id=$1 AND file_id=$2),s.snapshot->>'executionGeneration' FROM session_archive_files f JOIN task_sessions s ON s.id=f.session_id WHERE f.session_id=$1 AND f.file_id=$2`, snapshot.SessionID, fileID).Scan(&count, &state, &offset, &chunks, &generation)
				if e != nil || count != wantLeases || state != wantState || offset != 5 || chunks != 1 || generation != wantGeneration {
					t.Fatalf("recovery altered live ownership or original round: leases=%d state=%s offset=%d chunks=%d generation=%s error=%v", count, state, offset, chunks, generation, e)
				}
			}
			observe(1, "receiving", "1")
			// Closing the only physical owner leaves the same durable crash-orphan row.
			if err = gate.Close(); err != nil {
				t.Fatal(err)
			}
			if err = call(); err != nil {
				t.Fatal("exited owner still blocks the first recovery operation", err)
			}
			generation := "1"
			if path == "grant" || path == "bot grant" {
				generation = "2"
			}
			observe(0, "failed", generation)
			var phase string
			if err = f.db.Pool.QueryRow(ctx, `SELECT phase FROM session_archive_bundles WHERE session_id=$1`, snapshot.SessionID).Scan(&phase); err != nil {
				t.Fatal(err)
			}
			expected := "active"
			if path == "prepare" || path == "source tail" {
				expected = "settling"
			}
			if phase != expected {
				t.Fatal("recovery did not advance archive owner", phase)
			}
		})
	}
}
