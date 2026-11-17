package session_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
)

type terminalArchiveLease struct{ calls atomic.Int32 }

func (lease *terminalArchiveLease) Close() error { lease.calls.Add(1); return nil }

func terminalArchiveReady(t *testing.T) (*terminalHTTPFixture, string, []byte, v2.Receipt) {
	t.Helper()
	f := terminalHTTPSetup(t)
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/v2/valid-archive.json")
	if err != nil {
		t.Fatal(err)
	}
	document, err := v2.DecodeArchive(raw)
	if err != nil {
		t.Fatal(err)
	}
	document.SessionID, document.ClaimID, document.Owner = f.message.SessionID, f.message.ClaimID, f.message.Payload.(v2.Registration).Owner
	for index := range document.Runs {
		document.Runs[index].Owner = document.Owner
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte("\n \t\n")...)
	hash, size, complete := v2.HashBytes(data), strconv.Itoa(len(data)), "complete"
	receipt := v2.Receipt{FinalizationID: document.FinalizationID, Disposition: "ready", SHA256: &hash, ByteLength: &size, Completeness: &complete}
	message := f.message
	message.Type, message.Payload = "receipt", receipt
	receipt.DispositionDigest, err = v2.ReceiptDigest(message)
	if err != nil {
		t.Fatal(err)
	}
	f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.TryReserveArchivePreflight = func() (io.Closer, error) {
			lease := &terminalArchiveLease{}
			t.Cleanup(func() {
				if lease.calls.Load() != 1 {
					t.Errorf("archive reservation closes = %d, want 1", lease.calls.Load())
				}
			})
			return lease, nil
		}
		calls.TerminalArchiveContentReserved = func(ctx context.Context, p model.Principal, project, task, id string, reservation io.Closer) (sessionhttp.ArchiveContentForTest, error) {
			f.scope(t, ctx, p, project, task, id)
			if reservation == nil {
				t.Error("archive read lost its admission reservation")
			}
			lease := &terminalArchiveLease{}
			t.Cleanup(func() {
				if lease.calls.Load() != 1 {
					t.Errorf("archive content closes = %d, want 1", lease.calls.Load())
				}
			})
			return sessionhttp.ArchiveContentForTest{Data: data, Closer: lease}, nil
		}
	})
	return f, f.base + "/" + f.message.SessionID + "/archive", data, receipt
}

func TestTerminalArchiveDownloadPreservesReceiptBytes(t *testing.T) {
	f, path, data, receipt := terminalArchiveReady(t)
	response := terminalRequest(f.h, http.MethodGet, path+"/content", "", v2.Protocol)
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), data) {
		t.Fatal("archive content bytes changed", response.Code, response.Body.String())
	}
	if receipt.SHA256 == nil || *receipt.SHA256 != v2.HashBytes(response.Body.Bytes()) || receipt.ByteLength == nil || *receipt.ByteLength != strconv.Itoa(response.Body.Len()) {
		t.Fatal("provided receipt no longer describes the sent bytes", receipt)
	}
	if response.Header().Get("Content-Type") != "application/json" {
		t.Fatal(response.Header())
	}
}

func TestTerminalHistoryRequiresExplicitProtocol(t *testing.T) {
	f := terminalHTTPSetup(t)
	for _, protocol := range []string{"", sp.Protocol} {
		response := terminalRequest(f.h, http.MethodGet, f.base, "", protocol)
		assertProjectError(t, response, http.StatusBadRequest, "unsupported_protocol")
	}
	if got := f.calls.TotalCalls(); got != 0 {
		t.Fatalf("history request with v1 protocol called the service %d times", got)
	}
}

func TestTerminalHistoryHTTPPreservesProvidedResults(t *testing.T) {
	f := terminalHTTPSetup(t)
	var calls int
	f.calls.ExpectCalls("TerminalHistory", 3)
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.TerminalHistory = func(ctx context.Context, p model.Principal, project, task, cursor string, limit int) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, f.message.SessionID)
			calls++
			if cursor != "" {
				t.Error("history request introduced a cursor")
			}
			if calls == 2 {
				if limit != 0 {
					t.Error("history request changed the supplied zero limit")
				}
				return nil, &model.Fault{Code: "invalid_input", Message: "History limit is outside the supported range."}
			}
			if calls == 3 {
				if limit != 50 {
					t.Error("history request changed its default limit")
				}
				return nil, &model.Fault{Code: "not_found", Message: "The Task is unavailable."}
			}
			if limit != 1 {
				t.Error("history request changed the supplied limit")
			}
			return map[string]any{"items": []any{map[string]any{"sessionId": f.message.SessionID, "claimId": f.message.ClaimID, "archive": map[string]any{"state": "unavailable"}}}, "nextCursor": nil}, nil
		}
	})
	response := terminalRequest(f.h, http.MethodGet, f.base+"?limit=1", "", v2.Protocol)
	result := decodeResponse[map[string]any](t, response, http.StatusOK)
	items, ok := result["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("history response changed: %v", result)
	}
	item, ok := items[0].(map[string]any)
	if !ok {
		t.Fatalf("history item is not an object: %v", items[0])
	}
	archive, ok := item["archive"].(map[string]any)
	if !ok || item["sessionId"] != f.message.SessionID || item["claimId"] != f.message.ClaimID || archive["state"] != "unavailable" {
		t.Fatalf("history item changed: %v", items[0])
	}
	assertProjectError(t, terminalRequest(f.h, http.MethodGet, f.base+"?limit=0", "", v2.Protocol), http.StatusBadRequest, "invalid_input")
	for _, query := range []string{"?limit=no", "?extra=1"} {
		response := terminalRequest(f.h, http.MethodGet, f.base+query, "", v2.Protocol)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d %s", query, response.Code, response.Body.String())
		}
	}
	if calls != 2 {
		t.Fatalf("invalid history queries called the service: %d", calls)
	}
	assertProjectError(t, terminalRequest(f.h, http.MethodGet, f.base, "", v2.Protocol), http.StatusNotFound, "not_found")
}

func TestTerminalArchiveStatusHTTPPreservesUnavailableReadback(t *testing.T) {
	f := terminalHTTPSetup(t)
	status := f.message
	status.Type = "archive_status"
	status.Payload = v2.ArchiveStatus{State: "unavailable"}
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.TerminalArchiveStatus = func(ctx context.Context, p model.Principal, project, task, id string) (v2.Message, error) {
			f.scope(t, ctx, p, project, task, id)
			return status, nil
		}
	})
	response := terminalRequest(f.h, http.MethodGet, f.base+"/"+f.message.SessionID+"/archive", "", v2.Protocol)
	result := decodeResponse[map[string]any](t, response, http.StatusOK)
	payload, ok := result["payload"].(map[string]any)
	if !ok || result["type"] != "archive_status" || result["sessionId"] != f.message.SessionID || payload["state"] != "unavailable" {
		t.Fatalf("archive status changed: %v", result)
	}
}
