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
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func archiveBoundaryRequest(f *archiveHTTPFixture, method, path, body string, headers map[string]string, calls map[string]int) *httptest.ResponseRecorder {
	f.Expect(calls)
	f.auth.ExpectCalls(1)
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(f.handler, r)
	r.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		r.Header.Set(name, value)
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}

func TestUnifiedArchiveMetadataReadsPreserveReceiptsAndRejectExtraQuery(t *testing.T) {
	for _, kind := range []string{"preparation", "history", "timeline", "missing"} {
		t.Run(kind, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			base := f.base + "/" + f.snapshot.SessionID + "/archive"
			id, revision := uuid.NewString(), "9"
			path, method := base+"/files/"+id+"/status", "ArchiveFileStatus"
			if kind == "preparation" {
				path, method = base+"/prepare", "ArchivePreparation"
				f.backend.Funcs.ArchivePreparation = func(_ context.Context, p model.Principal, project, task, session string) (sp.ArchivePrepareReceipt, error) {
					if p != f.handler.principal || project != f.task.ProjectID || task != f.task.ID || session != f.snapshot.SessionID {
						t.Fatal("preparation read changed scope")
					}
					return sp.ArchivePrepareReceipt{RecordID: session, Phase: "sealed", TimelineRevision: &revision}, nil
				}
			} else {
				if kind == "history" {
					path = base + "/prepare/history/" + id + "/status"
				}
				f.backend.Funcs.ArchiveFileStatus = func(_ context.Context, p model.Principal, project, task, session, file string) (sp.ArchiveFileReceipt, error) {
					if p != f.handler.principal || project != f.task.ProjectID || task != f.task.ID || session != f.snapshot.SessionID || file != id {
						t.Fatal("file status read changed scope")
					}
					if kind == "missing" {
						return sp.ArchiveFileReceipt{}, &model.Fault{Code: "not_found", Message: "Original file is unavailable."}
					}
					return sp.ArchiveFileReceipt{FileID: id, State: "complete", TimelineRevision: &revision, AcceptedOffset: "2", ByteLength: "2"}, nil
				}
			}
			w := f.Request(http.MethodGet, path, "", map[string]int{method: 1})
			if kind == "missing" {
				if w.Code != 404 || !strings.Contains(w.Body.String(), `"code":"not_found"`) {
					t.Fatal(w.Code, w.Body.String())
				}
			} else {
				if w.Code != 200 || kind != "timeline" && !strings.Contains(w.Body.String(), `"timelineRevision":"`+revision+`"`) {
					t.Fatal(w.Code, w.Body.String())
				}
				field := `"fileId":"` + id + `"`
				if kind == "history" {
					field = `"syncId":"` + id + `"`
				}
				if kind != "preparation" && !strings.Contains(w.Body.String(), field) {
					t.Fatal("wrong public file identity", w.Body.String())
				}
			}
			if w = f.Request(http.MethodGet, path+"?extra=1", "", nil); w.Code != 400 {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}

func TestUnifiedArchiveTimelineReadRetainsExactBytesAndCapability(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "original bytes", true: "missing original"}[missing], func(t *testing.T) {
			f := archiveHTTPSetup(t)
			id := uuid.NewString()
			body := []byte(" { \"entries\": [] }\n")
			f.backend.Funcs.ArchiveTimelineContentReserved = func(_ context.Context, p model.Principal, project, task, session, file string, reservation io.Closer) (sessionhttp.ArchiveContentForTest, error) {
				if p != f.handler.principal || project != f.task.ProjectID || task != f.task.ID || session != f.snapshot.SessionID || file != id || reservation != f.reservation {
					t.Fatal("timeline read changed identity or reservation")
				}
				if missing {
					return sessionhttp.ArchiveContentForTest{}, &model.Fault{Code: "not_found", Message: "Original timeline is unavailable."}
				}
				lease := newArchiveLeaseSpy(t)
				f.operation, f.operations = lease, append(f.operations, lease)
				return sessionhttp.ArchiveContentForTest{Data: body, Closer: lease}, nil
			}
			path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + id
			w := f.Request(http.MethodGet, path, "", map[string]int{"TryReserveArchivePreflight": 1, "ArchiveTimelineContentReserved": 1})
			if missing {
				if w.Code != 404 {
					t.Fatal(w.Code, w.Body.String())
				}
			} else if w.Code != 200 || w.Body.String() != string(body) || w.Header().Get("Content-Type") != "application/json" {
				t.Fatal("timeline bytes changed", w.Code, w.Body.String())
			}
			f.AssertReleased(t)
			if w = f.Request(http.MethodGet, path+"?extra=1", "", map[string]int{"TryReserveArchivePreflight": 1}); w.Code != 400 {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
}

func TestUnifiedArchiveRefusalReleasesCapabilityAtEachAdmissionBoundary(t *testing.T) {
	for _, endpoint := range []string{"prepare", "seal", "content", "source-tail"} {
		for _, stage := range []string{"begin", "legacy capability", "operation"} {
			t.Run(endpoint+"/"+stage, func(t *testing.T) {
				f := archiveHTTPSetup(t)
				path := f.base + "/" + f.snapshot.SessionID + "/archive/" + endpoint
				body := jsonBody(t, sp.ArchivePrepareRequest{Fence: f.snapshot.Fence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID})
				method := http.MethodPost
				if endpoint == "seal" {
					body = ""
				}
				if endpoint == "content" {
					method, body = http.MethodPut, `{ "schemaVersion": 3 }`
				}
				if endpoint == "source-tail" {
					body = archiveSourceTailBody(t, f)
				}
				fault := &model.Fault{Code: "archive_conflict", Message: "Original archive scope changed."}
				calls := 0
				if stage == "begin" {
					f.BeginError = fault
				}
				if stage != "legacy capability" {
					setupUnifiedStub(f, func(op *unifiedArchiveStub) {
						op.prepare = func(context.Context, sp.ArchivePrepareRequest) (sp.ArchivePrepareReceipt, error) {
							calls++
							return sp.ArchivePrepareReceipt{}, fault
						}
						op.seal = func(context.Context) (sp.ArchivePrepareReceipt, error) {
							calls++
							return sp.ArchivePrepareReceipt{}, fault
						}
						op.manifest = func(context.Context, []byte) (sp.ArchiveStatus, error) { calls++; return sp.ArchiveStatus{}, fault }
						op.source = func(context.Context, sp.ArchiveSourceTailRequest) (sp.ArchiveSourceTailReceipt, error) {
							calls++
							return sp.ArchiveSourceTailReceipt{}, fault
						}
					})
				}
				w := f.Request(method, path, body, map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1})
				want, operationCalls := 409, 0
				if stage == "legacy capability" {
					want = 400
				}
				if stage == "operation" {
					operationCalls = 1
				}
				if w.Code != want || calls != operationCalls {
					t.Fatal("wrong refusal or continued operation", w.Code, w.Body.String(), calls)
				}
				f.AssertReleased(t)
			})
		}
	}
}

func archiveSourceTailBody(t *testing.T, f *archiveHTTPFixture) string {
	t.Helper()
	state := sp.State{InitialInputState: "not_submitted", Activity: "initializing"}
	return jsonBody(t, sp.ArchiveSourceTailRequest{Fence: f.snapshot.Fence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, SourceEpoch: uuid.NewString(), BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: []byte(jsonBody(t, state))}}})
}

func TestUnifiedArchiveSourceAndPrepareRejectMalformedBodiesBeforeCore(t *testing.T) {
	for _, endpoint := range []string{"source-tail", "prepare"} {
		for _, kind := range []string{"content type", "shape", "query"} {
			t.Run(endpoint+"/"+kind, func(t *testing.T) {
				f := archiveHTTPSetup(t)
				setupUnifiedStub(f, func(*unifiedArchiveStub) {})
				path := f.base + "/" + f.snapshot.SessionID + "/archive/" + endpoint
				headers := map[string]string{}
				calls := map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1}
				if kind == "content type" {
					headers["Content-Type"] = "text/plain"
				}
				if kind == "query" {
					path += "?replacement=1"
					delete(calls, "BeginArchiveReserved")
				}
				w := archiveBoundaryRequest(f, http.MethodPost, path, `{}`, headers, calls)
				if w.Code != 400 {
					t.Fatal(w.Code, w.Body.String())
				}
				f.AssertReleased(t)
			})
		}
	}
	for _, endpoint := range []string{"content", "source-tail"} {
		f := archiveHTTPSetup(t)
		method := http.MethodPost
		if endpoint == "content" {
			method = http.MethodPut
		}
		w := f.Request(method, f.base+"/"+f.snapshot.SessionID+"/archive/"+endpoint+"?extra=1", `{}`, map[string]int{"TryReserveArchivePreflight": 1})
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

type archiveMigrationBoundaryStub struct {
	*unifiedArchiveStub
	resource func(context.Context, string, int64, int64, string, string, []byte, sp.Resource) (sp.ArchiveFileReceipt, error)
}

func (s *archiveMigrationBoundaryStub) PutArchiveResource(ctx context.Context, id string, offset, length int64, digest, chunk string, body []byte, descriptor sp.Resource) (sp.ArchiveFileReceipt, error) {
	if s.resource == nil {
		s.t.Fatal("unexpected legacy resource publication")
	}
	return s.resource(ctx, id, offset, length, digest, chunk, body, descriptor)
}

func TestUnifiedArchiveFileUploadPreservesTimelineAndLegacyResourceProfiles(t *testing.T) {
	for _, kind := range []string{"timeline", "resource", "invalid descriptor", "invalid profile", "refused", "begin refused", "content type", "offset"} {
		t.Run(kind, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			id, digest, chunk := uuid.NewString(), strings.Repeat("a", 64), strings.Repeat("b", 64)
			descriptor := sp.Resource{ResourceID: uuid.NewString(), Status: "unavailable", Name: "legacy.txt"}
			calls := 0
			original := f.backend.Funcs.BeginArchiveReserved
			f.backend.Funcs.BeginArchiveReserved = func(ctx context.Context, p model.Principal, project, task, session string, mode core.ArchiveMode, reservation io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
				op, err := original(ctx, p, project, task, session, mode, reservation)
				if err != nil {
					return nil, err
				}
				stub := &unifiedArchiveStub{archiveUploadStub: op.(*archiveUploadStub)}
				check := func(file string, offset, length int64, hash, hashChunk string, body []byte) {
					calls++
					if file != id || offset != 0 || length != 2 || hash != digest || hashChunk != chunk || string(body) != "[]" {
						t.Fatal("file upload changed immutable metadata")
					}
				}
				stub.file = func(_ context.Context, purpose, file string, offset, length int64, hash, hashChunk string, body []byte) (sp.ArchiveFileReceipt, error) {
					check(file, offset, length, hash, hashChunk, body)
					if purpose != "timeline" {
						t.Fatal("timeline selected another purpose", purpose)
					}
					if kind == "refused" {
						return sp.ArchiveFileReceipt{}, &model.Fault{Code: "archive_conflict", Message: "Original file differs."}
					}
					return sp.ArchiveFileReceipt{FileID: file, State: "complete", AcceptedOffset: "2"}, nil
				}
				return &archiveMigrationBoundaryStub{unifiedArchiveStub: stub, resource: func(_ context.Context, file string, offset, length int64, hash, hashChunk string, body []byte, actual sp.Resource) (sp.ArchiveFileReceipt, error) {
					check(file, offset, length, hash, hashChunk, body)
					if !reflect.DeepEqual(actual, descriptor) {
						t.Fatal("legacy descriptor changed", actual, descriptor)
					}
					return sp.ArchiveFileReceipt{FileID: file, State: "complete", AcceptedOffset: "2"}, nil
				}}, nil
			}
			path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + id + "?offset=0"
			headers := map[string]string{"Content-Type": "application/octet-stream", "Daynight-File-Byte-Length": "2", "Daynight-File-SHA256": digest, "Daynight-Chunk-SHA256": chunk}
			if kind == "resource" || kind == "invalid descriptor" {
				path += "&purpose=resource&migrationOnly=true"
				headers["Daynight-Resource-Descriptor"] = jsonBody(t, descriptor)
				if kind == "invalid descriptor" {
					headers["Daynight-Resource-Descriptor"] = `{}`
				}
			}
			if kind == "invalid profile" {
				path += "&purpose=resource"
			}
			if kind == "content type" {
				headers["Content-Type"] = "application/json"
			}
			if kind == "offset" {
				path = strings.Replace(path, "offset=0", "offset=00", 1)
			}
			if kind == "begin refused" {
				f.BeginError = &model.Fault{Code: "permission_denied", Message: "Original owner denied."}
			}
			expected := map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1}
			if kind == "offset" {
				delete(expected, "BeginArchiveReserved")
			}
			w := archiveBoundaryRequest(f, http.MethodPut, path, "[]", headers, expected)
			want, wantCalls := 400, 0
			switch kind {
			case "timeline", "resource":
				want, wantCalls = 200, 1
			case "refused":
				want, wantCalls = 409, 1
			case "begin refused":
				want = 403
			}
			if w.Code != want || calls != wantCalls {
				t.Fatal("wrong upload result or publication after refusal", w.Code, w.Body.String(), calls)
			}
			if want == 200 && !strings.Contains(w.Body.String(), `"fileId":"`+id+`"`) {
				t.Fatal("file receipt changed", w.Body.String())
			}
			f.AssertReleased(t)
		})
	}
}
