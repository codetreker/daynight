package mcp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

type responseLease struct{ closed chan struct{} }

func (l *responseLease) Close() error { close(l.closed); return nil }

type retainingUpload struct{ lease *responseLease }

func (u retainingUpload) Execute(ctx context.Context, _ transfer.Actor, _, _ string, _ mcptransfer.UploadInput) (map[string]any, error) {
	if !attachmentservice.RetainUploadLease(ctx, u.lease) {
		return nil, io.ErrUnexpectedEOF
	}
	return map[string]any{"state": "receiving", "nextOffset": "0"}, nil
}

type blockedUploadResponse struct {
	*httptest.ResponseRecorder
	entered, release chan struct{}
	once             sync.Once
}

func (w *blockedUploadResponse) Unwrap() http.ResponseWriter { return w.ResponseRecorder }
func (w *blockedUploadResponse) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	<-w.release
	return w.ResponseRecorder.Write(p)
}

func TestUploadLeaseCoversHTTPResponse(t *testing.T) {
	f := newEntryFixture(t)
	lease := &responseLease{closed: make(chan struct{})}
	if err := RegisterUploadTools(f.entry, retainingUpload{lease: lease}); err != nil {
		t.Fatal(err)
	}
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_attachment_put","arguments":{"projectId":"` + invitationTestProjectID + `","taskId":"` + invitationTestTeamID + `","action":"inline","path":"file","contentType":"text/plain","contentBase64":"YQ=="}}}`
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer alice")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	r.Header.Set("MCP-Protocol-Version", "2025-11-25")
	w := &blockedUploadResponse{ResponseRecorder: httptest.NewRecorder(), entered: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() { f.entry.ServeHTTP(w, r); close(done) }()
	select {
	case <-w.entered:
	case <-time.After(5 * time.Second):
		close(w.release)
		t.Fatal("response did not reach writer")
	}
	select {
	case <-lease.closed:
		close(w.release)
		t.Fatal("lease released before response completed")
	default:
	}
	close(w.release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("response did not finish")
	}
	select {
	case <-lease.closed:
	case <-time.After(5 * time.Second):
		t.Fatalf("lease not released after response: status=%d body=%s", w.Code, w.Body)
	}
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"data"`) {
		t.Fatalf("response status=%d body=%s", w.Code, w.Body)
	}
}
