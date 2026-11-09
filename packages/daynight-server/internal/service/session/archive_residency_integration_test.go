package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestUnifiedArchiveAdoptsUnacknowledgedNativeIdentityAtomically(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	f := newServiceFixture(t)
	snapshot := f.registerWeb(t)
	if snapshot.Identity.NativeSessionID != nil {
		t.Fatal("fixture already acknowledged a native identity")
	}
	if _, e := f.db.Pool.Exec(ctx, `UPDATE tasks SET status='done' WHERE id=$1`, f.task); e != nil {
		t.Fatal(e)
	}
	files, e := local.New(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = files.Close() })
	engine := core.NewEngine(files)
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	service := New(f.db, engine)
	native := "native-created-after-last-ack"
	snapshot.Identity.NativeSessionID = &native
	body := prepareServiceArchive(t, ctx, service, f.owner, f.project, f.task, snapshot)
	for range 2 {
		if e = publishServiceArchive(ctx, service, f.owner, f.project, f.task, snapshot.SessionID, body); e != nil {
			t.Fatal("original disconnected archive or lost-response retry refused", e)
		}
		var observedNative, state, generation string
		if e = f.db.Pool.QueryRow(ctx, `SELECT s.snapshot->'identity'->>'nativeSessionId',a.state,s.snapshot->>'executionGeneration' FROM task_sessions s JOIN session_archives a ON a.session_id=s.id WHERE s.id=$1`, snapshot.SessionID).Scan(&observedNative, &state, &generation); e != nil {
			t.Fatal(e)
		}
		if observedNative != native || state != "ready" || generation != snapshot.ExecutionGeneration {
			t.Fatal("archive did not atomically retain its finalized native identity", observedNative, state, generation)
		}
	}
	manifest, e := sp.DecodeArchiveManifest(body)
	if e != nil {
		t.Fatal(e)
	}
	other := "another-native"
	for _, replacement := range []*string{nil, &other} {
		manifest.NativeSessionID = replacement
		changed, _ := json.Marshal(manifest)
		if e = publishServiceArchive(ctx, service, f.owner, f.project, f.task, snapshot.SessionID, changed); e == nil {
			t.Fatal("archive replaced or cleared an established native identity")
		}
	}
}

func TestStoppedSourceNativeAdoptionPreservesUnknownOperation(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	f := newServiceFixture(t)
	snapshot := f.registerWeb(t)
	epoch, operation, native := uuid.NewString(), uuid.NewString(), "native-created-after-last-ack"
	if _, e := f.db.Pool.Exec(ctx, `UPDATE tasks SET status='done' WHERE id=$1`, f.task); e != nil {
		t.Fatal(e)
	}
	if _, e := f.db.Pool.Exec(ctx, `UPDATE task_sessions SET source_epoch=$2,last_source_seq=0 WHERE id=$1`, snapshot.SessionID, epoch); e != nil {
		t.Fatal(e)
	}
	receipt, e := json.Marshal(sp.Operation{Fence: snapshot.Fence, Protocol: sp.Protocol, OperationID: operation, Kind: "send_message", State: "unknown"})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.db.Pool.Exec(ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,$3,'{}',$4,$5,'pat',$6)`, snapshot.SessionID, operation, []byte("original"), f.owner.UserID, f.owner.CredentialID, receipt); e != nil {
		t.Fatal(e)
	}
	files, e := local.New(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = files.Close() })
	engine := core.NewEngine(files)
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	service := New(f.db, engine)
	op, e := service.BeginArchive(ctx, f.owner, f.project, f.task, snapshot.SessionID, core.ArchiveV1Upload)
	if e != nil {
		t.Fatal(e)
	}
	defer func() {
		if e := op.Close(); e != nil {
			t.Error(e)
		}
	}()
	initial, _ := json.Marshal(sp.State{InitialInputState: "not_submitted", Activity: "initializing"})
	final, _ := json.Marshal(sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Activity: "working", Synchronized: true})
	in := sp.ArchiveSourceTailRequest{Fence: snapshot.Fence, ControllerID: snapshot.Identity.ControllerID, ControllerInstanceID: snapshot.Identity.ControllerInstanceID, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: initial}, {SourceSeq: "2", Kind: "state", Payload: final}}}
	for range 2 {
		if out, e := op.AppendArchiveSourceTail(ctx, in); e != nil || out.LastAckedSourceSeq != "2" {
			t.Fatal(out, e)
		}
		var observedNative, observedGeneration string
		var observedReceipt []byte
		var ack int64
		if e = f.db.Pool.QueryRow(ctx, `SELECT s.snapshot->'identity'->>'nativeSessionId',s.snapshot->>'executionGeneration',s.last_source_seq,o.receipt FROM task_sessions s JOIN session_operations o ON o.session_id=s.id WHERE s.id=$1 AND o.operation_id=$2`, snapshot.SessionID, operation).Scan(&observedNative, &observedGeneration, &ack, &observedReceipt); e != nil {
			t.Fatal(e)
		}
		var result sp.Operation
		if json.Unmarshal(observedReceipt, &result) != nil || observedNative != native || observedGeneration != snapshot.ExecutionGeneration || ack != 2 || result.OperationID != operation || result.Fence != snapshot.Fence || result.State != "unknown" {
			t.Fatal("source checkpoint resolved or replaced an unknown operation", observedNative, observedGeneration, ack, string(observedReceipt))
		}
	}
}

func TestArchiveResidencySharedRootAndSingleConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	f := newServiceFixture(t)
	snapshot := f.registerWeb(t)
	if _, err := f.db.Pool.Exec(ctx, `UPDATE tasks SET status='done' WHERE id=$1`, f.task); err != nil {
		t.Fatal(err)
	}
	// Choose a different owner that collides under the old 256-stripe hash.
	target := sha256.Sum256([]byte("session/archive/owner/" + f.owner.UserID))
	var otherID string
	for i := 1; i < 65536; i++ {
		candidate := fmt.Sprintf("00000000-0000-4000-8000-%012x", i)
		digest := sha256.Sum256([]byte("session/archive/owner/" + candidate))
		if digest[0] == target[0] && candidate != f.owner.UserID {
			otherID = candidate
			break
		}
	}
	if otherID == "" {
		t.Fatal("could not find stripe collision")
	}
	now := time.Now().UTC()
	tokenHash := sha256.Sum256([]byte(uuid.NewString()))
	user := testsupport.FixtureIdentitySession(t, f.db, model.User{ID: otherID, UniAuthID: uuid.NewString()}, model.Session{ID: uuid.NewString(), TokenHash: tokenHash[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	pat := uuid.NewString()
	hash := sha256.Sum256([]byte(pat))
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'archive owner',now(),now()+interval '1 day')`, pat, user.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	other := model.Principal{Kind: model.PATCredential, UserID: user.UserID, CredentialID: pat}
	reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	otherSession, err := f.service.RegisterTest(ctx, other, reg)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	firstFiles, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = firstFiles.Close() })
	secondFiles, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = secondFiles.Close() })
	gate := &serviceStorageBarrier{Storage: firstFiles, kind: "upload", manifestOnly: true, entered: make(chan struct{}), release: make(chan struct{})}
	released := false
	defer func() {
		if !released {
			close(gate.release)
		}
	}()
	cfg := f.db.Pool.Config().Copy()
	cfg.MaxConns = 1
	firstPool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(firstPool.Close)
	secondPool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(secondPool.Close)
	firstEngine := core.NewEngine(gate)
	secondEngine := core.NewEngine(secondFiles)
	t.Cleanup(func() { _ = firstEngine.Stop(context.Background()); _ = secondEngine.Stop(context.Background()) })
	first := New(&postgres.Store{Pool: firstPool}, firstEngine)
	second := New(&postgres.Store{Pool: secondPool}, secondEngine)
	data := prepareServiceArchive(t, ctx, first, f.owner, f.project, f.task, snapshot)
	result := make(chan error, 1)
	go func() {
		e := publishServiceArchive(ctx, first, f.owner, f.project, f.task, snapshot.SessionID, data)
		result <- e
	}()
	awaitBarrier(t, ctx, gate, result)
	prompt, end := context.WithTimeout(ctx, time.Second)
	defer end()
	_, err = first.BeginArchive(prompt, f.owner, f.project, f.task, snapshot.SessionID, core.ArchiveV1Upload)
	requireServiceError(t, err, "resource_busy")
	_, err = second.BeginArchive(prompt, f.owner, f.project, f.task, snapshot.SessionID, core.ArchiveV1Upload)
	requireServiceError(t, err, "resource_busy")
	otherOp, err := second.BeginArchive(prompt, other, "", "", otherSession.SessionID, core.ArchiveV1Upload)
	if err != nil {
		t.Fatalf("different owner rejected: %v", err)
	}
	if err = otherOp.Close(); err != nil {
		t.Fatal(err)
	}
	close(gate.release)
	released = true
	if err = <-result; err != nil {
		t.Fatalf("single-connection upload: %v", err)
	}
	retained, err := first.ArchiveContent(ctx, f.owner, f.project, f.task, snapshot.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err = retained.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestTerminalArchiveReadbackWithSingleConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	f := newServiceFixture(t)
	id, data := readyTerminalArchive(t, f)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	config := f.db.Pool.Config().Copy()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	engine := core.NewEngine(files)
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	service := New(&postgres.Store{Pool: pool}, engine)
	if _, err = service.PutTerminalArchive(ctx, f.owner, f.project, f.task, id, data); err != nil {
		t.Fatalf("upload and nested readback: %v", err)
	}
	content, err := service.TerminalArchiveContent(ctx, f.owner, f.project, f.task, id)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content.Data, data) {
		t.Fatal("archive bytes changed")
	}
	if err = content.Close(); err != nil {
		t.Fatal(err)
	}
}
