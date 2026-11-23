package azure

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/appendblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/google/uuid"
)

type lostAppendTransport struct{ lose atomic.Bool }

func (t *lostAppendTransport) Do(req *http.Request) (*http.Response, error) {
	resp, err := http.DefaultClient.Do(req)
	if err == nil && req.Method == http.MethodPut && req.URL.Query().Get("comp") == "appendblock" && t.lose.CompareAndSwap(true, false) {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return nil, errors.New("simulated lost append response")
	}
	return resp, err
}

func TestAzuriteArchiveStaging(t *testing.T) {
	connection := os.Getenv("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING")
	if connection == "" {
		t.Skip("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING is unset")
	}
	ctx := t.Context()
	transport := &lostAppendTransport{}
	options := &container.ClientOptions{ClientOptions: azcore.ClientOptions{Transport: transport}}
	c, err := container.NewClientFromConnectionString(connection, "archive-"+strings.ReplaceAll(uuid.NewString(), "-", ""), options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.Create(ctx, nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := c.Delete(context.Background(), nil); err != nil {
			t.Error(err)
		}
	})
	gates, err := local.NewStandaloneGates(uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(c, gates, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	n, _ := sessionarchive.NewNamespace(sessionarchive.Projects, owner, task)
	h, err := s.AcquireArchiveStaging(ctx, n, true)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	defer func() {
		if !closed {
			if err := h.Close(); err != nil {
				t.Error(err)
			}
		}
	}()
	if _, err = s.AcquireArchiveStaging(ctx, n, true); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("parallel handle: %v", err)
	}
	if err = s.DeleteSessionArchives(ctx, n); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("archive sweep while active: %v", err)
	}
	rn, _ := sessionresource.NewNamespace(owner, "", task)
	if err = s.DeleteSessionResources(ctx, rn); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("resource sweep while active: %v", err)
	}
	if err = h.Create(ctx, objID); err != nil {
		t.Fatal(err)
	}
	if err = h.Create(ctx, objID); !errors.Is(err, os.ErrExist) {
		t.Fatalf("duplicate: %v", err)
	}
	if err = h.AdoptEmpty(ctx, objID); err != nil {
		t.Fatal(err)
	}
	block := bytes.Repeat([]byte("A"), archiveChunkSize)
	// Prepare a legal nonaligned existing offset as the outcome of an earlier writer.
	total := int64(34*archiveChunkSize + 123)
	for offset := int64(0); offset < 32*archiveChunkSize; offset += archiveChunkSize {
		got, e := h.Append(ctx, objID, total, offset, block)
		if e != nil || got != offset+archiveChunkSize {
			t.Fatalf("append %d: %d %v", offset, got, e)
		}
	}
	stage := h.(*archiveStaging)
	name, _ := stage.name(objID)
	l := stage.leases[name]
	pos := int64(32 * archiveChunkSize)
	if _, err = c.NewAppendBlobClient(name).AppendBlock(ctx, archiveBytes{bytes.NewReader(block[:archiveChunkSize/2])}, &appendblob.AppendBlockOptions{AccessConditions: leaseConditions(l), AppendPositionAccessConditions: &appendblob.AppendPositionAccessConditions{AppendPosition: &pos}}); err != nil {
		t.Fatal(err)
	}
	pos += archiveChunkSize / 2
	if got, e := h.Observe(ctx, objID, total); e != nil || got != pos {
		t.Fatalf("32.5 MiB observation: %d %v", got, e)
	}
	if got, e := h.Append(ctx, objID, total, pos-1, block); !errors.Is(e, filestorage.ErrArchiveStagingOffset) || got != pos {
		t.Fatalf("old offset: %d %v", got, e)
	}
	transport.lose.Store(true)
	if _, e := h.Append(ctx, objID, total, pos, block); e == nil {
		t.Fatal("lost response accepted")
	}
	pos += archiveChunkSize
	if got, e := h.Observe(ctx, objID, total); e != nil || got != pos {
		t.Fatalf("observation after lost response: %d %v", got, e)
	}
	last := bytes.Repeat([]byte("B"), int(total-pos))
	if got, e := h.Append(ctx, objID, total, pos, last); e != nil || got != total {
		t.Fatalf("last append: %d %v", got, e)
	}
	o, err := h.Open(ctx, objID, total)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Close(); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("reader exclusion: %v", err)
	}
	data, err := io.ReadAll(o.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err = o.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if int64(len(data)) != total || !bytes.Equal(data[:pos], bytes.Repeat([]byte("A"), int(pos))) || !bytes.Equal(data[pos:], last) {
		t.Fatal("unexpected staged content")
	}
	if err = h.Delete(ctx, objID); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("frozen mutation: %v", err)
	}
	target := n.Directory() + "/files/" + objID + "/content"
	if info, e := h.Publish(ctx, objID, total, sessionarchive.Bucket, target); e != nil || info.Size != total {
		t.Fatalf("publish: %+v %v", info, e)
	}
	if _, e := h.Publish(ctx, objID, total, sessionarchive.Bucket, n.Directory()+"/files/"+other+"/content"); filestorage.PublicationOutcome(e) != filestorage.NotPublished {
		t.Fatalf("invalid target: %v", e)
	}
	published, err := s.Open(ctx, sessionarchive.Bucket, target)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(published.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err = published.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("published content differs")
	}
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}
	closed = true
	h, err = s.AcquireArchiveStaging(ctx, n, false)
	if err != nil {
		t.Fatal(err)
	}
	closed = false
	if err = h.Delete(ctx, objID); err != nil {
		t.Fatal(err)
	}
	if err = h.Delete(ctx, objID); err != nil {
		t.Fatal(err)
	}
	if _, err = h.Observe(ctx, objID, total); !errors.Is(err, filestorage.ErrArchiveStagingMissing) {
		t.Fatalf("missing: %v", err)
	}
	if err = h.Create(ctx, other); err != nil {
		t.Fatal(err)
	}
	empty, err := h.Open(ctx, other, 0)
	if err != nil || empty.Info.Size != 0 {
		t.Fatalf("empty open: %+v %v", empty.Info, err)
	}
	if got, e := io.ReadAll(empty.Body); e != nil || len(got) != 0 {
		t.Fatalf("empty read: %d %v", len(got), e)
	}
	if err = empty.Body.Close(); err != nil {
		t.Fatal(err)
	}
	resourceTarget := n.Directory() + "/blobs/" + other
	if info, e := h.Publish(ctx, other, 0, sessionresource.Bucket, resourceTarget); e != nil || info.Size != 0 {
		t.Fatalf("empty resource publication: %+v %v", info, e)
	}
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}
	closed = true
	if err = s.DeleteSessionResources(ctx, rn); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteSessionArchives(ctx, n); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Open(ctx, sessionarchive.Bucket, target); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(fmt.Errorf("cleanup: %w", err))
	}
}

type archiveHTTP struct {
	mu        sync.Mutex
	data      []byte
	exists    bool
	failLease bool
}

func (a *archiveHTTP) serve(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.URL.Query().Get("comp") == "lease" {
		if a.failLease {
			w.Header().Set("x-ms-error-code", "LeaseAlreadyPresent")
			w.WriteHeader(409)
			return
		}
		if !a.exists {
			w.Header().Set("x-ms-error-code", "BlobNotFound")
			w.WriteHeader(404)
			return
		}
		w.Header().Set("x-ms-lease-id", r.Header.Get("x-ms-proposed-lease-id"))
		if r.Header.Get("x-ms-lease-action") == "acquire" {
			w.WriteHeader(201)
		} else {
			w.WriteHeader(200)
		}
		return
	}
	if r.URL.Query().Get("comp") == "appendblock" {
		if r.Header.Get("x-ms-blob-condition-appendpos") != strconv.Itoa(len(a.data)) {
			w.Header().Set("x-ms-error-code", "AppendPositionConditionNotMet")
			w.WriteHeader(412)
			return
		}
		w.Header().Set("x-ms-blob-append-offset", strconv.Itoa(len(a.data)))
		b, _ := io.ReadAll(r.Body)
		a.data = append(a.data, b...)
		w.WriteHeader(201)
		return
	}
	switch r.Method {
	case "PUT":
		if r.Header.Get("x-ms-blob-type") == "AppendBlob" {
			if a.exists {
				w.Header().Set("x-ms-error-code", "BlobAlreadyExists")
				w.WriteHeader(409)
				return
			}
			a.exists = true
			a.data = nil
			w.WriteHeader(201)
			return
		}
		io.Copy(io.Discard, r.Body)
		w.WriteHeader(201)
	case "HEAD", "GET":
		if !a.exists {
			w.Header().Set("x-ms-error-code", "BlobNotFound")
			w.WriteHeader(404)
			return
		}
		w.Header().Set("ETag", `"1"`)
		w.Header().Set("x-ms-blob-type", "AppendBlob")
		w.Header().Set("Content-Length", strconv.Itoa(len(a.data)))
		w.WriteHeader(200)
		if r.Method == "GET" {
			w.Write(a.data)
		}
	case "DELETE":
		a.exists = false
		w.WriteHeader(202)
	default:
		w.WriteHeader(500)
	}
}
func TestArchiveControlledHTTP(t *testing.T) {
	a := &archiveHTTP{}
	server := httptest.NewServer(http.HandlerFunc(a.serve))
	defer server.Close()
	c, err := container.NewClientWithNoCredential(server.URL+"/container", nil)
	if err != nil {
		t.Fatal(err)
	}
	g, err := local.NewStandaloneGates(uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(c, g, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	n, _ := sessionarchive.NewNamespace(sessionarchive.Projects, owner, task)
	ctx := t.Context()
	if _, err = s.AcquireArchiveStaging(ctx, sessionarchive.Namespace{}, true); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("namespace: %v", err)
	}
	h, err := s.AcquireArchiveStaging(ctx, n, true)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Create(ctx, "invalid"); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatal(err)
	}
	if err = h.Create(ctx, objID); err != nil {
		t.Fatal(err)
	}
	if err = h.Create(ctx, objID); !errors.Is(err, os.ErrExist) {
		t.Fatal(err)
	}
	if err = h.AdoptEmpty(ctx, objID); err != nil {
		t.Fatal(err)
	}
	if _, err = h.Append(ctx, objID, 3, 0, []byte("ab")); !errors.Is(err, filestorage.ErrArchiveStagingOffset) {
		t.Fatal(err)
	}
	if offset, err := h.Append(ctx, objID, 3, 0, []byte("abc")); err != nil || offset != 3 {
		t.Fatalf("append: %d %v", offset, err)
	}
	if err = h.AdoptEmpty(ctx, objID); !errors.Is(err, filestorage.ErrArchiveStagingOffset) {
		t.Fatal(err)
	}
	if _, err = h.Observe(ctx, objID, 2); !errors.Is(err, filestorage.ErrArchiveStagingCorrupt) {
		t.Fatal(err)
	}
	if offset, err := h.Append(ctx, objID, 3, 0, []byte("abc")); !errors.Is(err, filestorage.ErrArchiveStagingOffset) || offset != 3 {
		t.Fatalf("offset: %d %v", offset, err)
	}
	o, err := h.Open(ctx, objID, 3)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Close(); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatal(err)
	}
	if got, err := io.ReadAll(o.Body); err != nil || string(got) != "abc" {
		t.Fatalf("read %q %v", got, err)
	}
	if err = o.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = h.Publish(ctx, objID, 3, sessionarchive.Bucket, n.Directory()+"/files/"+objID+"/content"); err != nil {
		t.Fatal(err)
	}
	if err = h.Delete(ctx, objID); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatal(err)
	}
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = h.Observe(ctx, objID, 3); !errors.Is(err, os.ErrClosed) {
		t.Fatal(err)
	}
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}

	h, err = s.AcquireArchiveStaging(ctx, n, false)
	if err != nil {
		t.Fatal(err)
	}
	a.failLease = true
	if _, err = h.Observe(ctx, objID, 3); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("lease conflict: %v", err)
	}
	a.failLease = false
	if _, err = h.Observe(ctx, objID, 3); err != nil {
		t.Fatal(err)
	}
	stage := h.(*archiveStaging)
	name, _ := stage.name(objID)
	stage.leases[name].cancel(filestorage.ErrGateLost)
	if _, err = h.Append(ctx, objID, 3, 0, []byte("abc")); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("lost lease: %v", err)
	}
	if err = h.Close(); !errors.Is(err, filestorage.ErrGateLost) {
		t.Fatalf("lost lease close: %v", err)
	}
}
