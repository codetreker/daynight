package mcpdownload

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type scopedUploadResult struct {
	data map[string]any
	err  error
}

// The second transaction publishes after target gate admission and private
// chunk verification. Hold its callback before acquiring authority locks.
type finalMutationBarrier struct {
	store.AttachmentMutationWriter
	calls            atomic.Int32
	entered, release chan struct{}
}

func (b *finalMutationBarrier) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
	n := b.calls.Add(1)
	return b.AttachmentMutationWriter.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
		if n == 2 {
			close(b.entered)
			select {
			case <-b.release:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return fn(scope)
	})
}

func TestScopedFinalizeRechecksPolicyWithPostgresAndTargetGate(t *testing.T) {
	for _, kind := range []string{"pat", "oauth"} {
		for _, missing := range []string{"attachment:read", "attachment:upload"} {
			for _, conflict := range []bool{false, true} {
				name := kind + "/missing-" + missing
				if conflict {
					name += "/conflict"
				}
				t.Run(name, func(t *testing.T) {
					tasks, db, project, _, owner := testsupport.TaskService(t)
					task := testsupport.CreateTask(t, tasks, owner, project.ID, "finalize scope")
					id, authority := uuid.NewString(), uuid.NewString()
					hash := sha256.Sum256([]byte(id))
					var principal model.Principal
					var profile model.CredentialPolicyProfile
					var edit string
					if kind == "pat" {
						authority = id
						principal = model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: id}
						profile = model.ScopedPATProfile
						_, err := db.Pool.Exec(t.Context(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,business_scopes,scope_version) VALUES($1,$2,$3,'test',now(),ARRAY['attachment:read','attachment:upload'],1)`, id, owner.UserID, hash[:])
						if err != nil {
							t.Fatal(err)
						}
						edit = `UPDATE personal_access_tokens SET business_scopes=$2,scope_version=2 WHERE id=$1`
					} else {
						principal = model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID, CredentialID: id}
						profile = model.ScopedMCPProfile
						_, err := db.Pool.Exec(t.Context(), `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,'test','{}','https://example.test/mcp','daynight:mcp',now(),now()+interval '1 hour',ARRAY['attachment:read','attachment:upload'],1)`, authority, owner.UserID)
						if err != nil {
							t.Fatal(err)
						}
						if _, err := db.Pool.Exec(t.Context(), `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '1 hour')`, id, authority, owner.UserID, hash[:]); err != nil {
							t.Fatal(err)
						}
						edit = `UPDATE oauth_grants SET business_scopes=$2,scope_version=2 WHERE id=$1`
					}
					credentialKind := scopepolicy.PAT
					if kind == "oauth" {
						credentialKind = scopepolicy.MCP
					}
					policy, err := scopepolicy.NewPolicy(credentialKind, []scopepolicy.ScopeID{"attachment:read", "attachment:upload"}, 1)
					if err != nil {
						t.Fatal(err)
					}
					auth := model.CredentialAuthorization{Principal: principal, Profile: profile, Policy: &policy}
					actor := mcptransfer.Actor{Principal: principal, AuthorityKind: kind, AuthorityID: authority}
					files, err := local.New(t.TempDir())
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() {
						if err := files.Close(); err != nil {
							t.Error(err)
						}
					})
					base := attachmentservice.NewAttachments(db, db, files)
					path := "folder/file.txt"
					original, _, err := base.Put(t.Context(), owner, project.ID, task.ID, path, "text/plain", strings.NewReader("original"))
					if err != nil {
						t.Fatal(err)
					}
					lifecycle, err := mcptransfer.NewScoped(db, files, files, 1<<30, 0)
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() {
						ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
						defer cancel()
						if err := lifecycle.Close(ctx); err != nil {
							t.Error(err)
						}
					})
					barrier := &finalMutationBarrier{AttachmentMutationWriter: db, entered: make(chan struct{}), release: make(chan struct{})}
					var releaseOnce sync.Once
					unblock := func() { releaseOnce.Do(func() { close(barrier.release) }) }
					t.Cleanup(unblock)
					attachments := attachmentservice.NewAttachments(db, barrier, files)
					uploads, err := mcptransfer.NewScopedUploads(lifecycle, files, attachments)
					if err != nil {
						t.Fatal(err)
					}
					transferID := uuid.NewString()
					begin := mcptransfer.UploadInput{Action: "begin", TransferID: transferID, Path: path, ContentType: "text/plain"}
					if _, err := uploads.ExecuteScoped(t.Context(), auth, actor, project.ID, task.ID, begin); err != nil {
						t.Fatal(err)
					}
					content := []byte("new private content")
					chunk := mcptransfer.UploadInput{Action: "chunk", TransferID: transferID, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString(content)}
					if _, err := uploads.ExecuteScoped(t.Context(), auth, actor, project.ID, task.ID, chunk); err != nil {
						t.Fatal(err)
					}
					var objectID string
					if err := db.Pool.QueryRow(t.Context(), `SELECT object_id::text FROM private_upload_chunks WHERE transfer_id=$1`, transferID).Scan(&objectID); err != nil {
						t.Fatal(err)
					}
					ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
					defer cancel()
					results := make(chan scopedUploadResult, 1)
					go func() {
						data, err := uploads.ExecuteScoped(ctx, auth, actor, project.ID, task.ID, mcptransfer.UploadInput{Action: "commit", TransferID: transferID, TotalBytes: strconv.Itoa(len(content))})
						results <- scopedUploadResult{data, err}
					}()
					select {
					case <-barrier.entered:
					case got := <-results:
						t.Fatalf("finalize did not reach transaction: %+v %v", got.data, got.err)
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					remaining := "attachment:read"
					if missing == remaining {
						remaining = "attachment:upload"
					}
					if _, err := db.Pool.Exec(ctx, edit, authority, []string{remaining}); err != nil {
						t.Fatal(err)
					}
					if conflict {
						// Insert an ancestor after the first path check to ensure the final
						// conflict check cannot precede policy admission.
						if _, err := db.Pool.Exec(ctx, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'folder','text/plain',0)`, project.ID, task.ID); err != nil {
							t.Fatal(err)
						}
					}
					unblock()
					var got scopedUploadResult
					select {
					case got = <-results:
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					var fault *model.Fault
					if !errors.As(got.err, &fault) || fault.Code != "insufficient_scope" || !errors.Is(got.err, scopepolicy.ErrInsufficientScope) || got.data["writeOutcome"] != "not_committed" || got.data["attachment"] != nil {
						t.Fatalf("finalize=%v err=%v", got.data, got.err)
					}
					var state string
					var reserved, ledger int64
					if err := db.Pool.QueryRow(ctx, `SELECT state,reserved_bytes FROM private_transfers WHERE id=$1`, transferID).Scan(&state, &reserved); err != nil {
						t.Fatal(err)
					}
					if err := db.Pool.QueryRow(ctx, `SELECT reserved_bytes FROM private_transfer_ledger WHERE singleton`).Scan(&ledger); err != nil {
						t.Fatal(err)
					}
					if state != "cleanup_pending" || reserved <= 0 || reserved != ledger {
						t.Fatalf("cleanup barrier state=%s reserved=%d ledger=%d", state, reserved, ledger)
					}
					ns, err := filestorage.NewTransferNamespace(transferID)
					if err != nil {
						t.Fatal(err)
					}
					obj, err := files.OpenTransfer(ctx, ns, objectID)
					if err != nil {
						t.Fatalf("private chunk missing before cleanup: %v", err)
					}
					_ = obj.Body.Close()
					item, object, err := base.Open(ctx, owner, project.ID, task.ID, path)
					if err != nil {
						t.Fatal(err)
					}
					body, err := io.ReadAll(object.Body)
					_ = object.Body.Close()
					if err != nil || string(body) != "original" || item != original {
						t.Fatalf("target changed: metadata=%+v original=%+v body=%q err=%v", item, original, body, err)
					}
					if err := lifecycle.Maintain(ctx); err != nil {
						t.Fatal(err)
					}
					if err := db.Pool.QueryRow(ctx, `SELECT state,reserved_bytes FROM private_transfers WHERE id=$1`, transferID).Scan(&state, &reserved); err != nil {
						t.Fatal(err)
					}
					if err := db.Pool.QueryRow(ctx, `SELECT reserved_bytes FROM private_transfer_ledger WHERE singleton`).Scan(&ledger); err != nil {
						t.Fatal(err)
					}
					if state != "closed" || reserved != 0 || ledger != 0 {
						t.Fatalf("cleanup state=%s reserved=%d ledger=%d", state, reserved, ledger)
					}
					if obj, err := files.OpenTransfer(ctx, ns, objectID); err == nil {
						_ = obj.Body.Close()
						t.Fatal("private chunk survived cleanup")
					}
				})
			}
		}
	}
}
