package azure

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
)

type failedReader struct{}

func (failedReader) Read([]byte) (int, error) { return 0, errors.New("input failed") }

type controlled struct {
	mu         sync.Mutex
	data       map[string]string
	status     int
	requests   int
	failMethod string
	after      func(*http.Request)
}

func (c *controlled) serve(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests++
	if c.after != nil {
		defer c.after(r)
	}
	if c.status != 0 && (c.failMethod == "" || c.failMethod == r.Method) {
		w.Header().Set("x-ms-error-code", "AuthorizationFailure")
		w.WriteHeader(c.status)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/container/")
	if r.URL.Query().Get("comp") == "list" {
		prefix := r.URL.Query().Get("prefix")
		w.Header().Set("Content-Type", "application/xml")
		fmt.Fprint(w, `<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>`)
		for k := range c.data {
			if strings.HasPrefix(k, prefix) {
				fmt.Fprintf(w, "<Blob><Name>%s</Name></Blob>", k)
			}
		}
		fmt.Fprint(w, `</Blobs><NextMarker></NextMarker></EnumerationResults>`)
		return
	}
	switch r.Method {
	case "PUT":
		b, _ := io.ReadAll(r.Body)
		c.data[name] = string(b)
		w.Header().Set("ETag", `"1"`)
		w.WriteHeader(201)
	case "DELETE":
		if _, ok := c.data[name]; !ok {
			w.Header().Set("x-ms-error-code", "BlobNotFound")
			w.WriteHeader(404)
			return
		}
		delete(c.data, name)
		w.WriteHeader(202)
	case "GET", "HEAD":
		v, ok := c.data[name]
		if !ok {
			w.Header().Set("x-ms-error-code", "BlobNotFound")
			w.WriteHeader(404)
			return
		}
		w.Header().Set("ETag", `"1"`)
		if r.Method == "GET" && r.Header.Get("x-ms-range") != "" {
			var start, end int
			if _, err := fmt.Sscanf(r.Header.Get("x-ms-range"), "bytes=%d-%d", &start, &end); err != nil {
				panic(err)
			}
			w.Header().Set("Content-Length", fmt.Sprint(end-start+1))
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(v)))
			w.WriteHeader(206)
			_, _ = io.WriteString(w, v[start:end+1])
			return
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(v)))
		w.WriteHeader(200)
		if r.Method == "GET" {
			_, _ = io.WriteString(w, v)
		}
	default:
		w.WriteHeader(500)
	}
}
func control(t *testing.T) (*Storage, *controlled) {
	t.Helper()
	c := &controlled{data: map[string]string{}}
	server := httptest.NewServer(http.HandlerFunc(c.serve))
	t.Cleanup(server.Close)
	client, err := container.NewClientWithNoCredential(server.URL+"/container", &container.ClientOptions{ClientOptions: azcore.ClientOptions{Retry: policy.RetryOptions{MaxRetries: -1}}})
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(client, testGates{}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s, c
}
func TestControlledStorage(t *testing.T) {
	s, c := control(t)
	ctx := t.Context()
	p := owner + "/22/" + task + "/é.txt"
	if _, err := New(nil, testGates{}, "x"); err == nil {
		t.Fatal("nil client")
	}
	if _, err := New(s.client, nil, "x"); err == nil {
		t.Fatal("nil gates")
	}
	if _, err := New(s.client, testGates{}, ""); err == nil {
		t.Fatal("empty scratch")
	}
	for _, path := range []string{"bad", owner + "/xx/" + task + "/name", "bad/22/" + task + "/name", owner + "/AA/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/name"} {
		if _, err := BlobName("task-attachments", path); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatalf("invalid: %q %v", path, err)
		}
	}
	if _, err := BlobName("bad/bucket", "x"); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatal(err)
	}
	if _, err := s.Put(ctx, "task-attachments", p, failedReader{}); filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatal(err)
	}
	scratch := s.scratch
	s.scratch = "/does-not-exist"
	if _, err := s.Put(ctx, "task-attachments", p, strings.NewReader("x")); filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatal(err)
	}
	s.scratch = scratch
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.Put(canceled, "task-attachments", p, strings.NewReader("x")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := s.Open(canceled, "x", "y"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := s.Delete(canceled, "x", "y"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, _, err := s.ResourceSpace(canceled); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := s.AvailableTransferBytes(canceled); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, _, err := s.ResourceSpace(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AvailableTransferBytes(ctx); err != nil {
		t.Fatal(err)
	}
	for _, status := range []int{400, 401, 403, 404, 409, 412, 413, 500} {
		c.status = status
		before := c.requests
		_, err := s.Put(ctx, "task-attachments", p, strings.NewReader("x"))
		want := filestorage.NotPublished
		if status == 500 {
			want = filestorage.PublicationUnknown
		}
		if filestorage.PublicationOutcome(err) != want || c.requests != before+1 {
			t.Fatalf("status %d outcome %s requests %d err %v", status, filestorage.PublicationOutcome(err), c.requests-before, err)
		}
	}
	c.status = 0
	put(t, s, "task-attachments", p, "one")
	o, err := s.Open(ctx, "task-attachments", p)
	if err != nil || read(t, o) != "one" {
		t.Fatalf("open %v", err)
	}
	if err = s.Delete(ctx, "task-attachments", p); err != nil {
		t.Fatal(err)
	}
	if err = s.Delete(ctx, "task-attachments", p); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Open(ctx, "task-attachments", p); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	n, _ := filestorage.NewTransferNamespace(task)
	if _, err = s.PutTransfer(ctx, n, objID, strings.NewReader("hello")); err != nil {
		t.Fatal(err)
	}
	if o, err = s.OpenTransfer(ctx, n, objID); err != nil {
		t.Fatal(err)
	} else {
		_ = o.Body.Close()
	}
	if _, err = s.OpenTransferRange(ctx, n, objID, -1, 1); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatal(err)
	}
	for _, r := range [][2]int64{{0, 0}, {10, 1}} {
		o, err = s.OpenTransferRange(ctx, n, objID, r[0], r[1])
		if err != nil || o.Info.Size != 5 || read(t, o) != "" {
			t.Fatalf("empty: %v", err)
		}
	}
	o, err = s.OpenTransferRange(ctx, n, objID, 1, 3)
	if err != nil || o.Info.Size != 5 || read(t, o) != "ell" {
		t.Fatalf("range: %v", err)
	}
	target, _ := filestorage.NewTransferAttachmentTarget(owner, task, "dest")
	if err = s.PublishTransferAttachment(ctx, n, objID, target); err != nil {
		t.Fatal(err)
	}
	if err = s.PublishTransferAttachment(ctx, n, objID, filestorage.TransferAttachmentTarget{}); filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatal(err)
	}
	resource, _ := sessionresource.NewNamespace(owner, "", task)
	archive, _ := sessionarchive.NewNamespace(sessionarchive.Projects, owner, task)
	upload, _ := resource.UploadPath(objID)
	put(t, s, sessionresource.Bucket, upload+"/0", "x")
	put(t, s, sessionarchive.Bucket, archive.Directory()+"/x", "x")
	if err = s.DeleteSessionUpload(ctx, resource, objID); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteSessionResources(ctx, resource); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteSessionArchives(ctx, archive); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteTransferNamespace(ctx, n); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteTransferNamespace(ctx, filestorage.TransferNamespace{}); err == nil {
		t.Fatal("invalid namespace")
	}
	if err = s.DeleteSessionResources(ctx, sessionresource.Namespace{}); err == nil {
		t.Fatal("invalid namespace")
	}
	if err = s.DeleteSessionUpload(ctx, sessionresource.Namespace{}, "bad"); err == nil {
		t.Fatal("invalid namespace")
	}
	if err = s.DeleteSessionArchives(ctx, sessionarchive.Namespace{}); err == nil {
		t.Fatal("invalid namespace")
	}
	if _, err = s.PutTransfer(ctx, filestorage.TransferNamespace{}, objID, strings.NewReader("x")); err == nil {
		t.Fatal("invalid transfer")
	}
	if _, err = s.OpenTransfer(ctx, filestorage.TransferNamespace{}, objID); err == nil {
		t.Fatal("invalid transfer")
	}
	if _, err = s.OpenTransferRange(ctx, filestorage.TransferNamespace{}, objID, 0, 1); err == nil {
		t.Fatal("invalid transfer")
	}
	if _, err = s.OpenTransferRange(ctx, n, objID, 0, 1); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	if err = s.PublishTransferAttachment(ctx, n, objID, target); filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatal(err)
	}
	c.status = 403
	if _, err = s.Open(ctx, "x", "y"); err == nil || errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	if err = s.Delete(ctx, "x", "y"); err == nil {
		t.Fatal("delete succeeded")
	}
	if err = s.DeleteTransferNamespace(ctx, n); err == nil {
		t.Fatal("listing succeeded")
	}
	if _, err = s.OpenTransferRange(ctx, n, objID, 0, 1); err == nil {
		t.Fatal("properties succeeded")
	}
	c.status = 0
	put(t, s, transferBucket, n.Directory()+"/orphan", "x")
	c.status = 403
	c.failMethod = "DELETE"
	if err = s.DeleteTransferNamespace(ctx, n); err == nil {
		t.Fatal("delete failure hidden")
	}
	c.status = 0
	c.failMethod = ""
	if _, err = s.PutTransfer(ctx, n, objID, strings.NewReader("five!")); err != nil {
		t.Fatal(err)
	}
	c.status = 403
	c.failMethod = "PUT"
	if err = s.PublishTransferAttachment(ctx, n, objID, target); filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatal(err)
	}
	c.failMethod = "GET"
	if _, err = s.OpenTransferRange(ctx, n, objID, 1, 1); err == nil {
		t.Fatal("range failure hidden")
	}
	c.status = 0
	c.failMethod = ""
	if _, err = s.Open(ctx, "bad/bucket", "x"); err == nil {
		t.Fatal("invalid address")
	}
	if err = s.Delete(ctx, "bad/bucket", "x"); err == nil {
		t.Fatal("invalid address")
	}
	if err = s.DeleteTransferNamespace(canceled, n); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err = (contextReader{canceled, strings.NewReader("x")}).Read(make([]byte, 1)); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err = os.Stat(scratch); err != nil {
		t.Fatal(err)
	}
}

func TestReadRetryKeepsOriginalETag(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("ETag", `"old"`)
			w.Header().Set("Content-Length", "10")
			w.WriteHeader(200)
			_, _ = w.Write([]byte("old"))
			return
		}
		if got := r.Header.Get("If-Match"); got != `"old"` {
			t.Errorf("retry If-Match %q", got)
		}
		w.Header().Set("x-ms-error-code", "ConditionNotMet")
		w.WriteHeader(412)
	}))
	defer server.Close()
	client, err := container.NewClientWithNoCredential(server.URL+"/container", nil)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(client, testGates{}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	o, err := s.Open(t.Context(), "session-archives", "view")
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(o.Body)
	_ = o.Body.Close()
	if err == nil || string(data) != "old" || calls != 2 {
		t.Fatalf("data %q error %v requests %d", data, err, calls)
	}
}

func TestLostWriteResponseIsUnknown(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = io.Copy(io.Discard, r.Body)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = conn.Close()
	}))
	defer server.Close()
	client, err := container.NewClientWithNoCredential(server.URL+"/container", nil)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(client, testGates{}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Put(t.Context(), "session-archives", "result", strings.NewReader("complete"))
	if filestorage.PublicationOutcome(err) != filestorage.PublicationUnknown || requests != 1 {
		t.Fatalf("outcome %s, requests %d: %v", filestorage.PublicationOutcome(err), requests, err)
	}
}

type observedLease struct{ lost atomic.Bool }

func (l *observedLease) Close() error { return nil }
func (l *observedLease) GateContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return ctx, func() {}
}
func (l *observedLease) CheckGate() error {
	if l.lost.Load() {
		return filestorage.ErrGateLost
	}
	return nil
}
func TestGateLossDuringLastResponse(t *testing.T) {
	for _, scenario := range []string{"empty list", "last delete", "properties", "range"} {
		t.Run(scenario, func(t *testing.T) {
			s, c := control(t)
			n, _ := filestorage.NewTransferNamespace(task)
			if scenario != "empty list" {
				if _, err := s.PutTransfer(t.Context(), n, objID, strings.NewReader("hello")); err != nil {
					t.Fatal(err)
				}
			}
			lease := &observedLease{}
			ctx, release := filestorage.GateContext(t.Context(), lease)
			defer release()
			c.after = func(r *http.Request) {
				switch scenario {
				case "empty list":
					if r.URL.Query().Get("comp") == "list" {
						lease.lost.Store(true)
					}
				case "last delete":
					if r.Method == "DELETE" {
						lease.lost.Store(true)
					}
				case "properties":
					if r.Method == "HEAD" {
						lease.lost.Store(true)
					}
				case "range":
					if r.Method == "GET" {
						lease.lost.Store(true)
					}
				}
			}
			var err error
			if scenario == "empty list" || scenario == "last delete" {
				err = s.DeleteTransferNamespace(ctx, n)
			} else {
				_, err = s.OpenTransferRange(ctx, n, objID, 0, 1)
			}
			if !errors.Is(err, filestorage.ErrGateLost) {
				t.Fatalf("lost gate not reported: %v", err)
			}
		})
	}
}

func TestGateLossWhileReading(t *testing.T) {
	s, _ := control(t)
	put(t, s, "session-archives", "content", "data")
	lease := &observedLease{}
	ctx, release := filestorage.GateContext(t.Context(), lease)
	defer release()
	o, err := s.Open(ctx, "session-archives", "content")
	if err != nil {
		t.Fatal(err)
	}
	lease.lost.Store(true)
	if _, err = o.Body.Read(make([]byte, 4)); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("read: %v", err)
	}
	if err = o.Body.Close(); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("close: %v", err)
	}
}
