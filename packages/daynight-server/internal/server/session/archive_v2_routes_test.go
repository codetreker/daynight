package session_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type archiveV2Stub struct {
	*unifiedArchiveStub
	put    func(string, string, int64, int64, string, string, []byte, *sp.Resource) (sp.ArchiveFileReceipt, error)
	action func(string, string, string) (sp.ArchiveFileReceipt, error)
}

func (s *archiveV2Stub) PutArchiveFileV2(_ context.Context, purpose, id string, offset, length int64, digest, chunk string, body []byte) (sp.ArchiveFileReceipt, error) {
	return s.put(purpose, id, offset, length, digest, chunk, body, nil)
}
func (s *archiveV2Stub) PutArchiveResourceV2(_ context.Context, id string, offset, length int64, digest, chunk string, body []byte, resource sp.Resource) (sp.ArchiveFileReceipt, error) {
	return s.put("resource", id, offset, length, digest, chunk, body, &resource)
}
func (s *archiveV2Stub) CompleteArchiveFile(_ context.Context, purpose, id string) (sp.ArchiveFileReceipt, error) {
	return s.action(purpose, id, "")
}
func (s *archiveV2Stub) RestartArchiveFile(_ context.Context, purpose, id, replacement string) (sp.ArchiveFileReceipt, error) {
	return s.action(purpose, id, replacement)
}

func setupArchiveV2Stub(f *archiveHTTPFixture, configure func(*archiveV2Stub)) {
	original := f.backend.Funcs.BeginArchiveReserved
	f.backend.Funcs.BeginArchiveReserved = func(ctx context.Context, p model.Principal, project, task, id string, mode core.ArchiveMode, lease io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
		op, err := original(ctx, p, project, task, id, mode, lease)
		if err != nil {
			return nil, err
		}
		stub := &archiveV2Stub{unifiedArchiveStub: &unifiedArchiveStub{archiveUploadStub: op.(*archiveUploadStub)}}
		configure(stub)
		return stub, nil
	}
}

func TestArchiveV2RoutesPropagateFileAndActions(t *testing.T) {
	for _, kind := range []string{"history", "timeline", "resource"} {
		t.Run(kind, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			id, successor, digest := uuid.NewString(), uuid.NewString(), strings.Repeat("a", 64)
			base := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + id
			purpose := "timeline"
			if kind == "history" {
				base, purpose = f.base+"/"+f.snapshot.SessionID+"/archive/prepare/history/"+id, "history"
			}
			descriptor := sp.Resource{ResourceID: uuid.NewString(), Status: "unavailable", Name: "legacy"}
			calls := 0
			setupArchiveV2Stub(f, func(op *archiveV2Stub) {
				op.put = func(gotPurpose, file string, offset, length int64, hash, chunk string, body []byte, resource *sp.Resource) (sp.ArchiveFileReceipt, error) {
					calls++
					if gotPurpose != kind || file != id || offset != 0 || length != 2 || hash != digest || chunk != digest || string(body) != "[]" || (resource != nil) != (kind == "resource") {
						t.Fatal("v2 upload changed its request", gotPurpose, file, offset, length, hash, chunk, string(body), resource)
					}
					return sp.ArchiveFileReceipt{FileID: id, State: "receiving", AcceptedOffset: "2", ByteLength: "2", SHA256: digest}, nil
				}
				op.action = func(gotPurpose, file, replacement string) (sp.ArchiveFileReceipt, error) {
					calls++
					if gotPurpose != purpose || file != id || replacement != "" && replacement != successor {
						t.Fatal("v2 action changed identity", gotPurpose, file, replacement)
					}
					result := sp.ArchiveFileReceipt{FileID: id, State: "complete", AcceptedOffset: "2", ByteLength: "2", SHA256: digest}
					if replacement != "" {
						result.State, result.SuccessorFileID = "failed", &successor
					}
					return result, nil
				}
			})
			headers := map[string]string{"Content-Type": "application/octet-stream", "Daynight-Archive-Upload-Version": "2", "Daynight-File-Byte-Length": "2", "Daynight-File-SHA256": digest, "Daynight-Chunk-SHA256": digest}
			path := base + "?offset=0"
			if kind == "resource" {
				path += "&purpose=resource&migrationOnly=true"
				headers["Daynight-Resource-Descriptor"] = jsonBody(t, descriptor)
			}
			for _, req := range []struct {
				method, path, body string
				headers            map[string]string
			}{
				{http.MethodPut, path, "[]", headers},
				{http.MethodPost, base + "/complete", "", map[string]string{"Daynight-Archive-Upload-Version": "2"}},
				{http.MethodPost, base + "/restart", `{"replacementFileId":"` + successor + `"}`, map[string]string{"Daynight-Archive-Upload-Version": "2"}},
			} {
				w := archiveBoundaryRequest(f, req.method, req.path, req.body, req.headers, map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
				if w.Code != 200 || w.Header().Get("Daynight-Archive-Upload-Version") != "2" || !strings.Contains(w.Body.String(), `"state":`) {
					t.Fatal(w.Code, w.Header(), w.Body.String())
				}
				if strings.HasSuffix(req.path, "/restart") && !strings.Contains(w.Body.String(), `"successorFileId":"`+successor+`"`) {
					t.Fatal("missing restart receipt", w.Body.String())
				}
				f.AssertReleased(t)
			}
			if calls != 3 {
				t.Fatal("unexpected operation count", calls)
			}
		})
	}
}

func TestArchiveV2RejectsInvalidActionsBeforeCore(t *testing.T) {
	for _, tc := range []struct {
		endpoint, body, version, suffix string
		begin                           bool
	}{
		{"complete", "", "", "", false},
		{"complete", "", "1", "", false},
		{"complete", "x", "2", "", true},
		{"restart", `{}`, "2", "", true},
		{"restart", `{"replacementFileId":"bad"}`, "2", "", true},
		{"restart", `{"replacementFileId":"` + uuid.NewString() + `","replacementFileId":"` + uuid.NewString() + `"}`, "2", "", true},
		{"restart", `{"replacementFileId":"` + uuid.NewString() + `"} {}`, "2", "", true},
		{"restart", `{"replacementFileId":"` + uuid.NewString() + `"}`, "2", "?extra=1", false},
	} {
		t.Run(tc.endpoint+"/"+tc.body+"/"+tc.version+tc.suffix, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			setupArchiveV2Stub(f, func(op *archiveV2Stub) {
				op.action = func(string, string, string) (sp.ArchiveFileReceipt, error) {
					t.Fatal("invalid request reached core")
					return sp.ArchiveFileReceipt{}, nil
				}
			})
			headers := map[string]string{}
			if tc.version != "" {
				headers["Daynight-Archive-Upload-Version"] = tc.version
			}
			calls := map[string]int{"TryReserveArchivePreflight": 1}
			if tc.begin {
				calls["BeginArchiveReserved"] = 1
			}
			path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + uuid.NewString() + "/" + tc.endpoint + tc.suffix
			w := archiveBoundaryRequest(f, http.MethodPost, path, tc.body, headers, calls)
			if w.Code != 400 {
				t.Fatal(w.Code, w.Body.String())
			}
			f.AssertReleased(t)
		})
	}
}

func TestArchiveUploadVersionReadHeaders(t *testing.T) {
	for _, version := range []int{1, 2} {
		t.Run(string(rune('0'+version)), func(t *testing.T) {
			f := archiveHTTPSetup(t)
			id := uuid.NewString()
			f.backend.Funcs.ArchiveFileStatus = func(context.Context, model.Principal, string, string, string, string) (sp.ArchiveFileReceipt, error) {
				return sp.ArchiveFileReceipt{FileID: id, State: "receiving", UploadVersion: version}, nil
			}
			path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + id + "/status"
			w := f.Request(http.MethodGet, path, "", map[string]int{"ArchiveFileStatus": 1})
			if w.Code != 200 || w.Header().Get("Daynight-Archive-Upload-Version") != string(rune('0'+version)) {
				t.Fatal(w.Code, w.Header(), w.Body.String())
			}
		})
	}
}

func TestArchiveUploadVersionRejectsInvalidPutBeforeOperation(t *testing.T) {
	for _, versions := range [][]string{{"3"}, {""}, {"2", "1"}, {"2, 1"}} {
		t.Run(strings.Join(versions, "/"), func(t *testing.T) {
			f := archiveHTTPSetup(t)
			path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + uuid.NewString() + "?offset=0"
			f.Expect(map[string]int{"TryReserveArchivePreflight": 1})
			f.auth.ExpectCalls(1)
			r := httptest.NewRequest(http.MethodPut, path, strings.NewReader("x"))
			authorizeResourceRequest(f.handler, r)
			r.Header[http.CanonicalHeaderKey("Daynight-Archive-Upload-Version")] = versions
			r.Header.Set("Daynight-File-Byte-Length", "1")
			r.Header.Set("Daynight-File-SHA256", strings.Repeat("a", 64))
			r.Header.Set("Daynight-Chunk-SHA256", strings.Repeat("a", 64))
			r.Header.Set("Content-Type", "application/octet-stream")
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, r)
			if w.Code != 400 {
				t.Fatal(w.Code, w.Body.String())
			}
			f.AssertReleased(t)
		})
	}
}

func TestArchivePreparationAdvertisesUploadSupport(t *testing.T) {
	f := archiveHTTPSetup(t)
	f.backend.Funcs.ArchivePreparation = func(context.Context, model.Principal, string, string, string) (sp.ArchivePrepareReceipt, error) {
		return sp.ArchivePrepareReceipt{Phase: "settling"}, nil
	}
	w := f.Request(http.MethodGet, f.base+"/"+f.snapshot.SessionID+"/archive/prepare", "", map[string]int{"ArchivePreparation": 1})
	if w.Code != 200 || w.Header().Get("Daynight-Archive-Upload-Version") != "2" {
		t.Fatal(w.Code, w.Header(), w.Body.String())
	}
}
