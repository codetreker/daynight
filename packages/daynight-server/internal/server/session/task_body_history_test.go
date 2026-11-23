package session

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

func TestTaskBodyHistoryHeaderRequiresExplicitSupportedNegotiation(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	for _, header := range []string{"", "1", "2", "1, 1"} {
		t.Run("header="+header, func(t *testing.T) {
			mock := historyRouteMock{read: func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
				return ss.NewReadResult(sp.MessagePage{ContentPolicy: "task_body", SessionID: id, Source: "archive", Items: []sp.MessageItem{}}, nil), nil
			}}
			mux := http.NewServeMux()
			RegisterHistoryRoutes(mux, mock, inspectionRouteAuth{model.Principal{}}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			req := httptest.NewRequest("GET", "/api/v1/projects/"+id+"/tasks/"+id+"/sessions/"+id+"/messages", nil)
			if header != "" {
				req.Header.Set("Daynight-Task-Body-History-Version", header)
			}
			res := httptest.NewRecorder()
			mux.ServeHTTP(res, req)
			want := ""
			if header == "1" {
				want = "task_body"
			}
			if res.Code != 200 || res.Header().Get("Daynight-Session-Content-Policy") != want || res.Header().Get("Daynight-Task-Body-History-Version") != "1" || strings.Contains(res.Body.String(), "contentPolicy") {
				t.Fatal(res.Code, res.Header(), res.Body.String())
			}
		})
	}
}

func TestTaskBodyArchiveDownloadNegotiatesAndClosesLease(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	for _, policy := range []string{"", "task_body"} {
		for _, version := range []string{"", "1", "2", "1, 1"} {
			t.Run(policy+"/"+version, func(t *testing.T) {
				manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentPolicy: policy, ContentKind: "native_timeline", RecordID: id, Fence: sp.Fence{SessionID: id, ClaimID: id, ExecutionGeneration: "1"}, ControllerID: id, ControllerInstanceID: id, Provider: "codex", Timeline: sp.ArchiveFileReference{FileID: id, SHA256: strings.Repeat("a", 64), ByteLength: "14"}, Resources: []sp.ArchiveResourceReference{}, Completeness: "complete"}
				data, err := sp.MarshalWire(manifest)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = sp.DecodeArchiveManifest(data); err != nil {
					t.Fatal(err)
				}
				closes := 0
				h := &Routes{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), service: serviceCalls{ArchiveContentReserved: func(context.Context, model.Principal, string, string, string, io.Closer) (archiveContent, error) {
					return archiveContent{Data: data, Closer: historyCloser(func() error { closes++; return nil })}, nil
				}}}
				req := httptest.NewRequest("GET", "/archive/content", nil)
				if version != "" {
					req.Header.Set("Daynight-Task-Body-History-Version", version)
				}
				res := httptest.NewRecorder()
				h.archiveContent(res, req, model.Principal{})
				want := http.StatusOK
				if policy == "task_body" && version != "1" {
					want = http.StatusNotImplemented
				}
				if res.Code != want || closes != 1 {
					t.Fatal(res.Code, closes, res.Body.String())
				}
				if want == http.StatusOK && res.Body.String() != string(data) {
					t.Fatal(res.Body.String())
				}
				if want != http.StatusOK && !strings.Contains(res.Body.String(), "upgrade_required") {
					t.Fatal(res.Body.String())
				}
			})
		}
	}
}
