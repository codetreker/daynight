//go:build stress

package session_test

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type socketCapacityOperation struct {
	*core.ArchiveOperation
	closed chan struct{}
}

func (op *socketCapacityOperation) Close() error {
	err := op.ArchiveOperation.Close()
	close(op.closed)
	return err
}

// The metadata preflight is controlled; HTTP, the shared Engine, the local
// owner gate and TCP request-body lifetime are real. Database owner lookup is
// verified separately by the service tests.
func TestArchiveCapacityAcrossSlowSockets(t *testing.T) {
	for _, tc := range []struct {
		name        string
		count       int
		sharedOwner bool
	}{{"instance", 20, false}, {"owner", 5, true}} {
		t.Run(tc.name, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			engine := core.NewEngine(files, core.ArchiveLimits{MaxConcurrent: 20, MaxConcurrentPerOwner: 5})
			defer engine.Stop(context.Background())
			execution := core.NewExecution(engine, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
			owner := uuid.NewString()
			execution.SetArchivePreflight(func(_ context.Context, _ model.Principal, _, _, id string, _ core.ArchiveMode) (string, error) {
				if tc.sharedOwner {
					return owner, nil
				}
				return id, nil
			})
			started := make(chan chan struct{}, tc.count+1)
			f.backend.Funcs.TryReserveArchivePreflight = func() (io.Closer, error) { return execution.TryReserveArchivePreflight() }
			f.backend.Funcs.BeginArchiveReserved = func(ctx context.Context, p model.Principal, project, task, id string, mode core.ArchiveMode, reservation io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
				op, err := execution.BeginArchiveReserved(ctx, p, project, task, id, mode, reservation.(*core.ArchivePreflightReservation))
				if err != nil {
					return nil, err
				}
				closed := make(chan struct{})
				started <- closed
				return &socketCapacityOperation{ArchiveOperation: op, closed: closed}, nil
			}
			f.backend.ExpectCalls("TryReserveArchivePreflight", tc.count+2)
			f.backend.ExpectCalls("BeginArchiveReserved", tc.count+1+btoi(tc.sharedOwner))
			f.auth.ExpectCalls(tc.count + 1 + btoi(tc.sharedOwner))
			server := httptest.NewServer(f.handler)
			defer server.Close()
			var sockets []net.Conn
			defer func() {
				for _, c := range sockets {
					_ = c.Close()
				}
			}()
			start := func() (net.Conn, chan struct{}) {
				id := uuid.NewString()
				conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
				if err != nil {
					t.Fatal(err)
				}
				sockets = append(sockets, conn)
				path := f.base + "/" + id + "/archive"
				if _, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{", path, f.handler.token); err != nil {
					t.Fatal(err)
				}
				select {
				case done := <-started:
					return conn, done
				case <-time.After(5 * time.Second):
					t.Fatal("socket admission timed out")
					return nil, nil
				}
			}
			var closes []chan struct{}
			for i := 0; i < tc.count; i++ {
				_, done := start()
				closes = append(closes, done)
			}
			req, err := http.NewRequest(http.MethodPut, server.URL+f.base+"/"+uuid.NewString()+"/archive", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+f.handler.token)
			req.Header.Set("Content-Type", "application/json")
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if err != nil || resp.StatusCode != 429 || !strings.Contains(string(body), `"resource_busy"`) {
				t.Fatalf("capacity response: %d %q %v", resp.StatusCode, body, err)
			}
			if err := sockets[0].Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case <-closes[0]:
			case <-time.After(5 * time.Second):
				t.Fatal("disconnect did not release capacity")
			}
			_, final := start()
			if err := sockets[len(sockets)-1].Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case <-final:
			case <-time.After(5 * time.Second):
				t.Fatal("replacement socket did not release capacity")
			}
			for i := 1; i < tc.count; i++ {
				if err := sockets[i].Close(); err != nil {
					t.Fatal(err)
				}
			}
			for i := 1; i < tc.count; i++ {
				select {
				case <-closes[i]:
				case <-time.After(5 * time.Second):
					t.Fatal("socket capacity did not drain")
				}
			}
		})
	}
}
func btoi(value bool) int {
	if value {
		return 1
	}
	return 0
}
