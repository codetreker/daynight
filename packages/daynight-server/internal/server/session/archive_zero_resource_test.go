package session_test

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func TestArchiveHTTPAcceptsEmptyLegacyOriginalOnly(t *testing.T) {
	for _, purpose := range []string{"resource", "timeline", "history"} {
		t.Run(purpose, func(t *testing.T) {
			f := archiveHTTPSetup(t)
			file, length, digest, media := uuid.NewString(), "0", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "text/plain"
			resource := sp.Resource{ResourceID: uuid.NewString(), Name: "empty.txt", Status: "available", MediaType: &media, ByteLength: &length, SHA256: &digest}
			called := false
			original := f.backend.Funcs.BeginArchiveReserved
			f.backend.Funcs.BeginArchiveReserved = func(ctx context.Context, p model.Principal, project, task, session string, mode core.ArchiveMode, reservation io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
				op, err := original(ctx, p, project, task, session, mode, reservation)
				if err != nil {
					return nil, err
				}
				return &archiveMigrationBoundaryStub{unifiedArchiveStub: &unifiedArchiveStub{archiveUploadStub: op.(*archiveUploadStub)}, resource: func(_ context.Context, id string, offset, size int64, hash, chunk string, body []byte, actual sp.Resource) (sp.ArchiveFileReceipt, error) {
					called = true
					if id != file || offset != 0 || size != 0 || hash != digest || chunk != digest || len(body) != 0 || !reflect.DeepEqual(actual, resource) {
						t.Fatal("empty original identity changed", id, offset, size, actual)
					}
					return sp.ArchiveFileReceipt{FileID: id, State: "complete", AcceptedOffset: "0", ByteLength: "0", SHA256: digest}, nil
				}}, nil
			}
			path := f.base + "/" + f.snapshot.SessionID + "/archive/files/" + file + "?offset=0"
			expected := map[string]int{"TryReserveArchivePreflight": 1}
			want := 400
			if purpose == "resource" {
				path += "&purpose=resource&migrationOnly=true"
				expected["BeginArchiveReserved"] = 1
				want = 200
			}
			if purpose == "history" {
				path = f.base + "/" + f.snapshot.SessionID + "/archive/prepare/history/" + file + "?offset=0"
			}
			headers := map[string]string{"Content-Type": "application/octet-stream", "Daynight-File-Byte-Length": "0", "Daynight-File-SHA256": digest, "Daynight-Chunk-SHA256": digest, "Daynight-Resource-Descriptor": jsonBody(t, resource)}
			w := archiveBoundaryRequest(f, http.MethodPut, path, "", headers, expected)
			if w.Code != want || called != (purpose == "resource") {
				t.Fatal(w.Code, w.Body.String(), called)
			}
			f.AssertReleased(t)
		})
	}
}
