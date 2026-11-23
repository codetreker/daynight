package attachment

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type activityBody struct {
	io.Reader
	closed int
}

func (b *activityBody) Close() error { b.closed++; return nil }

func TestProtectedPreviewActivityOrderingAndCleanup(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		openErr, renewErr       error
		status, renewed, closed int
	}{
		{name: "authorized", status: 200, renewed: 1, closed: 1},
		{name: "permission_denied", openErr: &model.Fault{Code: "permission_denied", Message: "Denied"}, status: 403},
		{name: "renewal_failed", renewErr: errors.New("commit unavailable"), status: 500, renewed: 1, closed: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			principal := model.Principal{Kind: model.SessionCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
			body := &activityBody{Reader: strings.NewReader("private content")}
			opened, renewed := false, 0
			h := &attachmentHandler{principal: principalIdentity, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), attachments: attachmentOperations{Open: func(_ context.Context, p model.Principal, project, task, path string) (model.Attachment, filestorage.Object, error) {
				opened = true
				if p != principal || path != "private.html" {
					t.Fatal("Open lost identity")
				}
				if tc.openErr != nil {
					return model.Attachment{}, filestorage.Object{}, tc.openErr
				}
				return model.Attachment{Path: path, ContentType: "text/html"}, filestorage.Object{Body: body, Info: filestorage.FileInfo{Size: 15}}, nil
			}}, afterOpen: func(_ *http.Request, p model.Principal) error {
				renewed++
				if !opened || p != principal {
					t.Fatal("renewal preceded protected Open")
				}
				return tc.renewErr
			}}
			r := httptest.NewRequest("GET", "/preview/private.html", nil)
			r.SetPathValue("projectId", "30000000-0000-4000-8000-000000000001")
			r.SetPathValue("taskId", "40000000-0000-4000-8000-000000000001")
			r.SetPathValue("path", "private.html")
			w := httptest.NewRecorder()
			h.preview(w, r, principal)
			if w.Code != tc.status || renewed != tc.renewed || body.closed != tc.closed || tc.status != 200 && strings.Contains(w.Body.String(), "private content") {
				t.Fatalf("status=%d renewed=%d closed=%d body=%q", w.Code, renewed, body.closed, w.Body.String())
			}
		})
	}
}
