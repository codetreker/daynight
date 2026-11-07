package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type serviceStorageBarrier struct {
	filestorage.Storage
	kind             string
	entered, release chan struct{}
	once             sync.Once
}

func (s *serviceStorageBarrier) wait(ctx context.Context) error {
	s.once.Do(func() { close(s.entered) })
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *serviceStorageBarrier) Put(ctx context.Context, bucket, path string, body io.Reader) (filestorage.FileInfo, error) {
	if s.kind == "upload" {
		if err := s.wait(ctx); err != nil {
			return filestorage.FileInfo{}, err
		}
	}
	return s.Storage.Put(ctx, bucket, path, body)
}
func (s *serviceStorageBarrier) DeleteSessionArchives(ctx context.Context, n sessionarchive.Namespace) error {
	if s.kind == "delete" {
		if err := s.wait(ctx); err != nil {
			return err
		}
	}
	return s.Storage.DeleteSessionArchives(ctx, n)
}

func serviceBoundBot(t *testing.T, f serviceFixture, files filestorage.Storage) (serviceFixture, core.BotRegistrationResult) {
	t.Helper()
	ctx := context.Background()
	worker := f.registration.WorkerID
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{}')`, f.owner.UserID, worker); err != nil {
		t.Fatal(err)
	}
	config := model.BotConfiguration{WorkerID: worker, Cwd: "/ordinary/directory", Provider: "codex", Args: []string{}}
	bot, err := botservice.New(f.db).Create(ctx, f.owner, botcore.CreateBot{ID: uuid.NewString(), Name: "Assistant", Overrides: model.BotOverrides{WorkerID: &worker}, ResolvedConfiguration: config})
	if err != nil {
		t.Fatal(err)
	}
	engine := core.NewEngine(files)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := engine.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	f.service = New(f.db, engine)
	digest := sha256.Sum256([]byte("Use Daynight CLI."))
	input := core.BotRegistration{BotVersion: bot.Version, Configuration: config, RoleConfiguration: model.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: hex.EncodeToString(digest[:])}, Registration: sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}}
	out, err := f.service.RegisterBot(ctx, f.owner, worker, bot.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	return f, out
}
func serviceArchive(t *testing.T, v sp.Snapshot) []byte {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": "reasoning", "text": "local-only body"})
	entry, err := sp.DecodeTimeline(raw)
	if err != nil {
		t.Fatal(err)
	}
	doc := sp.ArchiveDocument{Fence: v.Fence, SchemaVersion: 1, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, Entries: []sp.TimelineEntry{entry}, Resources: []sp.ArchiveResource{}}
	data, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func serviceStopReceipt(out core.BotRegistrationResult, id string) botservice.BotDeletionReceipt {
	v := out.Session
	return botservice.BotDeletionReceipt{DeletionID: id, Result: model.BotCleanupResult{State: "completed"}, Stop: &sp.TestStop{Protocol: sp.Protocol, Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: v.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}}
}
func waitServiceBotLock(ctx context.Context, f serviceFixture) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		err := f.db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=current_database() AND a.wait_event_type='Lock' AND a.query LIKE 'SELECT id::text FROM bots WHERE id=%' AND l.relation='bots'::regclass)`).Scan(&waiting)
		if err != nil {
			return err
		}
		if waiting {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
func awaitBarrier(t *testing.T, ctx context.Context, gate *serviceStorageBarrier, result <-chan error) {
	t.Helper()
	select {
	case <-gate.entered:
	case err := <-result:
		t.Fatalf("operation did not reach storage barrier: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestProductionArchiveDeletionSerializesBothOrders(t *testing.T) {
	for _, ordering := range []string{"upload", "delete"} {
		t.Run(ordering, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			root := t.TempDir()
			files, err := local.New(root)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := files.Close(); err != nil {
					t.Error(err)
				}
			})
			gate := &serviceStorageBarrier{Storage: files, kind: ordering, entered: make(chan struct{}), release: make(chan struct{})}
			var released sync.Once
			release := func() { released.Do(func() { close(gate.release) }) }
			t.Cleanup(release)
			f := newServiceFixture(t)
			var out core.BotRegistrationResult
			if ordering == "upload" {
				f, out = serviceBoundBot(t, f, gate)
			} else {
				f, out = serviceBoundBot(t, f, files)
			}
			if _, err = f.db.Pool.Exec(ctx, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"archived"') WHERE id=$1`, out.Session.SessionID); err != nil {
				t.Fatal(err)
			}
			data := serviceArchive(t, out.Session)
			namespace, err := sessionarchive.NewNamespace(sessionarchive.Users, f.owner.UserID, out.Session.SessionID)
			if err != nil {
				t.Fatal(err)
			}
			otherNamespace, err := sessionarchive.NewNamespace(sessionarchive.Projects, f.project, uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			orphan := namespace.Directory() + "/orphan.json"
			otherPath := otherNamespace.Directory() + "/other.json"
			if _, err = files.Put(ctx, sessionarchive.Bucket, orphan, bytes.NewBufferString("orphan")); err != nil {
				t.Fatal(err)
			}
			if _, err = files.Put(ctx, sessionarchive.Bucket, otherPath, bytes.NewBufferString("other")); err != nil {
				t.Fatal(err)
			}
			receipt := serviceStopReceipt(out, uuid.NewString())
			request := store.DeleteBot{Version: out.Bot.Version, DeletionID: receipt.DeletionID}
			cleanupFiles := filestorage.Storage(files)
			if ordering == "delete" {
				cleanupFiles = gate
			}
			otherEngine := core.NewEngine(cleanupFiles)
			t.Cleanup(func() { _ = otherEngine.Stop(context.Background()) })
			deletion := botservice.NewDeletions(f.db, cleanupFiles, otherEngine)
			upload := make(chan error, 1)
			cleanup := make(chan error, 1)
			if ordering == "upload" {
				go func() {
					_, err := f.service.PutArchive(ctx, f.owner, "", "", out.Session.SessionID, data)
					upload <- err
				}()
				awaitBarrier(t, ctx, gate, upload)
				go func() { _, err := deletion.DeleteBot(ctx, f.owner, out.Bot.ID, request); cleanup <- err }()
				waitErr := waitServiceBotLock(ctx, f)
				release()
				if err := <-upload; err != nil {
					t.Fatal(err)
				}
				if err := <-cleanup; err != nil {
					t.Fatal(err)
				}
				if waitErr != nil {
					t.Fatal(waitErr)
				}
				var state string
				if err = f.db.Pool.QueryRow(ctx, `SELECT state FROM session_archives WHERE session_id=$1`, out.Session.SessionID).Scan(&state); err != nil || state != "ready" {
					t.Fatalf("archive not committed first: %s %v", state, err)
				}
				result, err := deletion.CompleteBotDeletion(ctx, f.owner, out.Bot.WorkerID, out.Bot.ID, receipt)
				if err != nil || result.Deletion.ServerCleanup.State != "completed" {
					t.Fatalf("cleanup: %+v %v", result, err)
				}
			} else {
				if _, err = deletion.DeleteBot(ctx, f.owner, out.Bot.ID, request); err != nil {
					t.Fatal(err)
				}
				_, err = f.service.PutArchive(ctx, f.owner, "", "", out.Session.SessionID, data)
				requireServiceError(t, err, "resource_conflict")
				go func() {
					result, err := deletion.CompleteBotDeletion(ctx, f.owner, out.Bot.WorkerID, out.Bot.ID, receipt)
					if err == nil && result.Deletion.ServerCleanup.State != "completed" {
						err = errors.New("cleanup did not complete")
					}
					cleanup <- err
				}()
				awaitBarrier(t, ctx, gate, cleanup)
				go func() {
					_, err := f.service.PutArchive(ctx, f.owner, "", "", out.Session.SessionID, data)
					upload <- err
				}()
				// A committed deletion may be rejected by the unlocked archive
				// preflight before the upload reaches the Bot lock. Either way,
				// deletion cleanup must finish without a late archive write.
				waitCtx, stopWait := context.WithCancel(ctx)
				waited := make(chan error, 1)
				go func() { waited <- waitServiceBotLock(waitCtx, f) }()
				var uploadErr, waitErr error
				var uploadFinished bool
				select {
				case uploadErr = <-upload:
					uploadFinished = true
				case waitErr = <-waited:
				case <-ctx.Done():
					waitErr = ctx.Err()
				}
				stopWait()
				release()
				cleanupErr := <-cleanup
				if !uploadFinished {
					uploadErr = <-upload
				}
				if waitErr != nil || cleanupErr != nil {
					t.Fatalf("delete-first ordering: wait=%v cleanup=%v", waitErr, cleanupErr)
				}
				requireServiceError(t, uploadErr, "resource_conflict")
			}
			if _, err = os.Stat(filepath.Join(root, sessionarchive.Bucket, namespace.Directory())); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("namespace retained: %v", err)
			}
			if b, err := os.ReadFile(filepath.Join(root, sessionarchive.Bucket, otherPath)); err != nil || string(b) != "other" {
				t.Fatalf("other namespace damaged: %q %v", b, err)
			}
			if _, err = f.service.PutArchive(ctx, f.owner, "", "", out.Session.SessionID, data); err == nil {
				t.Fatal("late retry rewrote cleaned namespace")
			}
			var count int
			if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM session_archives WHERE session_id=$1`, out.Session.SessionID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("metadata retained: %d %v", count, err)
			}
		})
	}
}

func TestProductionCrossInstanceDeletionCancelsPendingContent(t *testing.T) {
	f, out := serviceBoundBot(t, newServiceFixture(t), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	v := out.Session
	grant, err := f.service.GrantBot(ctx, f.owner, out.Bot.WorkerID, out.Bot.ID, core.BotGrant{BotVersion: out.Bot.Version, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "bootstrap"}})
	if err != nil {
		t.Fatal(err)
	}
	v, err = f.service.Connect(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, err = f.service.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	type readResult struct {
		page map[string]any
		err  error
	}
	read := make(chan readResult, 1)
	go func() {
		page, err := f.service.Timeline(ctx, f.owner, "", "", v.SessionID, "tail", "", 2)
		read <- readResult{page, err}
	}()
	var request map[string]any
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for request == nil {
		offers, err := f.service.Poll(ctx, v.ControllerFence)
		if err != nil {
			t.Fatal(err)
		}
		for _, offer := range offers {
			if offer["type"] == "content_request" {
				request = offer
				break
			}
		}
		if request == nil {
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-ticker.C:
			}
		}
	}
	otherEngine := core.NewEngine(nil)
	t.Cleanup(func() { _ = otherEngine.Stop(context.Background()) })
	deletion := botservice.NewDeletions(f.db, nil, otherEngine)
	deleted, err := deletion.DeleteBot(ctx, f.owner, out.Bot.ID, store.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()})
	if err != nil || deleted.Deletion == nil {
		t.Fatalf("other instance deletion: %+v %v", deleted, err)
	}
	result := &sp.ContentResult{Kind: "timeline", HistoryEpoch: v.HistoryEpoch, Items: []sp.TimelineEntry{}, Resources: []sp.Resource{}}
	_, err = f.service.Handle(ctx, sp.ControllerMessage{Type: "content_response", ControllerFence: v.ControllerFence, RequestID: request["requestId"].(string), SourceThrough: "0", ContentResult: result})
	requireServiceError(t, err, "resource_conflict")
	select {
	case got := <-read:
		requireServiceError(t, got.err, "resource_conflict")
		if got.page != nil {
			t.Fatal("deleted bot exposed a late page")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err = f.service.Poll(ctx, v.ControllerFence); err == nil {
		t.Fatal("revoked instance served cached controller")
	}
	if _, err = f.service.TestSnapshot(ctx, f.owner, v.SessionID); err == nil {
		t.Fatal("revoked instance served cached snapshot")
	}
}

func TestProductionDispatchAndReconcileRevalidateRevokedActor(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	v := f.connectWeb(t, f.registerWeb(t))
	native := "native"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, err := f.service.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	actorUser := testsupport.ServicePrincipal(t, f.db)
	actor := model.Principal{Kind: model.PATCredential, UserID: actorUser.UserID, CredentialID: uuid.NewString()}
	hash := sha256.Sum256([]byte(actor.CredentialID))
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'actor',now(),now()+interval '1 day')`, actor.CredentialID, actor.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, f.project, actor.UserID); err != nil {
		t.Fatal(err)
	}
	command := func() sp.Command {
		return sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: uuid.NewString(), OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hi"}],"expectedTurnId":null}`)}
	}
	first := command()
	if _, err := f.service.Submit(ctx, actor, f.project, f.task, v.SessionID, first); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, f.project, actor.UserID); err != nil {
		t.Fatal(err)
	}
	offers, err := f.service.Poll(ctx, v.ControllerFence)
	if err != nil || len(offers) != 0 {
		t.Fatalf("revoked command offered: %v %v", offers, err)
	}
	receipt, err := f.service.Operation(ctx, f.owner, f.project, f.task, v.SessionID, first.OperationID)
	if err != nil || receipt.State != "rejected" {
		t.Fatalf("poll rejection: %+v %v", receipt, err)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE project_grants SET role='admin' WHERE project_id=$1 AND user_id=$2`, f.project, actor.UserID); err != nil {
		t.Fatal(err)
	}
	second := command()
	if _, err = f.service.Submit(ctx, actor, f.project, f.task, v.SessionID, second); err != nil {
		t.Fatal(err)
	}
	offers, err = f.service.Poll(ctx, v.ControllerFence)
	if err != nil || len(offers) != 1 {
		t.Fatalf("offer: %v %v", offers, err)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, f.project, actor.UserID); err != nil {
		t.Fatal(err)
	}
	begin, err := f.service.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: second.OperationID})
	if err != nil || begin["type"] != "receipt_ack" {
		t.Fatalf("begin acknowledgement: %v %v", begin, err)
	}
	if result, ok := begin["operation"].(sp.Operation); !ok || result.State != "rejected" {
		t.Fatalf("revoked actor dispatched: %v", begin)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE project_grants SET role='admin' WHERE project_id=$1 AND user_id=$2`, f.project, actor.UserID); err != nil {
		t.Fatal(err)
	}
	third := command()
	if _, err = f.service.Submit(ctx, actor, f.project, f.task, v.SessionID, third); err != nil {
		t.Fatal(err)
	}
	offers, err = f.service.Poll(ctx, v.ControllerFence)
	if err != nil || len(offers) != 1 {
		t.Fatalf("reconcile offer: %v %v", offers, err)
	}
	grant, err := f.service.Grant(ctx, f.owner, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	var sourceEpoch string
	if err = f.db.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&sourceEpoch); err != nil {
		t.Fatal(err)
	}
	v, err = f.service.Connect(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", SourceEpoch: sourceEpoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Handle(ctx, sp.ControllerMessage{Type: "reconcile", ControllerFence: v.ControllerFence, Operations: []sp.Reconciliation{{OperationID: third.OperationID, State: "not_submitted"}}, Final: true}); err != nil {
		t.Fatal(err)
	}
	receipt, err = f.service.Operation(ctx, f.owner, f.project, f.task, v.SessionID, third.OperationID)
	if err != nil || receipt.State != "rejected" {
		t.Fatalf("reconcile rejection: %+v %v", receipt, err)
	}
}
