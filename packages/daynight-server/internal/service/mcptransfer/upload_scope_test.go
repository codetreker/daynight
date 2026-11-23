package mcptransfer

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/google/uuid"
)

func (d *transferDAO) CurrentTransferAuthorization(ctx context.Context, principal model.Principal) (model.CredentialAuthorization, error) {
	value, err := d.call(ctx, "CurrentTransferAuthorization", "", principal)
	if value == nil {
		return model.CredentialAuthorization{}, err
	}
	return value.(model.CredentialAuthorization), err
}

// The scripted writer normally joins callback and completion errors. This
// wrapper models the store's single transaction error containing the callback
// refusal and its independently supplied completion facts.
type uploadScopeTransactionWriter struct{ *transferWriter }

func (w uploadScopeTransactionWriter) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error) {
	completion, err := w.transferWriter.WritePrivateTransfer(ctx, fn)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		return completion, err
	}
	var tx *store.TransactionError
	var fault *model.Fault
	if !errors.As(err, &tx) || !errors.As(err, &fault) {
		return completion, err
	}
	copy := *tx
	copy.Cause = fault
	return completion, &copy
}

func uploadPolicy(t *testing.T, principal model.Principal, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	ids, err := scopepolicy.Normalize(scopepolicy.PAT, ids)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestScopedUploadEntryRequiresMatchingAuthority(t *testing.T) {
	h := newUploadHarness(t)
	request := UploadInput{Action: "status", TransferID: h.binding.ID}
	auth := uploadPolicy(t, h.actor.Principal, "attachment:upload")
	var unavailable *Uploads
	if _, err := unavailable.Execute(t.Context(), h.actor, h.binding.ProjectID, h.binding.TaskID, request); err == nil {
		t.Fatal("nil legacy service accepted")
	}
	if _, err := unavailable.ExecuteScoped(t.Context(), auth, h.actor, h.binding.ProjectID, h.binding.TaskID, request); err == nil {
		t.Fatal("nil scoped service accepted")
	}
	if _, err := h.uploads.ExecuteScoped(t.Context(), auth, h.actor, h.binding.ProjectID, h.binding.TaskID, request); err == nil {
		t.Fatal("legacy service accepted scoped entry")
	}
	h.lifecycle.scoped = true
	h.uploads.scopedAttachments = &attachmentservice.ScopedAttachments{}
	if _, err := h.uploads.Execute(t.Context(), h.actor, h.binding.ProjectID, h.binding.TaskID, request); err == nil {
		t.Fatal("scoped service accepted unscoped entry")
	}
	invalid := auth
	invalid.Policy = nil
	if _, err := h.uploads.ExecuteScoped(t.Context(), invalid, h.actor, h.binding.ProjectID, h.binding.TaskID, request); err == nil {
		t.Fatal("missing policy accepted")
	}
	other := h.actor
	other.Principal.CredentialID = uuid.NewString()
	if _, err := h.uploads.ExecuteScoped(t.Context(), auth, other, h.binding.ProjectID, h.binding.TaskID, request); err == nil {
		t.Fatal("different credential accepted")
	}
	other = h.actor
	other.AuthorityKind = "oauth"
	if _, err := h.uploads.ExecuteScoped(t.Context(), auth, other, h.binding.ProjectID, h.binding.TaskID, request); err == nil {
		t.Fatal("mismatched authority profile accepted")
	}
}

func TestScopedUploadRefusalAndCleanup(t *testing.T) {
	h := newUploadHarness(t)
	h.lifecycle.scoped = true
	h.uploads.scopedAttachments = &attachmentservice.ScopedAttachments{}
	r := h.record("file", 0)
	readOnly := uploadPolicy(t, h.actor.Principal, "attachment:read")
	h.expect(get(r), auth(h.actor, r, nil), method("CurrentTransferAuthorization", readOnly, nil, h.actor.Principal))
	result, err := h.uploads.ExecuteScoped(t.Context(), readOnly, h.actor, r.ProjectID, r.TaskID, UploadInput{Action: "begin", TransferID: r.ID, Path: r.Path, ContentType: r.ContentType})
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || result != nil {
		t.Fatalf("begin result=%v err=%v", result, err)
	}
	// Cleanup keeps the original authority check even when upload permission was removed.
	pending := h.cleanup(h.actor, r)
	result, err = h.uploads.ExecuteScoped(t.Context(), readOnly, h.actor, r.ProjectID, r.TaskID, UploadInput{Action: "abort", TransferID: r.ID})
	if err != nil || result["state"] != pending.State || result["attachment"] != nil {
		t.Fatalf("cleanup result=%v err=%v", result, err)
	}
	h.lookup(h.actor, r, nil)
	if _, err := h.uploads.boundForCleanup(t.Context(), h.actor, uuid.NewString(), r.TaskID, r.ID); !errors.Is(err, transfer.ErrConflict) {
		t.Fatalf("wrong target cleanup: %v", err)
	}
	h.expect(getMissing(r.ID))
	if _, err := h.uploads.boundForCleanup(t.Context(), h.actor, r.ProjectID, r.TaskID, r.ID); err == nil {
		t.Fatal("missing cleanup target accepted")
	}
}

func TestScopedUploadRetryRefusalDoesNotClaimPriorOutcome(t *testing.T) {
	for _, state := range []string{"committed", "unknown"} {
		for _, action := range []string{"begin", "chunk", "commit"} {
			t.Run(state+"/"+action, func(t *testing.T) {
				h := newUploadHarness(t)
				h.lifecycle.scoped = true
				h.uploads.scopedAttachments = &attachmentservice.ScopedAttachments{}
				r := h.record("file", 1)
				r.State = state
				item, created := uploadAttachment(r, 1), true
				outcome := "unknown"
				if state == "committed" {
					outcome = "confirmed"
				}
				r.Data = encodeUpload(uploadData{NextOffset: 1, OperationID: uuid.NewString(), WriteOutcome: outcome, Attachment: &item, Created: &created})
				readOnly := uploadPolicy(t, h.actor.Principal, "attachment:read")
				h.expect(get(r), auth(h.actor, r, nil), method("CurrentTransferAuthorization", readOnly, nil, h.actor.Principal))
				input := UploadInput{Action: action, TransferID: r.ID, Path: r.Path, ContentType: r.ContentType, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", TotalBytes: "1"}
				result, err := h.uploads.ExecuteScoped(t.Context(), readOnly, h.actor, r.ProjectID, r.TaskID, input)
				if !errors.Is(err, scopepolicy.ErrInsufficientScope) || result != nil {
					t.Fatalf("retry disclosed or misclassified old outcome: result=%v err=%v", result, err)
				}
			})
		}
	}
}

func TestScopedCommitRefusalAfterWaitingDoesNotClassifyConcurrentResult(t *testing.T) {
	for _, state := range []string{"committed", "unknown"} {
		t.Run(state, func(t *testing.T) {
			h := newUploadHarness(t)
			h.lifecycle.scoped = true
			h.uploads.scopedAttachments = &attachmentservice.ScopedAttachments{}
			receiving := h.record("file", 1)
			previous := cloneTransfer(receiving)
			previous.State = state
			allowed := uploadPolicy(t, h.actor.Principal, "attachment:upload")
			readOnly := uploadPolicy(t, h.actor.Principal, "attachment:read")
			h.expect(get(receiving), auth(h.actor, receiving, nil), method("CurrentTransferAuthorization", allowed, nil, h.actor.Principal))
			h.expect(get(previous), auth(h.actor, previous, nil), method("CurrentTransferAuthorization", readOnly, nil, h.actor.Principal))
			entered, release := make(chan struct{}), make(chan struct{})
			lease := &uploadLease{}
			h.lower.leases = append(h.lower.leases, func(ctx context.Context, p model.Principal, project, task string) (io.Closer, error) {
				if p != h.actor.Principal || project != receiving.ProjectID || task != receiving.TaskID {
					t.Error("upload lease lost its target")
				}
				close(entered)
				select {
				case <-release:
					return lease, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			})
			results := make(chan uploadCallResult, 1)
			go func() {
				data, err := h.uploads.ExecuteScoped(t.Context(), allowed, h.actor, receiving.ProjectID, receiving.TaskID, UploadInput{Action: "commit", TransferID: receiving.ID, TotalBytes: "1"})
				results <- uploadCallResult{data, err}
			}()
			waitUpload(t, entered)
			close(release)
			got := awaitUpload(t, results)
			if !errors.Is(got.err, scopepolicy.ErrInsufficientScope) || got.data != nil || lease.count() != 1 {
				t.Fatalf("waiting retry result=%v err=%v lease closes=%d", got.data, got.err, lease.count())
			}
		})
	}
}

func TestNewChunkScopeRefusalRequiresReliableCompletion(t *testing.T) {
	for _, tc := range []struct {
		name       string
		outcome    store.TransactionOutcome
		cleanup    bool
		gateFailed bool
		want       string
	}{
		{"rolled back", store.TransactionNotCommitted, false, false, "not_committed"},
		{"unknown", store.TransactionUnknown, false, false, ""},
		{"transaction cleanup failure", store.TransactionNotCommitted, true, false, ""},
		{"permit cleanup failure", store.TransactionNotCommitted, false, true, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newUploadHarness(t)
			h.lifecycle.scoped = true
			h.lifecycle.db = uploadScopeTransactionWriter{h.db}
			h.uploads.scopedAttachments = &attachmentservice.ScopedAttachments{}
			counted := &countedUploadStorage{TransferStorage: h.files}
			h.uploads.files = counted
			if tc.gateFailed {
				h.lifecycle.files = uploadGateCloseError{Storage: h.files, cause: errors.New("permit cleanup failed")}
			}
			r := h.record("file", 0)
			allowed := uploadPolicy(t, h.actor.Principal, "attachment:upload")
			readOnly := uploadPolicy(t, h.actor.Principal, "attachment:read")
			input := UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="}
			h.expect(get(r), auth(h.actor, r, nil), method("CurrentTransferAuthorization", allowed, nil, h.actor.Principal))
			h.lease(h.actor, nil)
			renewed := cloneTransfer(r)
			renewed.Version++
			h.expect(get(r), auth(h.actor, r, nil), method("CurrentTransferAuthorization", allowed, nil, h.actor.Principal), get(r), uploadPut(t, r, renewed, nil, nil))
			h.expect(get(renewed))
			missing := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
			h.db.expect(store.Completion{Outcome: store.TransactionNotCommitted}, missing, get(renewed), auth(h.actor, renewed, nil), method("CurrentTransferAuthorization", allowed, nil, h.actor.Principal), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), method("UploadChunk", nil, model.ErrNotFound, r.ID, input.ChunkID))
			reserved := h.reserve(renewed, 1)
			failure := &store.TransactionError{Phase: "operation", Outcome: tc.outcome, CleanupFailed: tc.cleanup}
			h.db.expect(store.Completion{Outcome: tc.outcome}, failure, get(reserved), auth(h.actor, reserved, nil), method("CurrentTransferAuthorization", readOnly, nil, h.actor.Principal))
			result, err := h.uploads.ExecuteScoped(t.Context(), allowed, h.actor, r.ProjectID, r.TaskID, input)
			if !errors.Is(err, scopepolicy.ErrInsufficientScope) || result["writeOutcome"] != tc.want && !(tc.want == "" && result["writeOutcome"] == nil) || counted.puts.Load() != 0 {
				t.Fatalf("result=%v err=%v file writes=%d", result, err, counted.puts.Load())
			}
		})
	}
}

func TestChunkScopeRefusalBeforeReceiptDoesNotAssertOutcome(t *testing.T) {
	h := newUploadHarness(t)
	h.lifecycle.scoped = true
	h.lifecycle.db = uploadScopeTransactionWriter{h.db}
	h.uploads.scopedAttachments = &attachmentservice.ScopedAttachments{}
	r := h.record("file", 0)
	allowed := uploadPolicy(t, h.actor.Principal, "attachment:upload")
	readOnly := uploadPolicy(t, h.actor.Principal, "attachment:read")
	input := UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="}
	h.expect(get(r), auth(h.actor, r, nil), method("CurrentTransferAuthorization", allowed, nil, h.actor.Principal))
	h.lease(h.actor, nil)
	renewed := cloneTransfer(r)
	renewed.Version++
	h.expect(get(r), auth(h.actor, r, nil), method("CurrentTransferAuthorization", allowed, nil, h.actor.Principal), get(r), uploadPut(t, r, renewed, nil, nil))
	h.expect(get(renewed))
	h.db.expect(store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted}, get(renewed), auth(h.actor, renewed, nil), method("CurrentTransferAuthorization", readOnly, nil, h.actor.Principal))
	result, err := h.uploads.ExecuteScoped(t.Context(), allowed, h.actor, r.ProjectID, r.TaskID, input)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || result != nil {
		t.Fatalf("unobserved receipt was classified: result=%v err=%v", result, err)
	}
}

func TestUploadReceiptRequiresCurrentReadPermission(t *testing.T) {
	h := newUploadHarness(t)
	h.lifecycle.scoped = true
	h.uploads.scopedAttachments = &attachmentservice.ScopedAttachments{}
	r := h.record("file", 1)
	item, created := uploadAttachment(r, 1), true
	r.Data = encodeUpload(uploadData{NextOffset: 1, WriteOutcome: "confirmed", Attachment: &item, Created: &created})
	for _, tc := range []struct {
		name    string
		scopes  []scopepolicy.ScopeID
		allowed bool
	}{
		{"upload only", []scopepolicy.ScopeID{"attachment:upload"}, false},
		{"read", []scopepolicy.ScopeID{"attachment:read"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			current := uploadPolicy(t, h.actor.Principal, tc.scopes...)
			h.expect(get(r), auth(h.actor, r, nil), method("CurrentTransferAuthorization", current, nil, h.actor.Principal))
			got, err := h.uploads.authorizedUploadResult(t.Context(), h.actor, r)
			if tc.allowed {
				if err != nil || got["attachment"] == nil || got["writeOutcome"] != "confirmed" {
					t.Fatalf("allowed receipt=%v err=%v", got, err)
				}
			} else if !errors.Is(err, scopepolicy.ErrInsufficientScope) || got["attachment"] != nil || got["writeOutcome"] != "" {
				t.Fatalf("denied receipt=%v err=%v", got, err)
			}
		})
	}
	r.Data = []byte("not json")
	if _, err := h.uploads.authorizedUploadResult(t.Context(), h.actor, r); err == nil {
		t.Fatal("invalid durable receipt accepted")
	}
}

func TestUploadPublicationRejectsInvalidTransactionAuthority(t *testing.T) {
	h := newUploadHarness(t)
	r := h.record("file", 0)
	if err := authorizeUploadPublication(t.Context(), nil, h.actor, r.ProjectID, r.TaskID); err == nil {
		t.Fatal("missing credential capability accepted")
	}
	cause := errors.New("credential lookup failed")
	for _, tc := range []struct {
		name string
		auth model.CredentialAuthorization
		err  error
		ok   bool
	}{
		{"lookup failure", model.CredentialAuthorization{}, cause, false},
		{"identity changed", uploadPolicy(t, model.Principal{Kind: model.PATCredential, UserID: h.actor.Principal.UserID, CredentialID: uuid.NewString()}, "attachment:read", "attachment:upload"), nil, false},
		{"both scopes", uploadPolicy(t, h.actor.Principal, "attachment:read", "attachment:upload"), nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			scope := &uploadScope{t: t, credential: func(_ context.Context, p model.Principal, kind, id, project, task string) (model.CredentialAuthorization, error) {
				if p != h.actor.Principal || kind != h.actor.AuthorityKind || id != h.actor.AuthorityID || project != r.ProjectID || task != r.TaskID {
					t.Error("wrong publication authority")
				}
				return tc.auth, tc.err
			}}
			err := authorizeUploadPublication(t.Context(), scope, h.actor, r.ProjectID, r.TaskID)
			if (err == nil) != tc.ok || (tc.err != nil && !errors.Is(err, tc.err)) {
				t.Fatalf("publication authority: %v", err)
			}
		})
	}
}

func TestUploadPublicationRechecksPolicyBeforeFileEffect(t *testing.T) {
	for _, missing := range []scopepolicy.ScopeID{"attachment:upload", "attachment:read"} {
		t.Run(string(missing), func(t *testing.T) {
			h := newUploadHarness(t)
			r := h.record("scope-publication", 1)
			content := []byte("a")
			chunks := h.seed(r, content)
			plan, admission := h.commit(h.actor, r, chunks, content, uploadAttachment(r, 1), true, scopepolicy.ErrInsufficientScope, nil, nil)
			h.uploads.scopedAttachments = &attachmentservice.ScopedAttachments{}
			entered, release := make(chan struct{}), make(chan struct{})
			effects := 0
			admission.effect = func(context.Context, []byte) { effects++ }
			admission.scope.credential = func(ctx context.Context, p model.Principal, kind, id, project, task string) (model.CredentialAuthorization, error) {
				if p != h.actor.Principal || kind != h.actor.AuthorityKind || id != h.actor.AuthorityID || project != r.ProjectID || task != r.TaskID {
					t.Errorf("publication lost transfer authority or target")
				}
				close(entered)
				select {
				case <-release:
				case <-ctx.Done():
					return model.CredentialAuthorization{}, ctx.Err()
				}
				remaining := scopepolicy.ScopeID("attachment:read")
				if missing == remaining {
					remaining = "attachment:upload"
				}
				policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{remaining}, 2)
				if err != nil {
					return model.CredentialAuthorization{}, err
				}
				return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}, nil
			}
			h.uploads.admitScopedTransfer = func(_ context.Context, p model.Principal, project, task, path, contentType string, ns filestorage.TransferNamespace, authorize func(context.Context, store.AttachmentMutationScope) error) (transferAdmission, error) {
				admission.authorize = authorize
				return h.uploads.admitTransfer(t.Context(), p, project, task, path, contentType, ns)
			}
			result := make(chan uploadCallResult, 1)
			go func() {
				data, err := h.uploads.execute(t.Context(), nil, h.actor, r.ProjectID, r.TaskID, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "1"})
				result <- uploadCallResult{data, err}
			}()
			waitUpload(t, entered)
			close(release)
			got := awaitUpload(t, result)
			if !errors.Is(got.err, scopepolicy.ErrInsufficientScope) || got.data["writeOutcome"] != "not_committed" || effects != 0 || admission.scope.calls != 0 || plan.pending().State != "cleanup_pending" {
				t.Fatalf("result=%v err=%v effects=%d receipt reads=%d", got.data, got.err, effects, admission.scope.calls)
			}
		})
	}
}
