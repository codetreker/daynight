package azure

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/google/uuid"
)

type leaseRequest struct {
	method, path, action, id string
}

type leaseTimerTransport struct {
	handler archiveHTTP
	mu      sync.Mutex
	leases  []leaseRequest
}

func (tr *leaseTimerTransport) Do(req *http.Request) (*http.Response, error) {
	// An HTTP server canonicalizes wire headers; the SDK sets some keys directly.
	request := req.Clone(req.Context())
	request.Header = make(http.Header, len(req.Header))
	for key, values := range req.Header {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	req = request
	if req.URL.Query().Get("comp") == "lease" {
		tr.mu.Lock()
		id := req.Header.Get("x-ms-lease-id")
		if id == "" {
			id = req.Header.Get("x-ms-proposed-lease-id")
		}
		tr.leases = append(tr.leases, leaseRequest{req.Method, req.URL.Path, req.Header.Get("x-ms-lease-action"), id})
		tr.mu.Unlock()
	}
	recorder := httptest.NewRecorder()
	tr.handler.serve(recorder, req)
	response := recorder.Result()
	response.Request = req
	return response, nil
}

func (tr *leaseTimerTransport) requests() []leaseRequest {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	return append([]leaseRequest(nil), tr.leases...)
}

func TestArchiveLeaseDefaultTimer(t *testing.T) {
	transport := &leaseTimerTransport{handler: archiveHTTP{exists: true}}
	c, err := container.NewClientWithNoCredential("http://azure.invalid/container", &container.ClientOptions{ClientOptions: azcore.ClientOptions{Transport: transport}})
	if err != nil {
		t.Fatal(err)
	}
	gates, err := local.NewStandaloneGates(uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	storage, err := New(c, gates, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Projects, owner, task)
	if err != nil {
		t.Fatal(err)
	}
	synctest.Test(t, func(t *testing.T) {
		handle, err := storage.AcquireArchiveStaging(t.Context(), namespace, true)
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := handle.Close(); err != nil {
				t.Error(err)
			}
		}()
		if offset, err := handle.Observe(t.Context(), objID, 0); err != nil || offset != 0 {
			t.Fatalf("initial observation: offset=%d err=%v", offset, err)
		}
		stage := handle.(*archiveStaging)
		name, err := stage.name(objID)
		if err != nil {
			t.Fatal(err)
		}
		lease := stage.leases[name]
		initialDeadline := lease.until
		synctest.Wait() // Ensure the production goroutine has started its ticker.
		time.Sleep(20 * time.Second)
		synctest.Wait() // The SDK response and deadline update have completed.
		requests := transport.requests()
		if len(requests) != 2 || requests[0].action != "acquire" || requests[1].action != "renew" ||
			requests[0].method != http.MethodPut || requests[1].method != http.MethodPut ||
			requests[0].path != requests[1].path || requests[0].id == "" || requests[0].id != requests[1].id {
			t.Fatalf("lease requests: %+v", requests)
		}
		lease.mu.Lock()
		deadline := lease.until
		lease.mu.Unlock()
		if !deadline.Equal(initialDeadline.Add(20 * time.Second)) {
			t.Fatalf("renewal deadline: got %v, initial %v", deadline, initialDeadline)
		}
		if offset, err := handle.Observe(t.Context(), objID, 0); err != nil || offset != 0 {
			t.Fatalf("renewed observation: offset=%d err=%v", offset, err)
		}
		if err := handle.Close(); err != nil {
			t.Fatal(err)
		}
		select {
		case <-lease.done:
		default:
			t.Fatal("renewal loop still running after close")
		}
		time.Sleep(40 * time.Second)
		synctest.Wait()
		requests = transport.requests()
		if len(requests) != 3 || requests[2].action != "release" || requests[2].method != http.MethodPut || requests[2].path != requests[0].path || requests[2].id != requests[0].id {
			t.Fatalf("lease requests after close: %+v", requests)
		}
	})
}
