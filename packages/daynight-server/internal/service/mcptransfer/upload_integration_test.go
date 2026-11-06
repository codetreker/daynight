package mcptransfer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/google/uuid"
)

func uploadFixture(t *testing.T) (lifecycleFixture, *Uploads, *attachmentservice.Attachments) {
	t.Helper()
	f := newFixture(t)
	a := attachmentservice.NewAttachments(f.db, f.db, f.files)
	return f, NewUploads(f.lifecycle, f.files, a), a
}

type committedCleanupFaultWriter struct {
	inner  store.AttachmentMutationWriter
	failAt int32
	calls  atomic.Int32
}

type uploadStageFailure struct {
	filestorage.Storage
	filestorage.TransferStorage
	filestorage.TransferAttachmentPublisher
	cause    error
	stagedID string
}

func (s *uploadStageFailure) PutTransfer(ctx context.Context, namespace filestorage.TransferNamespace, id string, content io.Reader) (filestorage.FileInfo, error) {
	info, err := s.TransferStorage.PutTransfer(ctx, namespace, id, content)
	if err != nil {
		return info, err
	}
	s.stagedID = id
	return info, s.cause
}

func (w *committedCleanupFaultWriter) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
	result, err := w.inner.WriteAttachmentMutation(ctx, fn)
	if err == nil && result.Outcome == store.TransactionCommitted && w.calls.Add(1) == w.failAt {
		return result, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CommitAttempted: true, CleanupFailed: true, Cause: errors.New("injected cleanup failure")}
	}
	return result, err
}

type uploadFailureWriter struct {
	inner   store.PrivateTransferWriter
	enabled atomic.Bool
	state   string
}

type uploadFailureDAO struct {
	store.PrivateTransferDAO
	owner *uploadFailureWriter
}

func (d uploadFailureDAO) Put(ctx context.Context, record model.PrivateTransfer, version int64) (model.PrivateTransfer, error) {
	if d.owner.enabled.Load() && record.State == d.owner.state {
		return model.PrivateTransfer{}, errors.New("injected private transfer update failure")
	}
	return d.PrivateTransferDAO.Put(ctx, record, version)
}

func (w *uploadFailureWriter) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error) {
	return w.inner.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { return fn(uploadFailureDAO{d, w}) })
}

type gatedUploadRead struct {
	filestorage.TransferStorage
	reads   atomic.Int32
	entered chan struct{}
	release chan struct{}
}

func (g *gatedUploadRead) OpenTransfer(ctx context.Context, n filestorage.TransferNamespace, id string) (filestorage.Object, error) {
	// Two objects are read for the whole-file hash before target writing starts.
	if g.reads.Add(1) == 3 {
		close(g.entered)
		select {
		case <-g.release:
		case <-ctx.Done():
			return filestorage.Object{}, ctx.Err()
		}
	}
	return g.TransferStorage.OpenTransfer(ctx, n, id)
}

func TestUploadAdmissionSurvivesAccessRevocation(t *testing.T) {
	f, s, _ := uploadFixture(t)
	ctx := t.Context()
	grant := uuid.NewString()
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES($1,$2,'test','{}','https://example.test/mcp','daynight:mcp',now(),now()+interval '1 hour')`, grant, f.actor.Principal.UserID); err != nil {
		t.Fatal(err)
	}
	newAccess := func() transfer.Actor {
		id := uuid.NewString()
		hash := sha256.Sum256([]byte(id))
		if _, err := f.db.Pool.Exec(ctx, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes')`, id, grant, f.actor.Principal.UserID, hash[:]); err != nil {
			t.Fatal(err)
		}
		return transfer.Actor{Principal: model.Principal{Kind: model.OAuthCredential, UserID: f.actor.Principal.UserID, CredentialID: id}, AuthorityKind: "oauth", AuthorityID: grant}
	}
	first, replacement := newAccess(), newAccess()
	id := uuid.NewString()
	runUpload(t, s, f, first, UploadInput{Action: "begin", TransferID: id, Path: "revoked-stream", ContentType: "text/plain"})
	for i, part := range []string{"first", "second"} {
		offset := "0"
		if i == 1 {
			offset = "5"
		}
		runUpload(t, s, f, first, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: offset, ContentBase64: base64.StdEncoding.EncodeToString([]byte(part))})
	}
	gate := &gatedUploadRead{TransferStorage: f.files, entered: make(chan struct{}), release: make(chan struct{})}
	s.files = gate
	type commitResult struct {
		data map[string]any
		err  error
	}
	result := make(chan commitResult, 1)
	go func() {
		data, err := s.Execute(ctx, first, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "11"})
		result <- commitResult{data, err}
	}()
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		close(gate.release)
		t.Fatal("commit did not reach the target stream")
	}
	_, err := f.db.Pool.Exec(ctx, `DELETE FROM oauth_access_tokens WHERE id=$1`, first.Principal.CredentialID)
	close(gate.release)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-result:
		if got.err != nil || got.data["writeOutcome"] != "confirmed" {
			t.Fatalf("admitted commit did not complete: %+v %v", got.data, got.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("commit did not terminate after access revocation")
	}
	if _, err := s.Execute(ctx, first, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "status", TransferID: id}); err == nil {
		t.Fatal("revoked access was accepted for a new request")
	}
	status := runUpload(t, s, f, replacement, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "cleanup_pending" || status["cleanupState"] != "pending" || status["writeOutcome"] != "confirmed" {
		t.Fatalf("replacement access did not recover commit: %+v", status)
	}
}

func TestUploadAdmissionSurvivesTaskDeletion(t *testing.T) {
	f, s, _ := uploadFixture(t)
	ctx := t.Context()
	id := uuid.NewString()
	runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "deleted-task", ContentType: "text/plain"})
	for i, part := range []string{"first", "second"} {
		offset := "0"
		if i == 1 {
			offset = "5"
		}
		runUpload(t, s, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: offset, ContentBase64: base64.StdEncoding.EncodeToString([]byte(part))})
	}
	gate := &gatedUploadRead{TransferStorage: f.files, entered: make(chan struct{}), release: make(chan struct{})}
	s.files = gate
	type commitResult struct {
		data map[string]any
		err  error
	}
	committed := make(chan commitResult, 1)
	go func() {
		data, err := s.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "11"})
		committed <- commitResult{data, err}
	}()
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		close(gate.release)
		t.Fatal("commit did not reach the target stream")
	}
	deleted := make(chan error, 1)
	go func() {
		_, err := f.db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, f.binding.TaskID)
		deleted <- err
	}()
	select {
	case err := <-deleted:
		if err != nil {
			close(gate.release)
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		close(gate.release)
		t.Fatal("task deletion waited for the content stream")
	}
	close(gate.release)
	select {
	case got := <-committed:
		if got.err != nil || got.data["writeOutcome"] != "confirmed" {
			t.Fatalf("admitted upload did not complete: %+v %v", got.data, got.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("commit did not terminate after task deletion")
	}
	if _, err := s.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "status", TransferID: id}); err == nil {
		t.Fatal("new request accessed deleted task")
	}
}

func runUpload(t *testing.T, s *Uploads, f lifecycleFixture, actor transfer.Actor, in UploadInput) map[string]any {
	t.Helper()
	result, err := s.Execute(t.Context(), actor, f.binding.ProjectID, f.binding.TaskID, in)
	if err != nil {
		t.Fatalf("%s: %v", in.Action, err)
	}
	return result
}

func verifyUploadBytes(t *testing.T, a *attachmentservice.Attachments, f lifecycleFixture, path string, expected []byte) {
	t.Helper()
	_, obj, err := a.Open(t.Context(), f.actor.Principal, f.binding.ProjectID, f.binding.TaskID, path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(obj.Body)
	closeErr := obj.Body.Close()
	if err != nil || closeErr != nil || !bytes.Equal(got, expected) {
		t.Fatalf("read uploaded bytes: size=%d expected=%d err=%v close=%v", len(got), len(expected), err, closeErr)
	}
}

func TestUploadCompleteReceiptsAndRecovery(t *testing.T) {
	f, s, attachments := uploadFixture(t)
	id := uuid.NewString()
	begin := UploadInput{Action: "begin", TransferID: id, Path: "nested/upload.bin", ContentType: "application/octet-stream"}
	for i := 0; i < 3; i++ {
		result := runUpload(t, s, f, f.actor, begin)
		if result["transferId"] != id || result["state"] != "receiving" || result["nextOffset"] != "0" {
			t.Fatalf("begin recovery: %+v", result)
		}
	}
	conflict := begin
	conflict.Path = "different.bin"
	if _, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, conflict); err == nil {
		t.Fatal("different begin binding accepted")
	}
	parts := [][]byte{bytes.Repeat([]byte{0x00, 0x7f, 0xff, 0x41}, MaxChunkBytes/4), []byte("second chunk\x00\xff")}
	all := bytes.Join(parts, nil)
	var offset int
	for _, part := range parts {
		chunk := UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: strconv.Itoa(offset), ContentBase64: base64.StdEncoding.EncodeToString(part), SHA256: digest(part)}
		result := runUpload(t, s, f, f.actor, chunk)
		if result["receipt"] != "accepted" || result["nextOffset"] != strconv.Itoa(offset+len(part)) || result["sha256"] != digest(part) {
			t.Fatalf("chunk receipt: %+v", result)
		}
		result = runUpload(t, s, f, f.actor, chunk)
		if result["receipt"] != "already_accepted" {
			t.Fatalf("duplicate receipt: %+v", result)
		}
		changed := chunk
		changed.ContentBase64 = base64.StdEncoding.EncodeToString([]byte("different"))
		changed.SHA256 = ""
		if _, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, changed); err == nil {
			t.Fatal("conflicting chunk identity accepted")
		}
		changed = chunk
		changed.ChunkID = uuid.NewString()
		if _, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, changed); err == nil {
			t.Fatal("overlapping offset accepted")
		}
		offset += len(part)
	}
	status := runUpload(t, s, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "receiving" || status["nextOffset"] != strconv.Itoa(len(all)) {
		t.Fatalf("status: %+v", status)
	}
	commit := UploadInput{Action: "commit", TransferID: id, TotalBytes: strconv.Itoa(len(all)), SHA256: digest([]byte("wrong"))}
	if _, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, commit); err == nil {
		t.Fatal("wrong whole-file hash accepted")
	}
	commit.SHA256 = digest(all)
	result := runUpload(t, s, f, f.actor, commit)
	if result["state"] != "committed" || result["writeOutcome"] != "confirmed" || result["sha256"] != digest(all) || result["totalBytes"] != strconv.Itoa(len(all)) || result["operationId"] == nil || result["attachment"] == nil {
		t.Fatalf("commit: %+v", result)
	}
	verifyUploadBytes(t, attachments, f, begin.Path, all)
	// The caller discards the original response and reconciles the same ID.
	status = runUpload(t, s, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "cleanup_pending" || status["cleanupState"] != "pending" || status["operationId"] != result["operationId"] || status["writeOutcome"] != "confirmed" {
		t.Fatalf("lost response reconciliation: %+v", status)
	}
	repeated, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, commit)
	if err == nil || repeated["operationId"] != result["operationId"] || repeated["writeOutcome"] != "confirmed" {
		t.Fatalf("second commit did not preserve original facts: %+v %v", repeated, err)
	}
	verifyUploadBytes(t, attachments, f, begin.Path, all)
}

func TestUploadEmptyAndInlineBoundary(t *testing.T) {
	f, s, attachments := uploadFixture(t)
	id := uuid.NewString()
	runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "empty", ContentType: "application/octet-stream"})
	result := runUpload(t, s, f, f.actor, UploadInput{Action: "commit", TransferID: id, TotalBytes: "0"})
	if result["sha256"] != digest(nil) || result["writeOutcome"] != "confirmed" {
		t.Fatalf("empty commit: %+v", result)
	}
	verifyUploadBytes(t, attachments, f, "empty", nil)
	inline := bytes.Repeat([]byte{0xff}, MaxChunkBytes)
	result = runUpload(t, s, f, f.actor, UploadInput{Action: "inline", Path: "inline", ContentType: "application/octet-stream", ContentBase64: base64.StdEncoding.EncodeToString(inline)})
	if result["writeOutcome"] != "confirmed" {
		t.Fatalf("inline: %+v", result)
	}
	verifyUploadBytes(t, attachments, f, "inline", inline)
	if _, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "inline", Path: "oversize", ContentType: "application/octet-stream", ContentBase64: base64.StdEncoding.EncodeToString(append(inline, 1))}); err == nil {
		t.Fatal("oversized inline accepted")
	}
}

func TestUploadOAuthAccessReplacement(t *testing.T) {
	f, s, _ := uploadFixture(t)
	ctx := t.Context()
	grant, otherGrant := uuid.NewString(), uuid.NewString()
	for _, id := range []string{grant, otherGrant} {
		if _, err := f.db.Pool.Exec(ctx, `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES($1,$2,'test','{}','https://example.test/mcp','daynight:mcp',now(),now()+interval '1 hour')`, id, f.actor.Principal.UserID); err != nil {
			t.Fatal(err)
		}
	}
	newAccess := func(grantID string) transfer.Actor {
		id := uuid.NewString()
		hash := sha256.Sum256([]byte(id))
		if _, err := f.db.Pool.Exec(ctx, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes')`, id, grantID, f.actor.Principal.UserID, hash[:]); err != nil {
			t.Fatal(err)
		}
		return transfer.Actor{Principal: model.Principal{Kind: model.OAuthCredential, UserID: f.actor.Principal.UserID, CredentialID: id}, AuthorityKind: "oauth", AuthorityID: grantID}
	}
	first, next, other := newAccess(grant), newAccess(grant), newAccess(otherGrant)
	id := uuid.NewString()
	runUpload(t, s, f, first, UploadInput{Action: "begin", TransferID: id, Path: "oauth", ContentType: "text/plain"})
	if _, err := f.db.Pool.Exec(ctx, `DELETE FROM oauth_access_tokens WHERE id=$1`, first.Principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	in := UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString([]byte("refreshed"))}
	for _, denied := range []transfer.Actor{first, other, f.actor} {
		if _, err := s.Execute(ctx, denied, f.binding.ProjectID, f.binding.TaskID, in); err == nil {
			t.Fatal("different or invalid authority accepted")
		}
	}
	runUpload(t, s, f, next, in)
	result := runUpload(t, s, f, next, UploadInput{Action: "commit", TransferID: id, TotalBytes: "9"})
	hash := sha256.Sum256([]byte("refreshed"))
	if result["sha256"] != hex.EncodeToString(hash[:]) {
		t.Fatalf("grant continuation: %+v", result)
	}
}

func TestUploadMetadataFailureRemainsUnknown(t *testing.T) {
	f, s, _ := uploadFixture(t)
	id := uuid.NewString()
	runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "metadata-failure", ContentType: "text/plain"})
	runUpload(t, s, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString([]byte("content"))})
	_, err := f.db.Pool.Exec(t.Context(), `CREATE FUNCTION reject_upload_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected metadata failure'; END $$; CREATE TRIGGER reject_upload_metadata BEFORE INSERT OR UPDATE ON task_attachments FOR EACH ROW EXECUTE FUNCTION reject_upload_metadata()`)
	if err != nil {
		t.Fatal(err)
	}
	commit := UploadInput{Action: "commit", TransferID: id, TotalBytes: "7"}
	result, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, commit)
	if err == nil || result["writeOutcome"] != "unknown" || result["operationId"] == nil {
		t.Fatalf("metadata failure: %+v %v", result, err)
	}
	status := runUpload(t, s, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "unknown" || status["writeOutcome"] != "unknown" || status["operationId"] != result["operationId"] || status["attachment"] != nil {
		t.Fatalf("unknown recovery: %+v", status)
	}
	if _, err = s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, commit); err == nil {
		t.Fatal("unknown commit was replayed")
	}
	address, err := attachmentcore.NewAddress(f.binding.ProjectID, f.binding.TaskID, "metadata-failure")
	if err != nil {
		t.Fatal(err)
	}
	verifyTarget := func() {
		t.Helper()
		object, err := f.files.Open(t.Context(), attachmentcore.Bucket, address.StoragePath)
		if err != nil {
			t.Fatalf("open published target: %v", err)
		}
		content, readErr := io.ReadAll(object.Body)
		closeErr := object.Body.Close()
		if readErr != nil || closeErr != nil || string(content) != "content" {
			t.Fatalf("published target content: %q, read=%v close=%v", content, readErr, closeErr)
		}
	}
	verifyTarget()
	aborted := runUpload(t, s, f, f.actor, UploadInput{Action: "abort", TransferID: id})
	if aborted["cleanupState"] != "pending" || aborted["writeOutcome"] != "unknown" || aborted["operationId"] != result["operationId"] {
		t.Fatalf("abort lost unknown facts: %+v", aborted)
	}
	if err := f.lifecycle.Maintain(t.Context()); err != nil {
		t.Fatalf("reclaim private namespace: %v", err)
	}
	status = runUpload(t, s, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "closed" || status["cleanupState"] != "complete" || status["writeOutcome"] != "unknown" || status["operationId"] != result["operationId"] || status["attachment"] != nil {
		t.Fatalf("cleanup lost unknown facts: %+v", status)
	}
	verifyTarget()
}

func TestUploadStagingFailureRecordsNotCommittedAndReclaimsPrivateFiles(t *testing.T) {
	f, uploads, attachments := uploadFixture(t)
	ctx := t.Context()
	const path = "existing-attachment"
	original := []byte("previous target")
	metadata, created, err := attachments.Put(ctx, f.actor.Principal, f.binding.ProjectID, f.binding.TaskID, path, "text/plain", bytes.NewReader(original))
	if err != nil || !created {
		t.Fatalf("seed attachment: %+v created=%v error=%v", metadata, created, err)
	}
	content := []byte("private upload content")
	id, chunkID := uuid.NewString(), uuid.NewString()
	runUpload(t, uploads, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: path, ContentType: "text/plain"})
	runUpload(t, uploads, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: chunkID, Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString(content)})
	var chunkObjectID string
	if err := f.db.Pool.QueryRow(ctx, `SELECT object_id::text FROM private_upload_chunks WHERE transfer_id=$1 AND chunk_id=$2`, id, chunkID).Scan(&chunkObjectID); err != nil {
		t.Fatal(err)
	}
	cause := errors.New("injected staging failure after private write")
	storage := &uploadStageFailure{Storage: f.files, TransferStorage: f.files, TransferAttachmentPublisher: f.files, cause: cause}
	uploads.attachments = attachmentservice.NewAttachments(f.db, f.db, storage)
	result, err := uploads.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: strconv.Itoa(len(content))})
	if !errors.Is(err, cause) || result["transferId"] != id || result["writeOutcome"] != "not_committed" || result["operationId"] == nil || storage.stagedID == "" {
		t.Fatalf("unpublished failure outcome: %+v %v", result, err)
	}
	status := runUpload(t, uploads, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "cleanup_pending" || status["cleanupState"] != "pending" || status["writeOutcome"] != "not_committed" || status["operationId"] != result["operationId"] || status["attachment"] != nil {
		t.Fatalf("failure receipt or cleanup barrier: %+v", status)
	}
	var state, from string
	var reserved int64
	if err := f.db.Pool.QueryRow(ctx, `SELECT state,cleanup_from_state,reserved_bytes FROM private_transfers WHERE id=$1`, id).Scan(&state, &from, &reserved); err != nil || state != "cleanup_pending" || from != "failed" || reserved != int64(2*len(content)) {
		t.Fatalf("failure cleanup state: state=%q from=%q reserved=%d error=%v", state, from, reserved, err)
	}
	verifyUploadBytes(t, attachments, f, path, original)
	current, object, err := attachments.Open(ctx, f.actor.Principal, f.binding.ProjectID, f.binding.TaskID, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := object.Body.Close(); err != nil || current != metadata {
		t.Fatalf("failed upload changed target metadata: %+v, %v", current, err)
	}
	namespace, err := filestorage.NewTransferNamespace(id)
	if err != nil {
		t.Fatal(err)
	}
	gate, err := f.files.AcquireGate(ctx, filestorage.PrivateGate, id)
	if err != nil {
		t.Fatal(err)
	}
	for _, objectID := range []string{chunkObjectID, storage.stagedID} {
		object, openErr := f.files.OpenTransfer(ctx, namespace, objectID)
		if openErr != nil {
			_ = gate.Close()
			t.Fatalf("private object before cleanup: %v", openErr)
		}
		data, readErr := io.ReadAll(object.Body)
		closeErr := object.Body.Close()
		if readErr != nil || closeErr != nil || !bytes.Equal(data, content) {
			_ = gate.Close()
			t.Fatalf("private object contents: %q, read=%v close=%v", data, readErr, closeErr)
		}
	}
	if err := gate.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.lifecycle.Maintain(ctx); err != nil {
		t.Fatalf("reclaim failed upload: %v", err)
	}
	status = runUpload(t, uploads, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "closed" || status["cleanupState"] != "complete" || status["writeOutcome"] != "not_committed" || status["operationId"] != result["operationId"] || status["attachment"] != nil {
		t.Fatalf("closed failure receipt: %+v", status)
	}
	if err := f.db.Pool.QueryRow(ctx, `SELECT reserved_bytes FROM private_transfers WHERE id=$1`, id).Scan(&reserved); err != nil || reserved != 0 {
		t.Fatalf("reservation after cleanup: %d %v", reserved, err)
	}
	gate, err = f.files.AcquireGate(ctx, filestorage.PrivateGate, id)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	for _, objectID := range []string{chunkObjectID, storage.stagedID} {
		object, err := f.files.OpenTransfer(ctx, namespace, objectID)
		if err == nil {
			_ = object.Body.Close()
			t.Fatal("private object survived cleanup")
		}
		if !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("private object cleanup: %v", err)
		}
	}
	verifyUploadBytes(t, attachments, f, path, original)
}

func TestUploadExpiredCommitLeaseNeverReplaysOrDeletesTarget(t *testing.T) {
	f, s, attachments := uploadFixture(t)
	previous := []byte("previous")
	runUpload(t, s, f, f.actor, UploadInput{Action: "inline", Path: "lease", ContentType: "text/plain", ContentBase64: base64.StdEncoding.EncodeToString(previous)})
	id := uuid.NewString()
	runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "lease", ContentType: "text/plain"})
	runUpload(t, s, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString([]byte("new data"))})
	total := int64(8)
	opID := uuid.NewString()
	data := encodeUpload(uploadData{NextOffset: total, OperationID: opID, TotalBytes: &total, SHA256: digest([]byte("new data")), WriteOutcome: "unknown"})
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE private_transfers SET state='committing',data=$2,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, id, data); err != nil {
		t.Fatal(err)
	}
	status := runUpload(t, s, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "unknown" || status["writeOutcome"] != "unknown" || status["operationId"] != opID || status["attachment"] != nil {
		t.Fatalf("expired lease status: %+v", status)
	}
	if _, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "8"}); err == nil {
		t.Fatal("expired commit replayed")
	}
	aborted := runUpload(t, s, f, f.actor, UploadInput{Action: "abort", TransferID: id})
	if aborted["cleanupState"] != "pending" || aborted["writeOutcome"] != "unknown" || aborted["operationId"] != opID {
		t.Fatalf("abort lost unknown facts: %+v", aborted)
	}
	if err := f.lifecycle.Maintain(t.Context()); err != nil {
		t.Fatalf("reclaim private namespace: %v", err)
	}
	status = runUpload(t, s, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "closed" || status["cleanupState"] != "complete" || status["writeOutcome"] != "unknown" || status["operationId"] != opID || status["attachment"] != nil {
		t.Fatalf("cleanup lost unknown facts: %+v", status)
	}
	verifyUploadBytes(t, attachments, f, "lease", previous)
}

func TestAdmittedUploadRenewalAndLateReceipt(t *testing.T) {
	for _, revoked := range []string{"credential", "task"} {
		t.Run(revoked, func(t *testing.T) {
			f := newFixture(t)
			r := openRecord(t, f)
			p, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			opID := uuid.NewString()
			data := encodeUpload(uploadData{OperationID: opID, WriteOutcome: "unknown"})
			if _, err = f.lifecycle.startAdmittedCommit(t.Context(), p, data); err != nil {
				t.Fatal(err)
			}
			if _, err = f.db.Pool.Exec(t.Context(), `UPDATE private_transfers SET lease_until=clock_timestamp()+interval '5 seconds' WHERE id=$1`, r.ID); err != nil {
				t.Fatal(err)
			}
			if revoked == "credential" {
				_, err = f.db.Pool.Exec(t.Context(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.actor.Principal.CredentialID)
			} else {
				_, err = f.db.Pool.Exec(t.Context(), `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, f.binding.TaskID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = f.lifecycle.keepAdmittedUpload(t.Context(), p, uuid.NewString()); err == nil {
				t.Fatal("different operation renewed the lease")
			}
			if err = f.lifecycle.keepAdmittedUpload(t.Context(), p, opID); err != nil {
				t.Fatalf("admitted operation renewal: %v", err)
			}
			var lease time.Time
			if err = f.db.Pool.QueryRow(t.Context(), `SELECT lease_until FROM private_transfers WHERE id=$1`, r.ID).Scan(&lease); err != nil || time.Until(lease) < 40*time.Second {
				t.Fatalf("lease was not extended: %v %v", lease, err)
			}
			if _, err = f.lifecycle.startAdmittedCommit(t.Context(), p, data); err == nil {
				t.Fatal("commit replay accepted")
			}
			wrong := encodeUpload(uploadData{OperationID: uuid.NewString(), WriteOutcome: "confirmed"})
			if _, err = f.lifecycle.FinishCommit(t.Context(), p, f.actor, r.ID, 0, "committed", wrong); err == nil {
				t.Fatal("different operation recorded a receipt")
			}
			confirmed := encodeUpload(uploadData{OperationID: opID, WriteOutcome: "confirmed"})
			result, err := f.lifecycle.FinishCommit(t.Context(), p, f.actor, r.ID, 0, "committed", confirmed)
			if err != nil || result.State != "committed" || transfer.OperationID(result.Data) != opID {
				t.Fatalf("late original receipt: %+v %v", result, err)
			}
			if err = f.lifecycle.keepAdmittedUpload(t.Context(), p, opID); err == nil {
				t.Fatal("completed operation renewed its lease")
			}
		})
	}
}

func TestAdmittedUploadDoesNotRenewExpiredOrCleaningCommit(t *testing.T) {
	for _, condition := range []string{"expired", "cleanup"} {
		t.Run(condition, func(t *testing.T) {
			f := newFixture(t)
			r := openRecord(t, f)
			p, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, r.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			opID := uuid.NewString()
			data := encodeUpload(uploadData{OperationID: opID, WriteOutcome: "unknown"})
			if _, err = f.lifecycle.startAdmittedCommit(t.Context(), p, data); err != nil {
				t.Fatal(err)
			}
			if condition == "expired" {
				_, err = f.db.Pool.Exec(t.Context(), `UPDATE private_transfers SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, r.ID)
			} else {
				_, err = f.lifecycle.RequestCleanup(t.Context(), f.actor, r.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = f.lifecycle.keepAdmittedUpload(t.Context(), p, opID); err == nil {
				t.Fatalf("%s commit renewed", condition)
			}
			if _, err = f.lifecycle.startAdmittedCommit(t.Context(), p, data); err == nil {
				t.Fatalf("%s commit replayed", condition)
			}
			confirmed := encodeUpload(uploadData{OperationID: opID, WriteOutcome: "confirmed"})
			result, err := f.lifecycle.FinishCommit(t.Context(), p, f.actor, r.ID, 0, "committed", confirmed)
			if err != nil {
				t.Fatalf("verified late receipt was rejected: %v", err)
			}
			if condition == "cleanup" {
				if result.State != "cleanup_pending" || result.CleanupFromState == nil || *result.CleanupFromState != "committed" {
					t.Fatalf("late receipt crossed cleanup barrier: %+v", result)
				}
			} else if result.State != "committed" {
				t.Fatalf("late receipt lost: %+v", result)
			}
		})
	}
}

func TestUploadConfirmedWhenCommittedTransactionCleanupFails(t *testing.T) {
	for _, action := range []string{"inline", "commit"} {
		t.Run(action, func(t *testing.T) {
			f, s, plainAttachments := uploadFixture(t)
			fault := &committedCleanupFaultWriter{inner: f.db, failAt: 1}
			if action == "commit" {
				fault.failAt = 2
			}
			s.attachments = attachmentservice.NewAttachments(f.db, fault, f.files)
			content := []byte("confirmed content")
			path := "confirmed-" + action
			id := uuid.NewString()
			input := UploadInput{Action: "inline", Path: path, ContentType: "text/plain", ContentBase64: base64.StdEncoding.EncodeToString(content)}
			if action == "commit" {
				runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: path, ContentType: "text/plain"})
				runUpload(t, s, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString(content)})
				input = UploadInput{Action: "commit", TransferID: id, TotalBytes: strconv.Itoa(len(content))}
			}
			result, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, input)
			if err == nil || result["writeOutcome"] != "confirmed" || result["attachment"] == nil || result["created"] != true {
				t.Fatalf("confirmed cleanup failure: %+v %v", result, err)
			}
			if item, ok := result["attachment"].(map[string]any); !ok || item["path"] != path || item["sizeBytes"] != strconv.Itoa(len(content)) {
				t.Fatalf("confirmed metadata: %+v", result["attachment"])
			}
			verifyUploadBytes(t, plainAttachments, f, path, content)
			if action == "commit" {
				status := runUpload(t, s, f, f.actor, UploadInput{Action: "status", TransferID: id})
				if status["writeOutcome"] != "confirmed" || status["attachment"] == nil || status["operationId"] != result["operationId"] {
					t.Fatalf("confirmed status: %+v", status)
				}
			}
		})
	}
}

func TestUploadConfirmedTargetWhenReceiptPersistenceFails(t *testing.T) {
	f, s, attachments := uploadFixture(t)
	id := uuid.NewString()
	content := []byte("published")
	runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "receipt-failure", ContentType: "text/plain"})
	runUpload(t, s, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString(content)})
	fault := &uploadFailureWriter{inner: f.lifecycle.db, state: "committed"}
	fault.enabled.Store(true)
	f.lifecycle.db = fault
	result, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: strconv.Itoa(len(content))})
	if err == nil || result["writeOutcome"] != "confirmed" || result["attachment"] == nil || result["created"] != true || result["operationId"] == nil {
		t.Fatalf("target confirmation lost: %+v %v", result, err)
	}
	verifyUploadBytes(t, attachments, f, "receipt-failure", content)
	status := runUpload(t, s, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["writeOutcome"] != "unknown" || status["attachment"] != nil || status["created"] != nil || status["operationId"] != result["operationId"] {
		t.Fatalf("status manufactured a durable receipt: %+v", status)
	}
}

type initialReadGate struct {
	filestorage.TransferStorage
	entered chan struct{}
}

func (g *initialReadGate) OpenTransfer(ctx context.Context, n filestorage.TransferNamespace, id string) (filestorage.Object, error) {
	close(g.entered)
	<-ctx.Done()
	return filestorage.Object{}, ctx.Err()
}

func TestUploadRenewalFailureBeforePublicationIsNotCommitted(t *testing.T) {
	f, s, attachments := uploadFixture(t)
	previous := []byte("previous")
	runUpload(t, s, f, f.actor, UploadInput{Action: "inline", Path: "renewal", ContentType: "text/plain", ContentBase64: base64.StdEncoding.EncodeToString(previous)})
	id := uuid.NewString()
	runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "renewal", ContentType: "text/plain"})
	runUpload(t, s, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString([]byte("new"))})
	gate := &initialReadGate{TransferStorage: f.files, entered: make(chan struct{})}
	s.files = gate
	fault := &uploadFailureWriter{inner: f.lifecycle.db, state: "receiving"}
	f.lifecycle.db = fault
	type commitResult struct {
		data map[string]any
		err  error
	}
	result := make(chan commitResult, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	go func() {
		data, err := s.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "3"})
		result <- commitResult{data, err}
	}()
	select {
	case <-gate.entered:
		fault.enabled.Store(true)
	case <-time.After(5 * time.Second):
		t.Fatal("commit did not begin reading")
	}
	select {
	case got := <-result:
		if got.err == nil || got.data["writeOutcome"] != "not_committed" || got.data["operationId"] != nil {
			t.Fatalf("renewal failure before publication: %+v %v", got.data, got.err)
		}
	case <-ctx.Done():
		t.Fatal("renewal failure did not cancel the commit")
	}
	fault.enabled.Store(false)
	status := runUpload(t, s, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "receiving" || status["writeOutcome"] != nil || status["operationId"] != nil {
		t.Fatalf("pre-publication status: %+v", status)
	}
	verifyUploadBytes(t, attachments, f, "renewal", previous)
}

type firstReadGate struct {
	filestorage.TransferStorage
	entered, release chan struct{}
	called           atomic.Bool
}

func (g *firstReadGate) OpenTransfer(ctx context.Context, n filestorage.TransferNamespace, id string) (filestorage.Object, error) {
	if g.called.CompareAndSwap(false, true) {
		close(g.entered)
		select {
		case <-g.release:
		case <-ctx.Done():
			return filestorage.Object{}, ctx.Err()
		}
	}
	return g.TransferStorage.OpenTransfer(ctx, n, id)
}

type observedPrivateGate struct {
	filestorage.Storage
	count  atomic.Int32
	second chan struct{}
}

func (g *observedPrivateGate) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	if domain == filestorage.PrivateGate && g.count.Add(1) == 2 {
		close(g.second)
	}
	return g.Storage.AcquireGate(ctx, domain, key)
}

func TestConcurrentCommitReturnsOriginalReceiptWithoutReplay(t *testing.T) {
	f, s, attachments := uploadFixture(t)
	id := uuid.NewString()
	content := []byte("concurrent")
	runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "concurrent", ContentType: "text/plain"})
	runUpload(t, s, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString(content)})
	read := &firstReadGate{TransferStorage: f.files, entered: make(chan struct{}), release: make(chan struct{})}
	gate := &observedPrivateGate{Storage: f.files, second: make(chan struct{})}
	s.files = read
	f.lifecycle.files = gate
	type commitResult struct {
		data map[string]any
		err  error
	}
	first, second := make(chan commitResult, 1), make(chan commitResult, 1)
	commit := func(result chan<- commitResult) {
		data, err := s.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: strconv.Itoa(len(content))})
		result <- commitResult{data, err}
	}
	go commit(first)
	select {
	case <-read.entered:
	case <-time.After(5 * time.Second):
		close(read.release)
		t.Fatal("first commit did not begin streaming")
	}
	go commit(second)
	select {
	case <-gate.second:
	case <-time.After(5 * time.Second):
		close(read.release)
		t.Fatal("second commit did not reach private gate")
	}
	close(read.release)
	var a, b commitResult
	select {
	case a = <-first:
	case <-time.After(10 * time.Second):
		t.Fatal("first commit did not finish")
	}
	select {
	case b = <-second:
	case <-time.After(10 * time.Second):
		t.Fatal("second commit did not finish")
	}
	if a.err != nil || a.data["writeOutcome"] != "confirmed" || a.data["operationId"] == nil {
		t.Fatalf("first commit: %+v %v", a.data, a.err)
	}
	if b.err == nil || b.data["writeOutcome"] != "confirmed" || b.data["operationId"] != a.data["operationId"] {
		t.Fatalf("second commit: %+v %v", b.data, b.err)
	}
	verifyUploadBytes(t, attachments, f, "concurrent", content)
}
