package session_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type unifiedArchiveStub struct {
	*archiveUploadStub
	prepare  func(context.Context, sp.ArchivePrepareRequest) (sp.ArchivePrepareReceipt, error)
	source   func(context.Context, sp.ArchiveSourceTailRequest) (sp.ArchiveSourceTailReceipt, error)
	file     func(context.Context, string, string, int64, int64, string, string, []byte) (sp.ArchiveFileReceipt, error)
	seal     func(context.Context) (sp.ArchivePrepareReceipt, error)
	manifest func(context.Context, []byte) (sp.ArchiveStatus, error)
}

func (s *unifiedArchiveStub) PrepareArchive(ctx context.Context, in sp.ArchivePrepareRequest) (sp.ArchivePrepareReceipt, error) {
	if s.prepare == nil {
		s.t.Fatal("unexpected prepare")
	}
	return s.prepare(ctx, in)
}
func (s *unifiedArchiveStub) AppendArchiveSourceTail(ctx context.Context, in sp.ArchiveSourceTailRequest) (sp.ArchiveSourceTailReceipt, error) {
	if s.source == nil {
		s.t.Fatal("unexpected source tail")
	}
	return s.source(ctx, in)
}
func (s *unifiedArchiveStub) PutArchiveFile(ctx context.Context, purpose, id string, offset, length int64, hash, chunk string, body []byte) (sp.ArchiveFileReceipt, error) {
	if s.file == nil {
		s.t.Fatal("unexpected file")
	}
	return s.file(ctx, purpose, id, offset, length, hash, chunk, body)
}
func (s *unifiedArchiveStub) PutArchiveResource(context.Context, string, int64, int64, string, string, []byte, sp.Resource) (sp.ArchiveFileReceipt, error) {
	s.t.Fatal("unexpected resource")
	return sp.ArchiveFileReceipt{}, nil
}
func (s *unifiedArchiveStub) SealArchive(ctx context.Context) (sp.ArchivePrepareReceipt, error) {
	if s.seal == nil {
		s.t.Fatal("unexpected seal")
	}
	return s.seal(ctx)
}
func (s *unifiedArchiveStub) PutArchiveManifest(ctx context.Context, body []byte) (sp.ArchiveStatus, error) {
	if s.manifest == nil {
		s.t.Fatal("unexpected manifest")
	}
	return s.manifest(ctx, body)
}
func setupUnifiedStub(f *archiveHTTPFixture, configure func(*unifiedArchiveStub)) {
	original := f.backend.Funcs.BeginArchiveReserved
	f.backend.Funcs.BeginArchiveReserved = func(ctx context.Context, p model.Principal, project, task, id string, mode sessioncore.ArchiveMode, lease io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
		op, err := original(ctx, p, project, task, id, mode, lease)
		if err != nil {
			return nil, err
		}
		out := &unifiedArchiveStub{archiveUploadStub: op.(*archiveUploadStub)}
		configure(out)
		return out, nil
	}
}

func TestUnifiedArchivePrepareStrictBranchesAndRawManifest(t *testing.T) {
	f := archiveHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	input := sp.ArchivePrepareRequest{Fence: f.snapshot.Fence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID}
	calls := 0
	setupUnifiedStub(f, func(op *unifiedArchiveStub) {
		op.prepare = func(ctx context.Context, actual sp.ArchivePrepareRequest) (sp.ArchivePrepareReceipt, error) {
			calls++
			if !reflect.DeepEqual(actual, input) {
				t.Fatal(actual, input)
			}
			return sp.ArchivePrepareReceipt{RecordID: f.snapshot.SessionID, Phase: "settling", Resources: []sp.ArchiveResourceReference{}, HistoryEpoch: "original", SourceThrough: "7"}, nil
		}
	})
	expected := map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1}
	for _, reset := range []bool{false, true} {
		if reset {
			input.ExpectedTimelineRevision = "2"
			input.FailedFileID = uuid.NewString()
		}
		response := f.Request(http.MethodPost, base+"/prepare", jsonBody(t, input), expected)
		if response.Code != 200 || !strings.Contains(response.Body.String(), `"sourceThrough":"7"`) {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	partial := map[string]any{"fence": input.Fence, "controllerId": input.ControllerID, "controllerInstanceId": input.ControllerInstanceID, "failedFileId": input.FailedFileID}
	if response := f.Request(http.MethodPost, base+"/prepare", jsonBody(t, partial), expected); response.Code != 400 {
		t.Fatal(response.Code, response.Body.String())
	}
	if response := f.Request(http.MethodPost, base+"/prepare?extra=1", jsonBody(t, input), map[string]int{"TryReserveArchivePreflight": 1}); response.Code != 400 {
		t.Fatal(response.Code)
	}
	if calls != 2 {
		t.Fatal("malformed prepare reached core", calls)
	}
}

func TestUnifiedArchiveHistoryAdapterPreservesHeadersRevisionAndSourceTail(t *testing.T) {
	f := archiveHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	id := uuid.NewString()
	revision := "3"
	setupUnifiedStub(f, func(op *unifiedArchiveStub) {
		op.file = func(ctx context.Context, purpose, file string, offset, length int64, hash, chunk string, body []byte) (sp.ArchiveFileReceipt, error) {
			if purpose != "history" || file != id || offset != 0 || length != 2 || hash != strings.Repeat("a", 64) || chunk != strings.Repeat("b", 64) || string(body) != "{}" {
				t.Fatal(purpose, file, offset, length, hash, chunk, string(body))
			}
			return sp.ArchiveFileReceipt{FileID: id, State: "complete", AcceptedOffset: "2", ByteLength: "2", SHA256: hash, TimelineRevision: &revision}, nil
		}
		op.source = func(ctx context.Context, in sp.ArchiveSourceTailRequest) (sp.ArchiveSourceTailReceipt, error) {
			if in.Fence != f.snapshot.Fence || in.SourceEpoch != id || len(in.Events) != 1 || in.Events[0].SourceSeq != "1" {
				t.Fatal(in)
			}
			return sp.ArchiveSourceTailReceipt{SourceEpoch: id, BatchID: in.BatchID, LastAckedSourceSeq: "1"}, nil
		}
	})
	expected := map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1}
	f.Expect(expected)
	f.auth.ExpectCalls(1)
	request := httptest.NewRequest(http.MethodPut, base+"/prepare/history/"+id+"?offset=0", strings.NewReader("{}"))
	authorizeResourceRequest(f.handler, request)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Daynight-File-Byte-Length", "2")
	request.Header.Set("Daynight-File-SHA256", strings.Repeat("a", 64))
	request.Header.Set("Daynight-Chunk-SHA256", strings.Repeat("b", 64))
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"timelineRevision":"3"`) || !strings.Contains(response.Body.String(), `"syncId":"`+id+`"`) {
		t.Fatal(response.Code, response.Body.String())
	}
	entry := `{"entryId":"` + uuid.NewString() + `","revision":"1","kind":"assistant_message","content":[{"type":"text","text":"tail"}]}`
	body := `{"fence":` + jsonBody(t, f.snapshot.Fence) + `,"controllerId":"` + f.registration.ControllerID + `","controllerInstanceId":"` + f.registration.ControllerInstanceID + `","sourceEpoch":"` + id + `","batchId":"` + uuid.NewString() + `","events":[{"sourceSeq":"1","kind":"timeline_upsert","payload":` + entry + `}]}`
	response = f.Request(http.MethodPost, base+"/source-tail", body, expected)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"lastAckedSourceSeq":"1"`) {
		t.Fatal(response.Code, response.Body.String())
	}
	if response = f.Request(http.MethodPut, base+"/files/not-an-id?offset=0", "{}", map[string]int{"TryReserveArchivePreflight": 1}); response.Code != 400 {
		t.Fatal(response.Code)
	}
}

func TestUnifiedManifestKeepsOriginalBytesAndReleasesOnFailure(t *testing.T) {
	for _, reject := range []bool{false, true} {
		t.Run(map[bool]string{false: "published", true: "closure rejected"}[reject], func(t *testing.T) {
			f := archiveHTTPSetup(t)
			original := `{ "schemaVersion":3,"label":"原件" }`
			setupUnifiedStub(f, func(op *unifiedArchiveStub) {
				op.manifest = func(_ context.Context, body []byte) (sp.ArchiveStatus, error) {
					if string(body) != original {
						t.Fatal("manifest bytes were re-encoded", string(body))
					}
					if reject {
						return sp.ArchiveStatus{}, &model.Fault{Code: "archive_conflict", Message: "Original closure differs."}
					}
					return sp.ArchiveStatus{State: "ready"}, nil
				}
			})
			response := f.Request(http.MethodPut, f.base+"/"+f.snapshot.SessionID+"/archive/content", original, map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
			want := 200
			if reject {
				want = 409
			}
			if response.Code != want {
				t.Fatal(response.Code, response.Body.String())
			}
			f.AssertReleased(t)
		})
	}
}

func TestUnifiedManifestRejectsInvalidBodiesBeforePublication(t *testing.T) {
	for _, tc := range []struct {
		name, body, contentType string
		status                  int
	}{
		{"empty", "", "application/json", 400},
		{"wrong content type", "{}", "text/html", 400},
		{"unsupported charset", "{}", "application/json; charset=latin1", 400},
		{"over byte limit", strings.Repeat(" ", sp.MaxArchiveManifestBytes+1), "application/json", 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			setupUnifiedStub(f, func(*unifiedArchiveStub) {})
			f.Expect(map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
			f.auth.ExpectCalls(1)
			r := httptest.NewRequest(http.MethodPut, f.base+"/"+f.snapshot.SessionID+"/archive/content", strings.NewReader(tc.body))
			authorizeResourceRequest(f.handler, r)
			r.Header.Set("Content-Type", tc.contentType)
			response := httptest.NewRecorder()
			f.handler.ServeHTTP(response, r)
			if response.Code != tc.status {
				t.Fatal(response.Code, response.Body.String())
			}
			f.AssertReleased(t)
		})
	}
}

func TestUnifiedSealPublishesOnlyWithoutBodyOrQuery(t *testing.T) {
	f := archiveHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive/seal"
	calls := 0
	setupUnifiedStub(f, func(op *unifiedArchiveStub) {
		op.seal = func(context.Context) (sp.ArchivePrepareReceipt, error) {
			calls++
			return sp.ArchivePrepareReceipt{RecordID: f.snapshot.SessionID, Phase: "sealed"}, nil
		}
	})
	if response := f.Request(http.MethodPost, base, "", map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1}); response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	f.AssertReleased(t)
	for _, tc := range []struct{ suffix, body string }{{"", "{}"}, {"?extra=1", ""}} {
		if response := f.Request(http.MethodPost, base+tc.suffix, tc.body, map[string]int{"TryReserveArchivePreflight": 1}); response.Code != 400 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	if calls != 1 {
		t.Fatal("invalid seal reached publication", calls)
	}
}
