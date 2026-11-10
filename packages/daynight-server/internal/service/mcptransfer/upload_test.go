package mcptransfer

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/google/uuid"
)

type gatedUploadRead struct {
	filestorage.TransferStorage
	reads            atomic.Int32
	entered, release chan struct{}
}

func (g *gatedUploadRead) OpenTransfer(ctx context.Context, n filestorage.TransferNamespace, id string) (filestorage.Object, error) {
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

type uploadCallResult struct {
	data map[string]any
	err  error
}

func awaitUpload(t *testing.T, ch <-chan uploadCallResult) uploadCallResult {
	t.Helper()
	select {
	case result := <-ch:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not drain")
		return uploadCallResult{}
	}
}
func waitUpload(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not reach stream barrier")
	}
}
func oauthActor(h uploadHarness, grant string) Actor {
	return Actor{Principal: model.Principal{Kind: model.OAuthCredential, UserID: h.actor.Principal.UserID, CredentialID: uuid.NewString()}, AuthorityKind: "oauth", AuthorityID: grant}
}
func ownedUpload(r model.PrivateTransfer, a Actor) model.PrivateTransfer {
	r.UserID = a.Principal.UserID
	r.AuthorityKind = a.AuthorityKind
	r.AuthorityID = a.AuthorityID
	return r
}

func TestUploadAdmissionSurvivesAccessRevocation(t *testing.T) {
	h := newUploadHarness(t)
	a := oauthActor(h, uuid.NewString())
	replacement := oauthActor(h, a.AuthorityID)
	r := ownedUpload(h.record("revoked-stream", 11), a)
	parts := [][]byte{[]byte("first"), []byte("second")}
	chunks := h.seed(r, parts...)
	content := bytes.Join(parts, nil)
	plan, admission := h.commit(a, r, chunks, content, uploadAttachment(r, 11), true, nil, nil, nil)
	gate := &gatedUploadRead{TransferStorage: h.files, entered: make(chan struct{}), release: make(chan struct{})}
	h.uploads.files = gate
	result := make(chan uploadCallResult, 1)
	go func() {
		data, err := h.execute(a, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "11"})
		result <- uploadCallResult{data, err}
	}()
	waitUpload(t, gate.entered)
	close(gate.release)
	got := awaitUpload(t, result)
	if got.err != nil || got.data["writeOutcome"] != "confirmed" || admission.puts != 1 {
		t.Fatalf("admitted commit %+v %v", got.data, got.err)
	}
	pending := plan.pending()
	denied := errors.New("access revoked")
	h.lookup(a, pending, denied)
	if _, err := h.execute(a, UploadInput{Action: "status", TransferID: r.ID}); !errors.Is(err, denied) {
		t.Fatalf("new revoked request %v", err)
	}
	status := h.status(replacement, pending)
	if status["state"] != "cleanup_pending" || status["writeOutcome"] != "confirmed" || status["operationId"] != plan.operation {
		t.Fatalf("replacement access %+v", status)
	}
}
func TestUploadAdmissionSerializesTaskDeletion(t *testing.T) {
	h := newUploadHarness(t)
	r := h.record("deleted-task", 11)
	parts := [][]byte{[]byte("first"), []byte("second")}
	chunks := h.seed(r, parts...)
	plan, admission := h.commit(h.actor, r, chunks, bytes.Join(parts, nil), uploadAttachment(r, 11), true, nil, nil, nil)
	gate := &gatedUploadRead{TransferStorage: h.files, entered: make(chan struct{}), release: make(chan struct{})}
	h.uploads.files = gate
	result := make(chan uploadCallResult, 1)
	go func() {
		data, err := h.execute(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "11"})
		result <- uploadCallResult{data, err}
	}()
	waitUpload(t, gate.entered)
	if admission.puts != 1 || admission.closes != 0 {
		t.Errorf("admission scope ended before stream completed")
	}
	close(gate.release)
	got := awaitUpload(t, result)
	if got.err != nil || got.data["writeOutcome"] != "confirmed" {
		t.Fatalf("admitted deletion result %+v %v", got.data, got.err)
	}
	denied := model.ErrNotFound
	h.lookup(h.actor, plan.pending(), denied)
	if _, err := h.execute(h.actor, UploadInput{Action: "status", TransferID: r.ID}); err == nil {
		t.Fatal("new request accessed deleted Task")
	}
}
func TestUploadCompleteReceiptsAndRecovery(t *testing.T) {
	h := newUploadHarness(t)
	r := h.record("binary/combined.bin", 0)
	begin := UploadInput{Action: "begin", TransferID: r.ID, Path: r.Path, ContentType: r.ContentType}
	for i := 0; i < 3; i++ {
		h.begin(h.actor, r, i > 0)
		result := h.run(h.actor, begin)
		if result["transferId"] != r.ID || result["state"] != "receiving" || result["nextOffset"] != "0" || result["maxChunkBytes"] != MaxChunkBytes {
			t.Fatalf("begin recovery %+v", result)
		}
	}
	h.expect(get(r))
	conflict := begin
	conflict.Path = "different.bin"
	if _, err := h.execute(h.actor, conflict); err == nil {
		t.Fatal("conflicting begin accepted")
	}
	parts := [][]byte{bytes.Repeat([]byte{0x00, 0xff, 0x7f, 0x41}, (512<<10)/4), bytes.Repeat([]byte{0x80, 0x00, 0xfe}, 171)}
	all := bytes.Join(parts, nil)
	chunks := make([]model.UploadChunk, 0, 2)
	for _, part := range parts {
		in := UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: decimal(uploadNextOffset(r)), ContentBase64: base64.StdEncoding.EncodeToString(part), SHA256: digest(part)}
		next, receipt := h.planChunk(h.actor, r, in, part)
		result := h.run(h.actor, in)
		if result["receipt"] != "accepted" || result["nextOffset"] != decimal(uploadNextOffset(next)) || result["sha256"] != digest(part) {
			t.Fatalf("chunk receipt %+v", result)
		}
		r = next
		chunks = append(chunks, *receipt)
		r = h.replay(h.actor, r, in, *receipt)
		if result = h.run(h.actor, in); result["receipt"] != "already_accepted" {
			t.Fatalf("replay %+v", result)
		}
		changed := in
		changed.ContentBase64 = base64.StdEncoding.EncodeToString([]byte("different"))
		changed.SHA256 = ""
		r = h.replay(h.actor, r, changed, *receipt)
		if _, err := h.execute(h.actor, changed); err == nil {
			t.Fatal("conflicting chunk accepted")
		}
		changed = in
		changed.ChunkID = uuid.NewString()
		current := h.prepare(h.actor, r)
		h.missingReceipt(current, changed.ChunkID)
		r = current
		if _, err := h.execute(h.actor, changed); err == nil {
			t.Fatal("overlapping offset accepted")
		}
	}
	if status := h.status(h.actor, r); status["nextOffset"] != strconv.Itoa(len(all)) {
		t.Fatalf("status %+v", status)
	}
	current := h.prepare(h.actor, r)
	// Hash verification reads real private bytes before any reservation or publication.
	h.streamReads(current, chunks)
	admission := h.admission(h.actor, r, &uploadLease{}, chunks, all, uploadAttachment(r, int64(len(all))), true, nil)
	in := UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: strconv.Itoa(len(all)), SHA256: digest([]byte("wrong"))}
	if _, err := h.execute(h.actor, in); err == nil {
		t.Fatal("wrong whole-file hash accepted")
	}
	if admission.puts != 0 {
		t.Fatal("hash refusal published")
	}
	r = current
	plan, a := h.commit(h.actor, r, chunks, all, uploadAttachment(r, int64(len(all))), true, nil, nil, nil)
	a.effect = func(_ context.Context, b []byte) { h.target(r, b) }
	in.SHA256 = digest(all)
	result := h.run(h.actor, in)
	if result["state"] != "committed" || result["writeOutcome"] != "confirmed" || result["sha256"] != digest(all) || result["totalBytes"] != strconv.Itoa(len(all)) || result["operationId"] != plan.operation || result["attachment"] == nil {
		t.Fatalf("commit %+v", result)
	}
	h.verifyTarget(r, all)
	status := h.status(h.actor, plan.pending())
	if status["cleanupState"] != "pending" || status["operationId"] != plan.operation || status["writeOutcome"] != "confirmed" {
		t.Fatalf("reconcile %+v", status)
	}
	h.lookup(h.actor, plan.pending(), nil)
	repeated, err := h.execute(h.actor, in)
	if err == nil || repeated["operationId"] != plan.operation || repeated["writeOutcome"] != "confirmed" || a.puts != 1 {
		t.Fatalf("repeat %+v %v", repeated, err)
	}
	h.verifyTarget(r, all)
}
func TestUploadEmptyAndInlineBoundary(t *testing.T) {
	h := newUploadHarness(t)
	r := h.record("empty", 0)
	plan, a := h.commit(h.actor, r, nil, nil, uploadAttachment(r, 0), true, nil, nil, nil)
	result := h.run(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "0"})
	if result["sha256"] != digest(nil) || result["writeOutcome"] != "confirmed" || plan.operation == "" || a.puts != 1 {
		t.Fatalf("empty %+v", result)
	}
	inline := bytes.Repeat([]byte{0xff}, MaxChunkBytes)
	item := uploadAttachment(r, int64(len(inline)))
	item.Path = "inline"
	h.planInline(h.actor, "inline", inline, item, true, nil)
	if result = h.run(h.actor, UploadInput{Action: "inline", Path: "inline", ContentType: r.ContentType, ContentBase64: base64.StdEncoding.EncodeToString(inline)}); result["writeOutcome"] != "confirmed" {
		t.Fatalf("inline %+v", result)
	}
	if _, err := h.execute(h.actor, UploadInput{Action: "inline", Path: "oversize", ContentType: r.ContentType, ContentBase64: base64.StdEncoding.EncodeToString(append(inline, 1))}); err == nil {
		t.Fatal("oversized inline accepted")
	}
}
func TestUploadOAuthAccessReplacement(t *testing.T) {
	h := newUploadHarness(t)
	first := oauthActor(h, uuid.NewString())
	next := oauthActor(h, first.AuthorityID)
	other := oauthActor(h, uuid.NewString())
	r := ownedUpload(h.record("oauth", 0), first)
	content := []byte("refreshed")
	in := UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString(content)}
	for _, a := range []Actor{first, other, h.actor} {
		if a == first {
			h.lookup(a, r, errors.New("expired access"))
		} else {
			h.expect(get(r))
		}
		if _, err := h.execute(a, in); err == nil {
			t.Fatal("invalid authority accepted")
		}
	}
	r, receipt := h.planChunk(next, r, in, content)
	h.run(next, in)
	plan, _ := h.commit(next, r, []model.UploadChunk{*receipt}, content, uploadAttachment(r, 9), true, nil, nil, nil)
	result := h.run(next, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "9"})
	if result["sha256"] != digest(content) || result["operationId"] != plan.operation {
		t.Fatalf("grant continuation %+v", result)
	}
}
func TestUploadMetadataFailureRemainsUnknown(t *testing.T) {
	h := newUploadHarness(t)
	r := h.record("metadata-failure", 7)
	content := []byte("content")
	chunks := h.seed(r, content)
	cause := errors.New("metadata failure")
	plan, a := h.commit(h.actor, r, chunks, content, model.Attachment{}, false, &attachmentservice.FileEffectError{Cause: cause}, nil, nil)
	a.effect = func(_ context.Context, b []byte) { h.target(r, b) }
	in := UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "7"}
	result, err := h.execute(h.actor, in)
	if !errors.Is(err, cause) || result["writeOutcome"] != "unknown" || result["operationId"] != plan.operation {
		t.Fatalf("metadata failure %+v %v", result, err)
	}
	unknown := plan.finished()
	status := h.status(h.actor, unknown)
	if status["state"] != "unknown" || status["attachment"] != nil || status["operationId"] != plan.operation {
		t.Fatalf("unknown %+v", status)
	}
	h.lookup(h.actor, unknown, nil)
	if _, err := h.execute(h.actor, in); err == nil {
		t.Fatal("unknown commit replayed")
	}
	h.verifyTarget(r, content)
	pending := h.cleanup(h.actor, unknown)
	aborted := h.run(h.actor, UploadInput{Action: "abort", TransferID: r.ID})
	if aborted["writeOutcome"] != "unknown" || aborted["operationId"] != plan.operation {
		t.Fatalf("abort %+v", aborted)
	}
	closed := h.maintain(pending)
	if err := h.lifecycle.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	status = h.status(h.actor, closed)
	if status["cleanupState"] != "complete" || status["writeOutcome"] != "unknown" || status["attachment"] != nil {
		t.Fatalf("closed %+v", status)
	}
	h.verifyTarget(r, content)
}
func TestUploadStagingFailureRecordsNotCommittedAndReclaimsPrivateFiles(t *testing.T) {
	h := newUploadHarness(t)
	content := []byte("private upload content")
	r := h.record("existing-attachment", int64(len(content)))
	original := []byte("previous target")
	h.target(r, original)
	chunks := h.seed(r, content)
	cause := errors.New("staging failure after private write")
	plan, a := h.commit(h.actor, r, chunks, content, model.Attachment{}, false, cause, nil, nil)
	staged := uuid.NewString()
	a.effect = func(ctx context.Context, b []byte) {
		ns, _ := filestorage.NewTransferNamespace(r.ID)
		if _, err := h.files.PutTransfer(ctx, ns, staged, bytes.NewReader(b)); err != nil {
			t.Error(err)
		}
	}
	result, err := h.execute(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: decimal(int64(len(content)))})
	if !errors.Is(err, cause) || result["writeOutcome"] != "not_committed" || result["operationId"] != plan.operation {
		t.Fatalf("stage failure %+v %v", result, err)
	}
	pending := plan.pending()
	status := h.status(h.actor, pending)
	if status["state"] != "cleanup_pending" || status["writeOutcome"] != "not_committed" || pending.ReservedBytes != int64(2*len(content)) {
		t.Fatalf("failure receipt %+v", status)
	}
	h.verifyTarget(r, original)
	ns, _ := filestorage.NewTransferNamespace(r.ID)
	for _, id := range []string{chunks[0].ObjectID, staged} {
		obj, err := h.files.OpenTransfer(t.Context(), ns, id)
		if err != nil {
			t.Fatal(err)
		}
		b, e := io.ReadAll(obj.Body)
		e = errors.Join(e, obj.Body.Close())
		if e != nil || !bytes.Equal(b, content) {
			t.Fatalf("private object %q %v", b, e)
		}
	}
	closed := h.maintain(pending)
	if err := h.lifecycle.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	status = h.status(h.actor, closed)
	if status["state"] != "closed" || status["writeOutcome"] != "not_committed" || status["operationId"] != plan.operation {
		t.Fatalf("closed failure %+v", status)
	}
	for _, id := range []string{chunks[0].ObjectID, staged} {
		obj, err := h.files.OpenTransfer(t.Context(), ns, id)
		if err == nil {
			obj.Body.Close()
			t.Fatal("private object survived cleanup")
		}
		if !errors.Is(err, fs.ErrNotExist) {
			t.Fatal(err)
		}
	}
	h.verifyTarget(r, original)
}
func TestUploadExpiredCommitLeaseNeverReplaysOrDeletesTarget(t *testing.T) {
	h := newUploadHarness(t)
	r := h.record("lease", 8)
	original := []byte("previous")
	h.target(r, original)
	h.seed(r, []byte("new data"))
	total := int64(8)
	opID := uuid.NewString()
	r.State = "committing"
	expired := time.Now().Add(-time.Second)
	r.LeaseUntil = &expired
	r.Data = encodeUpload(uploadData{NextOffset: 8, OperationID: opID, TotalBytes: &total, SHA256: digest([]byte("new data")), WriteOutcome: "unknown"})
	unknown := cloneTransfer(r)
	unknown.Version++
	unknown.State = "unknown"
	unknown.LeaseUntil = nil
	h.lookup(h.actor, r, nil)
	h.expect(get(r), auth(h.actor, r, nil), get(r), uploadPut(t, r, unknown, func(p model.PrivateTransfer) {
		if !bytes.Equal(uploadJSON(t, p.Data), uploadJSON(t, unknown.Data)) {
			t.Error("unknown data changed")
		}
	}, nil))
	status := h.run(h.actor, UploadInput{Action: "status", TransferID: r.ID})
	if status["state"] != "unknown" || status["operationId"] != opID || status["attachment"] != nil {
		t.Fatalf("expired status %+v", status)
	}
	h.lookup(h.actor, unknown, nil)
	if _, err := h.execute(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "8"}); err == nil {
		t.Fatal("expired commit replayed")
	}
	pending := h.cleanup(h.actor, unknown)
	h.run(h.actor, UploadInput{Action: "abort", TransferID: r.ID})
	closed := h.maintain(pending)
	if err := h.lifecycle.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	status = h.status(h.actor, closed)
	if status["state"] != "closed" || status["operationId"] != opID || status["writeOutcome"] != "unknown" {
		t.Fatalf("cleanup %+v", status)
	}
	h.verifyTarget(r, original)
}

func TestAdmittedUploadRenewalAndLateReceipt(t *testing.T) {
	for _, revoked := range []string{"credential", "task"} {
		t.Run(revoked, func(t *testing.T) {
			h := newUploadHarness(t)
			r := h.record("file", 0)
			p := h.lifecycleFixture.permit(r)
			current := cloneTransfer(r)
			current.Version++
			opID := uuid.NewString()
			data := encodeUpload(uploadData{OperationID: opID, WriteOutcome: "unknown"})
			committing := cloneTransfer(current)
			committing.Version++
			committing.State = "committing"
			lease := time.Now().UTC().Add(5 * time.Second)
			committing.LeaseUntil = &lease
			committing.Data = append([]byte(nil), data...)
			h.expect(get(current), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), get(current), uploadPut(t, current, committing, func(got model.PrivateTransfer) {
				if !bytes.Equal(got.Data, data) || got.LeaseUntil == nil || time.Until(*got.LeaseUntil) < 50*time.Second {
					t.Errorf("start %+v", got)
				}
			}, nil))
			if _, err := h.lifecycle.startAdmittedCommit(t.Context(), p, data); err != nil {
				t.Fatal(err)
			}
			h.expect(get(committing), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID))
			if err := h.lifecycle.keepAdmittedUpload(t.Context(), p, uuid.NewString()); err == nil {
				t.Fatal("wrong operation renewed")
			}
			if revoked == "credential" {
				renewed := cloneTransfer(committing)
				renewed.Version++
				nextLease := time.Now().UTC().Add(time.Minute)
				renewed.LeaseUntil = &nextLease
				h.expect(get(committing), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), get(committing), uploadPut(t, committing, renewed, func(got model.PrivateTransfer) {
					if got.LeaseUntil == nil || time.Until(*got.LeaseUntil) < 40*time.Second || !bytes.Equal(got.Data, data) {
						t.Errorf("renewal %+v", got)
					}
				}, nil))
				if err := h.lifecycle.keepAdmittedUpload(t.Context(), p, opID); err != nil {
					t.Fatal(err)
				}
				committing = renewed
			} else {
				cause := model.ErrNotFound
				h.expect(get(committing), method("LockProjectLifecycle", nil, cause, r.ProjectID, r.TaskID))
				if err := h.lifecycle.keepAdmittedUpload(t.Context(), p, opID); err == nil {
					t.Fatal("deleted Task renewed")
				}
			}
			h.expect(get(committing), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID))
			if _, err := h.lifecycle.startAdmittedCommit(t.Context(), p, data); err == nil {
				t.Fatal("commit replay")
			}
			wrong := encodeUpload(uploadData{OperationID: uuid.NewString(), WriteOutcome: "confirmed"})
			h.expect(get(committing))
			if _, err := h.lifecycle.FinishCommit(t.Context(), p, h.actor, r.ID, 0, "committed", wrong); err == nil {
				t.Fatal("wrong receipt accepted")
			}
			confirmed := encodeUpload(uploadData{OperationID: opID, WriteOutcome: "confirmed"})
			finished := cloneTransfer(committing)
			finished.Version++
			finished.State = "committed"
			finished.LeaseUntil = nil
			finished.Data = append([]byte(nil), confirmed...)
			h.expect(get(committing), get(committing), uploadPut(t, committing, finished, func(got model.PrivateTransfer) {
				if !bytes.Equal(got.Data, confirmed) {
					t.Error("receipt data")
				}
			}, nil))
			result, err := h.lifecycle.FinishCommit(t.Context(), p, h.actor, r.ID, 0, "committed", confirmed)
			if err != nil || result.State != "committed" || transfer.OperationID(result.Data) != opID {
				t.Fatalf("late receipt %+v %v", result, err)
			}
			h.expect(get(finished), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID))
			if err := h.lifecycle.keepAdmittedUpload(t.Context(), p, opID); err == nil {
				t.Fatal("completed operation renewed")
			}
		})
	}
}
func TestAdmittedUploadDoesNotRenewExpiredOrCleaningCommit(t *testing.T) {
	for _, condition := range []string{"expired", "cleanup"} {
		t.Run(condition, func(t *testing.T) {
			h := newUploadHarness(t)
			r := h.record("file", 0)
			p := h.lifecycleFixture.permit(r)
			r.Version++
			opID := uuid.NewString()
			r.State = "committing"
			lease := time.Now().UTC().Add(-time.Second)
			r.LeaseUntil = &lease
			r.Data = encodeUpload(uploadData{OperationID: opID, WriteOutcome: "unknown"})
			if condition == "cleanup" {
				r.State = "cleanup_pending"
				from := "committing"
				r.CleanupFromState = &from
				r.LeaseUntil = nil
			}
			h.expect(get(r), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID))
			if err := h.lifecycle.keepAdmittedUpload(t.Context(), p, opID); err == nil {
				t.Fatal("invalid renewal")
			}
			h.expect(get(r), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID))
			if _, err := h.lifecycle.startAdmittedCommit(t.Context(), p, r.Data); err == nil {
				t.Fatal("commit replay")
			}
			after := cloneTransfer(r)
			after.Version++
			after.LeaseUntil = nil
			after.Data = encodeUpload(uploadData{OperationID: opID, WriteOutcome: "confirmed"})
			if condition == "cleanup" {
				from := "committed"
				after.CleanupFromState = &from
			} else {
				after.State = "committed"
			}
			h.expect(get(r), get(r), uploadPut(t, r, after, func(got model.PrivateTransfer) {
				if !bytes.Equal(got.Data, after.Data) || condition == "cleanup" && (got.CleanupFromState == nil || *got.CleanupFromState != "committed") {
					t.Errorf("late receipt %+v", got)
				}
			}, nil))
			result, err := h.lifecycle.FinishCommit(t.Context(), p, h.actor, r.ID, 0, "committed", after.Data)
			if err != nil || result.State != after.State {
				t.Fatalf("late receipt %+v %v", result, err)
			}
		})
	}
}
func TestUploadConfirmedWhenCommittedTransactionCleanupFails(t *testing.T) {
	for _, action := range []string{"inline", "commit"} {
		t.Run(action, func(t *testing.T) {
			h := newUploadHarness(t)
			content := []byte("confirmed content")
			r := h.record("confirmed-"+action, int64(len(content)))
			item := uploadAttachment(r, int64(len(content)))
			cause := errors.New("committed cleanup failure")
			failure := &attachmentservice.FileEffectError{Cause: &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CommitAttempted: true, CleanupFailed: true, Cause: cause}}
			in := UploadInput{Action: "inline", Path: r.Path, ContentType: r.ContentType, ContentBase64: base64.StdEncoding.EncodeToString(content)}
			var plan *commitPlan
			if action == "inline" {
				h.planInline(h.actor, r.Path, content, item, true, failure)
			} else {
				chunks := h.seed(r, content)
				plan, _ = h.commit(h.actor, r, chunks, content, item, true, failure, nil, nil)
				in = UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: decimal(int64(len(content)))}
			}
			result, err := h.execute(h.actor, in)
			if !errors.Is(err, cause) || result["writeOutcome"] != "confirmed" || result["attachment"] == nil || result["created"] != true {
				t.Fatalf("committed cleanup %+v %v", result, err)
			}
			wire := result["attachment"].(map[string]any)
			if wire["path"] != r.Path || wire["sizeBytes"] != decimal(int64(len(content))) {
				t.Fatalf("metadata %+v", wire)
			}
			if plan != nil {
				status := h.status(h.actor, plan.pending())
				if status["writeOutcome"] != "confirmed" || status["operationId"] != plan.operation || status["attachment"] == nil {
					t.Fatalf("receipt %+v", status)
				}
			}
		})
	}
}
func TestUploadConfirmedTargetWhenReceiptPersistenceFails(t *testing.T) {
	h := newUploadHarness(t)
	content := []byte("published")
	r := h.record("receipt-failure", int64(len(content)))
	chunks := h.seed(r, content)
	cause := errors.New("receipt persistence failed")
	plan, a := h.commit(h.actor, r, chunks, content, uploadAttachment(r, int64(len(content))), true, nil, cause, nil)
	a.effect = func(_ context.Context, b []byte) { h.target(r, b) }
	result, err := h.execute(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: decimal(int64(len(content)))})
	if !errors.Is(err, cause) || result["writeOutcome"] != "confirmed" || result["attachment"] == nil || result["created"] != true || result["operationId"] != plan.operation {
		t.Fatalf("confirmed target %+v %v", result, err)
	}
	h.verifyTarget(r, content)
	status := h.status(h.actor, plan.committing())
	if status["writeOutcome"] != "unknown" || status["attachment"] != nil || status["created"] != nil || status["operationId"] != plan.operation {
		t.Fatalf("manufactured durable receipt %+v", status)
	}
}

type initialReadGate struct {
	filestorage.TransferStorage
	entered chan struct{}
}

func (g *initialReadGate) OpenTransfer(ctx context.Context, _ filestorage.TransferNamespace, _ string) (filestorage.Object, error) {
	close(g.entered)
	<-ctx.Done()
	return filestorage.Object{}, ctx.Err()
}
func TestUploadRenewalFailureBeforePublicationIsNotCommitted(t *testing.T) {
	h := newUploadHarness(t)
	if h.uploads.renewalInterval != 20*time.Second {
		t.Fatalf("default renewal %s", h.uploads.renewalInterval)
	}
	h.uploads.renewalInterval = 100 * time.Millisecond
	r := h.record("renewal", 3)
	previous := []byte("previous")
	h.target(r, previous)
	chunks := h.seed(r, []byte("new"))
	current := h.prepare(h.actor, r)
	h.streamReads(current, chunks)
	cause := errors.New("renewal failed")
	h.expect(get(current), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), get(current), uploadPut(t, current, current, nil, cause))
	lease := &uploadLease{}
	a := h.admission(h.actor, r, lease, chunks, []byte("new"), uploadAttachment(r, 3), true, nil)
	gate := &initialReadGate{TransferStorage: h.files, entered: make(chan struct{})}
	h.uploads.files = gate
	result := make(chan uploadCallResult, 1)
	go func() {
		data, err := h.execute(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "3"})
		result <- uploadCallResult{data, err}
	}()
	waitUpload(t, gate.entered)
	got := awaitUpload(t, result)
	if !errors.Is(got.err, cause) || got.data["writeOutcome"] != "not_committed" || got.data["operationId"] != nil || a.puts != 0 {
		t.Fatalf("renewal failure %+v %v", got.data, got.err)
	}
	status := h.status(h.actor, current)
	if status["state"] != "receiving" || status["writeOutcome"] != nil || status["operationId"] != nil {
		t.Fatalf("prepublication %+v", status)
	}
	h.verifyTarget(r, previous)
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
func TestConcurrentCommitReturnsOriginalReceiptWithoutReplay(t *testing.T) {
	h := newUploadHarness(t)
	content := []byte("concurrent")
	r := h.record("concurrent", int64(len(content)))
	chunks := h.seed(r, content)
	plan, a := h.commit(h.actor, r, chunks, content, uploadAttachment(r, int64(len(content))), true, nil, nil, nil)
	a.effect = func(_ context.Context, b []byte) { h.target(r, b) }
	gate := &firstReadGate{TransferStorage: h.files, entered: make(chan struct{}), release: make(chan struct{})}
	h.uploads.files = gate
	in := UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: decimal(int64(len(content)))}
	first := make(chan uploadCallResult, 1)
	go func() { data, err := h.execute(h.actor, in); first <- uploadCallResult{data, err} }()
	waitUpload(t, gate.entered)
	// The second request stops at the independent lower-operation admission.
	ctx := context.WithValue(t.Context(), uploadRequestKey{}, "concurrent")
	step := get(plan.current)
	step.matchContext = func(ctx context.Context) bool { return ctx.Value(uploadRequestKey{}) == "concurrent" }
	h.expect(step, auth(h.actor, plan.current, nil))
	busy := &model.Fault{Code: "resource_busy", Message: "upload response is active"}
	h.lease(h.actor, busy)
	second, err := h.uploads.Execute(ctx, h.actor, r.ProjectID, r.TaskID, in)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_busy" || second["writeOutcome"] != "not_committed" {
		t.Fatalf("concurrent %+v %v", second, err)
	}
	close(gate.release)
	got := awaitUpload(t, first)
	if got.err != nil || got.data["writeOutcome"] != "confirmed" {
		t.Fatalf("first %+v %v", got.data, got.err)
	}
	h.lookup(h.actor, plan.pending(), nil)
	second, err = h.execute(h.actor, in)
	if err == nil || second["operationId"] != plan.operation || second["writeOutcome"] != "confirmed" || a.puts != 1 {
		t.Fatalf("second %+v %v", second, err)
	}
	h.verifyTarget(r, content)
}
