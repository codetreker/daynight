package mcpdownload_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	mcpserver "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type uploadMCPAuth struct{ authorization model.CredentialAuthorization }

func (a uploadMCPAuth) Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error) {
	return model.Principal{}, model.Unauthenticated(nil)
}
func (a uploadMCPAuth) AuthenticateScoped(_ context.Context, kind model.CredentialKind, _, _ string) (model.CredentialAuthorization, mcpserver.AuthorityRef, error) {
	if kind != model.PATCredential {
		return model.CredentialAuthorization{}, mcpserver.AuthorityRef{}, model.Unauthenticated(nil)
	}
	return a.authorization, mcpserver.AuthorityRef{Kind: "pat", ID: a.authorization.Principal.CredentialID}, nil
}

type uploadMCPTransport struct{}

func (uploadMCPTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Host = "daynight.test"
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer test")
	return http.DefaultTransport.RoundTrip(r)
}

type uploadMCPBarrier struct {
	store.AttachmentMutationWriter
	calls            atomic.Int32
	entered, release chan struct{}
}

func (b *uploadMCPBarrier) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
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

type uploadMCPGateStorage struct {
	filestorage.Storage
	fail atomic.Bool
}

type uploadMCPGate struct {
	io.Closer
	storage *uploadMCPGateStorage
}

func (g uploadMCPGate) Close() error {
	err := g.Closer.Close()
	if g.storage.fail.Load() {
		return errors.Join(err, errors.New("test permit cleanup failure"))
	}
	return err
}
func (s *uploadMCPGateStorage) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	gate, err := s.Storage.AcquireGate(ctx, domain, key)
	if err != nil || domain != filestorage.PrivateGate {
		return gate, err
	}
	return uploadMCPGate{Closer: gate, storage: s}, nil
}

func TestScopedUploadMCPPostgresRefusalEnvelope(t *testing.T) {
	for _, phase := range []string{"bound", "admission", "finalize", "finalize-cleanup-failure"} {
		t.Run(phase, func(t *testing.T) {
			tasks, db, project, _, owner := testsupport.TaskService(t)
			task := testsupport.CreateTask(t, tasks, owner, project.ID, "MCP upload scope")
			id := uuid.NewString()
			hash := sha256.Sum256([]byte(id))
			if _, err := db.Pool.Exec(t.Context(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,business_scopes,scope_version) VALUES($1,$2,$3,'test',now(),ARRAY['attachment:read','attachment:upload'],1)`, id, owner.UserID, hash[:]); err != nil {
				t.Fatal(err)
			}
			principal := model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: id}
			policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"attachment:read", "attachment:upload"}, 1)
			if err != nil {
				t.Fatal(err)
			}
			auth := uploadMCPAuth{model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}}
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = files.Close() })
			gates := &uploadMCPGateStorage{Storage: files}
			lifecycle, err := mcptransfer.NewScoped(db, gates, files, 1<<30, 0)
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
			barrier := &uploadMCPBarrier{AttachmentMutationWriter: db, entered: make(chan struct{}), release: make(chan struct{})}
			var once sync.Once
			unblock := func() { once.Do(func() { close(barrier.release) }) }
			t.Cleanup(unblock)
			attachments := attachmentservice.NewAttachments(db, barrier, files)
			uploads, err := mcptransfer.NewScopedUploads(lifecycle, files, attachments)
			if err != nil {
				t.Fatal(err)
			}
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			entry, err := mcpserver.New(auth, "https://daynight.test", nil, logger, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err = entry.EnableScopedAuthentication(auth); err != nil {
				t.Fatal(err)
			}
			if err = mcpserver.RegisterScopedUploadTools(entry, uploads); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(entry)
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if err := entry.Shutdown(ctx); err != nil {
					t.Error(err)
				}
				server.Close()
			})
			client := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "1"}, nil)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: server.URL, HTTPClient: &http.Client{Transport: uploadMCPTransport{}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = session.Close() })
			idTransfer := uuid.NewString()
			call := func(args map[string]any) (*sdk.CallToolResult, error) {
				args["projectId"], args["taskId"] = project.ID, task.ID
				return session.CallTool(ctx, &sdk.CallToolParams{Name: "task_attachment_put", Arguments: args})
			}
			for _, args := range []map[string]any{
				{"action": "begin", "transferId": idTransfer, "path": "file", "contentType": "text/plain"},
				{"action": "chunk", "transferId": idTransfer, "chunkId": uuid.NewString(), "offset": "0", "contentBase64": base64.StdEncoding.EncodeToString([]byte("content"))},
			} {
				result, err := call(args)
				if err != nil || result.IsError {
					t.Fatalf("setup call %+v: %+v %v", args, result, err)
				}
			}
			revoke := func() {
				remaining := "attachment:read"
				if phase == "admission" {
					remaining = "attachment:upload"
				}
				if _, err := db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=$2,scope_version=2 WHERE id=$1`, id, []string{remaining}); err != nil {
					t.Fatal(err)
				}
			}
			if phase == "bound" || phase == "admission" {
				revoke()
			}
			type response struct {
				result *sdk.CallToolResult
				err    error
			}
			responses := make(chan response, 1)
			go func() {
				result, err := call(map[string]any{"action": "commit", "transferId": idTransfer, "totalBytes": strconv.Itoa(len("content"))})
				responses <- response{result, err}
			}()
			if phase == "finalize" || phase == "finalize-cleanup-failure" {
				select {
				case <-barrier.entered:
				case got := <-responses:
					t.Fatalf("finalize did not reach transaction: %+v %v", got.result, got.err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				revoke()
				if phase == "finalize-cleanup-failure" {
					gates.fail.Store(true)
				}
				unblock()
			}
			var got response
			select {
			case got = <-responses:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if got.err != nil || got.result == nil || !got.result.IsError {
				t.Fatalf("commit response %+v %v", got.result, got.err)
			}
			bytes, err := json.Marshal(got.result.StructuredContent)
			if err != nil {
				t.Fatal(err)
			}
			var envelope struct {
				Error struct{ Code, WriteOutcome string }
			}
			if err := json.Unmarshal(bytes, &envelope); err != nil {
				t.Fatal(err)
			}
			wantCode, wantOutcome := "insufficient_scope", "not_committed"
			if phase == "bound" {
				wantOutcome = ""
			}
			if phase == "finalize-cleanup-failure" {
				wantCode = "internal_error"
			}
			if envelope.Error.Code != wantCode || envelope.Error.WriteOutcome != wantOutcome || strings.Contains(string(bytes), "attachment\"") {
				t.Fatalf("unexpected MCP envelope: %s", bytes)
			}
			var state string
			var metadataCount int
			if err := db.Pool.QueryRow(ctx, `SELECT state FROM private_transfers WHERE id=$1`, idTransfer).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_attachments WHERE project_id=$1 AND task_id=$2`, project.ID, task.ID).Scan(&metadataCount); err != nil {
				t.Fatal(err)
			}
			address, err := attachmentcore.NewAddress(project.ID, task.ID, "file")
			if err != nil {
				t.Fatal(err)
			}
			object, openErr := files.Open(ctx, attachmentcore.Bucket, address.StoragePath)
			if openErr == nil {
				_ = object.Body.Close()
			}
			if metadataCount != 0 || !errors.Is(openErr, fs.ErrNotExist) {
				t.Fatalf("denied publication left target: metadata=%d file error=%v", metadataCount, openErr)
			}
			gates.fail.Store(false)
			if phase == "bound" || phase == "admission" {
				if state != "receiving" {
					t.Fatalf("unadmitted commit changed state: %s", state)
				}
				actor := mcptransfer.Actor{Principal: principal, AuthorityKind: "pat", AuthorityID: id}
				if _, err := lifecycle.RequestCleanup(ctx, actor, idTransfer); err != nil {
					t.Fatal(err)
				}
			} else if state != "cleanup_pending" {
				t.Fatalf("finalize cleanup state: %s", state)
			}
			if err := lifecycle.Maintain(ctx); err != nil {
				t.Fatal(err)
			}
			var reserved int64
			if err := db.Pool.QueryRow(ctx, `SELECT state,reserved_bytes FROM private_transfers WHERE id=$1`, idTransfer).Scan(&state, &reserved); err != nil || state != "closed" || reserved != 0 {
				t.Fatalf("cleanup state=%s reserved=%d err=%v", state, reserved, err)
			}
		})
	}
}
