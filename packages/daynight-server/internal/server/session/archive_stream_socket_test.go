package session_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

type bindableArchiveReader interface {
	BindReadContext(context.Context) func() error
}

func TestArchiveStreamSocketCancellationAbortsResponseAndReleasesOperation(t *testing.T) {
	f := archiveHTTPSetup(t)
	path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + uuid.NewString() + "?offset=0"
	started := make(chan context.CancelFunc, 1)
	readResult := make(chan error, 1)
	installStreamStub(f, func(op *streamArchiveStub) {
		op.fileV2 = func(ctx context.Context, _ string, _ string, _, _ int64, _ string, input io.Reader) (sp.ArchiveFileReceipt, error) {
			child, cancel := context.WithCancel(ctx)
			defer cancel()
			binder, ok := input.(bindableArchiveReader)
			if !ok {
				t.Error("stream has no cancellable binding")
				return sp.ArchiveFileReceipt{}, errors.New("missing binding")
			}
			unbind := binder.BindReadContext(child)
			if unbind == nil {
				t.Error("socket deadline unavailable")
				return sp.ArchiveFileReceipt{}, errors.New("missing deadline")
			}
			defer unbind()
			var one [1]byte
			if _, err := io.ReadFull(input, one[:]); err != nil {
				return sp.ArchiveFileReceipt{}, err
			}
			started <- cancel
			_, err := io.ReadFull(input, one[:])
			readResult <- err
			return sp.ArchiveFileReceipt{}, err
		}
	})
	f.Expect(map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
	f.auth.ExpectCalls(1)
	finished := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { defer close(finished); f.handler.ServeHTTP(w, r) }))
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err = conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	_, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/octet-stream\r\nDaynight-Archive-Upload-Version: 2\r\nDaynight-File-Byte-Length: 2\r\nDaynight-File-SHA256: %s\r\nContent-Length: 2\r\n\r\nx", path, f.handler.token, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case cancel := <-started:
		cancel()
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not reach blocked read")
	}
	select {
	case err := <-readResult:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("socket read did not stop")
	}
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not release operation")
	}
	f.AssertReleased(t)
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err == nil {
		defer response.Body.Close()
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			t.Fatalf("canceled upload reported success: %d", response.StatusCode)
		}
	}
}

func TestArchiveStreamSocketSuccessfulUnbindKeepsConnectionReusable(t *testing.T) {
	f := archiveHTTPSetup(t)
	id := uuid.NewString()
	base := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + id
	installStreamStub(f, func(op *streamArchiveStub) {
		op.fileV2 = func(ctx context.Context, _ string, file string, _, _ int64, digest string, input io.Reader) (sp.ArchiveFileReceipt, error) {
			child, cancel := context.WithCancel(ctx)
			binder, ok := input.(bindableArchiveReader)
			if !ok {
				cancel()
				return sp.ArchiveFileReceipt{}, errors.New("missing binding")
			}
			unbind := binder.BindReadContext(child)
			if unbind == nil {
				cancel()
				return sp.ArchiveFileReceipt{}, errors.New("missing deadline")
			}
			data, err := io.ReadAll(input)
			err = errors.Join(err, unbind())
			cancel()
			if err != nil || string(data) != "{}" {
				return sp.ArchiveFileReceipt{}, errors.Join(err, errors.New("unexpected bytes"))
			}
			return sp.ArchiveFileReceipt{FileID: file, State: "receiving", ByteLength: "2", AcceptedOffset: "2", SHA256: digest}, nil
		}
	})
	server := httptest.NewServer(f.handler)
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err = conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	f.Expect(map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
	f.auth.ExpectCalls(1)
	_, err = fmt.Fprintf(conn, "PUT %s?offset=0 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/octet-stream\r\nDaynight-Archive-Upload-Version: 2\r\nDaynight-File-Byte-Length: 2\r\nDaynight-File-SHA256: %s\r\nContent-Length: 2\r\n\r\n{}", base, f.handler.token, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	if err = response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || response.Close {
		t.Fatalf("upload response: %+v", response)
	}
	f.AssertReleased(t)
	f.backend.Funcs.ArchiveFileStatus = func(context.Context, model.Principal, string, string, string, string) (sp.ArchiveFileReceipt, error) {
		return sp.ArchiveFileReceipt{FileID: id, UploadVersion: 2, State: "receiving", ByteLength: "2", AcceptedOffset: "2", SHA256: strings.Repeat("a", 64)}, nil
	}
	f.Expect(map[string]int{"ArchiveFileStatus": 1})
	f.auth.ExpectCalls(1)
	if _, err = fmt.Fprintf(conn, "GET %s/status HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\n\r\n", base, f.handler.token); err != nil {
		t.Fatal(err)
	}
	response, err = http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatalf("connection not reusable: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Daynight-Archive-Upload-Version") != "2" {
		t.Fatalf("status response: %+v", response)
	}
}
