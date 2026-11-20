package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"io"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func scopedServiceContext(t *testing.T, f serviceFixture) context.Context {
	t.Helper()
	auth := readPolicy(t, "session:read")
	auth.Principal = f.owner
	source := NewSessionAuthorizationSource("https://daynight.example")
	return WithScopedSessionRead(t.Context(), auth, source.SessionWrite, source.SessionSnapshot)
}

func setSessionScopes(t *testing.T, f serviceFixture, scopes ...string) {
	t.Helper()
	_, err := f.db.Pool.Exec(t.Context(), `UPDATE personal_access_tokens SET business_scopes=$2, scope_version=COALESCE(scope_version,0)+1 WHERE id=$1`, f.owner.CredentialID, scopes)
	if err != nil {
		t.Fatal(err)
	}
}

func waitScopedContentRequest(t *testing.T, f serviceFixture, v sp.Snapshot, done <-chan error) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		offers, err := f.service.Poll(ctx, v.ControllerFence)
		if err != nil {
			t.Fatal(err)
		}
		for _, offer := range offers {
			if offer["type"] == "content_request" {
				return offer
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("content request was not offered")
		case err := <-done:
			t.Fatalf("early reader error: %s", scopedErrorChain(err))
		case <-ticker.C:
		}
	}
}

func TestScopedHistoryAndResourceRefuseAfterControllerWait(t *testing.T) {
	for _, kind := range []string{"history", "resource"} {
		t.Run(kind, func(t *testing.T) {
			f := newServiceFixture(t)
			setSessionScopes(t, f, "session:read")
			v := f.connectWeb(t, f.registerWeb(t))
			synchronizeServiceSession(t, f, v)
			ctx, cancel := context.WithTimeout(scopedServiceContext(t, f), 10*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				if kind == "history" {
					history := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
						return sp.TaskSessionInspection{SessionID: v.SessionID, Source: "live"}, nil
					}), f.service)
					result, err := history.Read(ctx, f.owner, f.project, f.task, v.SessionID, ReadRequest{})
					if result != nil {
						_ = result.Close()
						done <- errors.New("revoked history returned content")
						return
					}
					done <- err
					return
				}
				data, _, err := f.service.Resource(ctx, f.owner, f.project, f.task, v.SessionID, uuid.NewString())
				if len(data) != 0 {
					done <- errors.New("revoked resource returned bytes")
					return
				}
				done <- err
			}()
			request := waitScopedContentRequest(t, f, v, done)
			setSessionScopes(t, f, "task:read")
			seq, err := f.service.SourceSeq(t.Context(), v.ControllerFence)
			if err != nil {
				t.Fatal(err)
			}
			result := &sp.ContentResult{Kind: "timeline", HistoryEpoch: v.HistoryEpoch, Items: []sp.TimelineEntry{}, Resources: []sp.Resource{}}
			if kind == "resource" {
				result = &sp.ContentResult{Kind: "resource"}
			}
			_, err = f.service.Handle(t.Context(), sp.ControllerMessage{Type: "content_response", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, RequestID: request["requestId"].(string), SourceThrough: strconv.FormatInt(seq, 10), ContentResult: result})
			if err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
					t.Fatalf("read after revocation: %v", err)
				}
			case <-ctx.Done():
				t.Fatal("read did not stop")
			}
		})
	}
}

func TestScopedTerminalArchiveDenialReleasesPermit(t *testing.T) {
	f := newServiceFixture(t)
	setSessionScopes(t, f, "session:read")
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	id, data, _ := seedTerminalHistory(t, f, files)
	engine := core.NewEngine(files)
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	svc := New(f.db, engine)
	ctx := scopedServiceContext(t, f)
	result, err := svc.TerminalArchiveContent(ctx, f.owner, f.project, f.task, id)
	if err != nil || result == nil || len(result.Data) != len(data) {
		t.Fatalf("authorized archive: %s", scopedErrorChain(err))
	}
	setSessionScopes(t, f, "task:read")
	if err = result.Close(); err != nil {
		t.Fatal(err)
	}
	result, err = svc.TerminalArchiveContent(ctx, f.owner, f.project, f.task, id)
	if result != nil || !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("revoked archive: result=%v error=%v", result, err)
	}
	if _, err = svc.TerminalHistory(ctx, f.owner, f.project, f.task, "", 10); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("revoked directory: %v", err)
	}
	permit, err := files.TryAcquireResidency(ctx, "session/archive/owner/"+f.owner.UserID)
	if err != nil || permit == nil {
		t.Fatalf("archive permit retained: %v", err)
	}
	if err = permit.Close(); err != nil {
		t.Fatal(err)
	}
}

func scopedErrorChain(err error) string {
	var out string
	for err != nil {
		out += fmt.Sprintf(" %T: %v;", err, err)
		err = errors.Unwrap(err)
	}
	return out
}

type scopedReadBarrierStorage struct {
	filestorage.Storage
	entered chan struct{}
	resume  chan struct{}
}
type scopedReadBarrierBody struct {
	io.ReadCloser
	entered chan struct{}
	resume  chan struct{}
}

func (b scopedReadBarrierBody) Close() error {
	err := b.ReadCloser.Close()
	close(b.entered)
	<-b.resume
	return err
}
func (s scopedReadBarrierStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	object, err := s.Storage.Open(ctx, bucket, path)
	if err == nil && bucket == sessionresource.Bucket {
		object.Body = scopedReadBarrierBody{ReadCloser: object.Body, entered: s.entered, resume: s.resume}
	}
	return object, err
}

func TestScopedSavedResourceRevocationReleasesReadLease(t *testing.T) {
	f := newServiceFixture(t)
	setSessionScopes(t, f, "session:read")
	v := f.registerWeb(t)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	id := uuid.NewString()
	payload := []byte("saved resource content")
	path, err := core.BlobAddress(f.project, f.owner.UserID, v.SessionID, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = files.Put(t.Context(), sessionresource.Bucket, path, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	hash := hex.EncodeToString(sum[:])
	length := strconv.Itoa(len(payload))
	mime := "image/png"
	descriptor, err := json.Marshal(sp.Resource{ResourceID: id, Revision: "1", Status: "available", Name: "image", ByteLength: &length, SHA256: &hash, MediaType: &mime})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(t.Context(), `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path) VALUES($1,$2,$3,$2,$4)`, v.SessionID, id, descriptor, path); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(t.Context(), `INSERT INTO session_resource_references(session_id,resource_id,kind,reference_id) VALUES($1,$2,'message','published')`, v.SessionID, id); err != nil {
		t.Fatal(err)
	}
	barrier := scopedReadBarrierStorage{Storage: files, entered: make(chan struct{}), resume: make(chan struct{})}
	var resume sync.Once
	release := func() { resume.Do(func() { close(barrier.resume) }) }
	defer release()
	engine := core.NewEngine(barrier)
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	service := New(f.db, engine)
	ctx, cancel := context.WithTimeout(scopedServiceContext(t, f), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		data, _, err := service.Resource(ctx, f.owner, f.project, f.task, v.SessionID, id)
		if len(data) != 0 {
			done <- errors.New("revoked resource returned bytes")
			return
		}
		done <- err
	}()
	select {
	case <-barrier.entered:
	case err := <-done:
		t.Fatalf("resource failed before file read: %s", scopedErrorChain(err))
	case <-ctx.Done():
		t.Fatal("resource read did not reach barrier")
	}
	var count int
	if err = f.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM session_resource_leases WHERE session_id=$1`, v.SessionID).Scan(&count); err != nil || count != 1 {
		release()
		t.Fatalf("read lease: count=%d error=%v", count, err)
	}
	setSessionScopes(t, f, "task:read")
	release()
	select {
	case err := <-done:
		if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
			t.Fatalf("revoked resource: %s", scopedErrorChain(err))
		}
	case <-ctx.Done():
		t.Fatal("resource read did not finish")
	}
	if err = f.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM session_resource_leases WHERE session_id=$1`, v.SessionID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("read lease not released: count=%d error=%v", count, err)
	}
}
