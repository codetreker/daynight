package session_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type ledgerHTTPStub struct {
	*archiveUploadStub
	id     string
	writer sessioncore.ActiveHistoryWriter
}

func (s *ledgerHTTPStub) PutHistoryLedger(_ context.Context, writer sessioncore.ActiveHistoryWriter, id string, offset, length int64, digest, chunk string, body []byte) (sp.ArchiveFileReceipt, error) {
	if writer != s.writer || id != s.id || offset != 0 || length != 2 || digest != strings.Repeat("a", 64) || chunk != strings.Repeat("b", 64) || string(body) != "{}" {
		s.t.Fatal("history HTTP changed original metadata", writer, id, offset, length)
	}
	return s.HistoryLedgerStatus(context.Background(), writer, id)
}
func (s *ledgerHTTPStub) HistoryLedgerStatus(_ context.Context, writer sessioncore.ActiveHistoryWriter, id string) (sp.ArchiveFileReceipt, error) {
	if writer != s.writer || id != s.id {
		s.t.Fatal("history HTTP changed original identity", writer, id)
	}
	revision := "9"
	return sp.ArchiveFileReceipt{FileID: id, State: "complete", AcceptedOffset: "2", ByteLength: "2", SHA256: strings.Repeat("a", 64), TimelineRevision: &revision}, nil
}

func TestActiveHistoryHTTPUsesExistingGrantForTaskAndTestScopes(t *testing.T) {
	for _, scope := range []string{"task", "test"} {
		t.Run(scope, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			f.snapshot.ConnectionEpoch = "1"
			base := f.base + "/" + f.snapshot.SessionID
			project, task := f.task.ProjectID, f.task.ID
			if scope == "test" {
				f.snapshot.ClaimID = ""
				f.snapshot.TestExecutionID = uuid.NewString()
				base = "/api/v1/test-sessions/" + f.snapshot.SessionID
				project, task = "", ""
			}
			writer := sessioncore.ActiveHistoryWriter{Fence: f.snapshot.ControllerFence, Credential: "dncontroller_original-active-grant"}
			id := uuid.NewString()
			f.backend.Funcs.BeginHistoryLedgerReserved = func(_ context.Context, p, taskID, session string, actual sessioncore.ActiveHistoryWriter, reservation io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
				if p != project || taskID != task || session != f.snapshot.SessionID || actual != writer || reservation != f.reservation {
					t.Fatal("wrong delegated scope")
				}
				lease := newArchiveLeaseSpy(t)
				f.operation = lease
				f.operations = append(f.operations, lease)
				return &ledgerHTTPStub{archiveUploadStub: &archiveUploadStub{archiveLeaseSpy: lease, fixture: f}, id: id, writer: writer}, nil
			}
			send := func(method, path string, change func(*http.Request), begin bool) *httptest.ResponseRecorder {
				expected := map[string]int{"TryReserveArchivePreflight": 1}
				if begin {
					expected["BeginHistoryLedgerReserved"] = 1
				}
				f.Expect(expected)
				f.auth.ExpectCalls(0)
				r := httptest.NewRequest(method, path, strings.NewReader("{}"))
				r.Header.Set("Authorization", "Bearer "+writer.Credential)
				r.Header.Set("Daynight-Controller-Fence", jsonBody(t, writer.Fence))
				r.Header.Set("Content-Type", "application/octet-stream")
				r.Header.Set("Daynight-File-Byte-Length", "2")
				r.Header.Set("Daynight-File-SHA256", strings.Repeat("a", 64))
				r.Header.Set("Daynight-Chunk-SHA256", strings.Repeat("b", 64))
				if change != nil {
					change(r)
				}
				w := httptest.NewRecorder()
				f.handler.ServeHTTP(w, r)
				return w
			}
			path := base + "/image-history-ledger/" + id
			for _, method := range []string{http.MethodPut, http.MethodGet} {
				suffix := "?offset=0"
				if method == http.MethodGet {
					suffix = "/status"
				}
				w := send(method, path+suffix, nil, true)
				if w.Code != 200 || !strings.Contains(w.Body.String(), `"timelineRevision":"9"`) {
					t.Fatal(w.Code, w.Body.String())
				}
			}
			for _, kind := range []string{"pat", "origin", "protocol", "duplicate-length", "duplicate-fence", "encoded", "unknown-query", "noncanonical", "missing-offset"} {
				t.Run(kind, func(t *testing.T) {
					target := path + "?offset=0"
					if kind == "unknown-query" {
						target += "&extra=1"
					}
					if kind == "noncanonical" {
						target = strings.Replace(target, id, strings.ToUpper(id), 1)
					}
					if kind == "missing-offset" {
						target = path
					}
					w := send(http.MethodPut, target, func(r *http.Request) {
						switch kind {
						case "pat":
							r.Header.Set("Authorization", "Bearer dnpat_wrong")
						case "origin":
							r.Header.Set("Origin", "https://other.example")
						case "protocol":
							r.Header.Set("Daynight-Session-Protocol", "daynight.session.v2")
						case "duplicate-length":
							r.Header.Add("Daynight-File-Byte-Length", "2")
						case "duplicate-fence":
							r.Header.Add("Daynight-Controller-Fence", jsonBody(t, writer.Fence))
						case "encoded":
							r.Header.Set("Content-Encoding", "gzip")
						}
					}, false)
					if w.Code < 400 {
						t.Fatal("invalid delegated request reached core", kind, w.Code)
					}
				})
			}
		})
	}
}
