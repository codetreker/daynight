package attachment

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

const scopedProject = "f36af519-4b3b-4bb9-877c-cae8ead38301"
const scopedTask = "92dab496-4ec1-4ad9-9700-22219a90bf37"
const scopedBase = "/api/v1/projects/" + scopedProject + "/tasks/" + scopedTask

type scopedAuthentication struct {
	authorization model.CredentialAuthorization
	called        int
}

func (a *scopedAuthentication) RequireAuthorization(next AuthorizedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a.called++
		next(w, r, a.authorization)
	}
}

type scopedContextKey struct{}

type scopedOperations struct {
	ScopedOperations
	t             *testing.T
	authorization model.CredentialAuthorization
	want, seen    string
	content       string
	err           error
	closed        bool
}

func (o *scopedOperations) check(ctx context.Context, a model.CredentialAuthorization, project, task, operation string) {
	o.t.Helper()
	if a != o.authorization || project != scopedProject || task != scopedTask || ctx.Value(scopedContextKey{}) != o {
		o.t.Fatalf("authorization/resource/context changed: %+v %s/%s", a, project, task)
	}
	if o.seen != "" || operation != o.want {
		o.t.Fatalf("operation=%s want=%s previous=%s", operation, o.want, o.seen)
	}
	o.seen = operation
}

func (o *scopedOperations) List(ctx context.Context, a model.CredentialAuthorization, project, task string, request model.PageRequest) (attachmentcore.Page, error) {
	o.check(ctx, a, project, task, "list")
	if request.Limit != 7 {
		o.t.Fatalf("page input changed: %+v", request)
	}
	return attachmentcore.Page{}, o.err
}

func (o *scopedOperations) PutRetained(ctx context.Context, a model.CredentialAuthorization, project, task, path, contentType string, content io.Reader) (model.Attachment, bool, io.Closer, error) {
	o.check(ctx, a, project, task, "upload")
	if path != "docs/a b.txt" || contentType != "text/plain" {
		o.t.Fatalf("upload input changed: %q %q", path, contentType)
	}
	if o.err != nil {
		return model.Attachment{}, false, nil, o.err
	}
	data, err := io.ReadAll(content)
	if err != nil || string(data) != o.content {
		o.t.Fatalf("upload content changed: %q %v", data, err)
	}
	return model.Attachment{ProjectID: project, TaskID: task, Path: path, ContentType: contentType, SizeBytes: int64(len(data))}, true, o, nil
}

func (o *scopedOperations) Delete(ctx context.Context, a model.CredentialAuthorization, project, task, path string) error {
	o.check(ctx, a, project, task, "delete")
	if path != "docs/a b.txt" {
		o.t.Fatal(path)
	}
	return o.err
}

func (o *scopedOperations) Open(ctx context.Context, a model.CredentialAuthorization, project, task, path string) (model.Attachment, filestorage.Object, error) {
	o.check(ctx, a, project, task, "open")
	if path != "docs/a b.txt" {
		o.t.Fatal(path)
	}
	if o.err != nil {
		return model.Attachment{}, filestorage.Object{}, o.err
	}
	return model.Attachment{Path: path, ContentType: "text/plain"}, filestorage.Object{Body: &scopedBody{Reader: strings.NewReader(o.content), close: o.Close}, Info: filestorage.FileInfo{Size: int64(len(o.content))}}, nil
}

func (o *scopedOperations) Close() error {
	if o.closed {
		o.t.Fatal("resource closed twice")
	}
	o.closed = true
	return nil
}

type scopedBody struct {
	io.Reader
	close func() error
}

func (b *scopedBody) Close() error { return b.close() }

func scopedAuthorization(t *testing.T) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"attachment:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: scopedProject, CredentialID: scopedTask}, Profile: model.ScopedPATProfile, Policy: &policy}
}

func scopedRequest(o *scopedOperations, auth *scopedAuthentication, method, path string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	RegisterScopedRoutes(mux, o, auth, logger, "https://preview.daynight.test")
	r := httptest.NewRequest(method, "https://daynight.test"+scopedBase+path, strings.NewReader(o.content))
	r.Header.Set("Content-Type", "text/plain")
	r = r.WithContext(context.WithValue(r.Context(), scopedContextKey{}, o))
	w := httptest.NewRecorder()
	PathGuard(mux, logger).ServeHTTP(w, r)
	return w
}

func TestScopedAttachmentRoutesPreserveRefusals(t *testing.T) {
	for _, test := range []struct{ method, path, operation string }{
		{http.MethodGet, "/attachments?limit=7", "list"},
		{http.MethodHead, "/attachments?limit=7", "list"},
		{http.MethodGet, "/attachments/files/docs/a%20b.txt", "open"},
		{http.MethodHead, "/attachments/files/docs/a%20b.txt", "open"},
		{http.MethodHead, "/preview/docs/a%20b.txt", "open"},
		{http.MethodPut, "/attachments/files/docs/a%20b.txt", "upload"},
		{http.MethodDelete, "/attachments/files/docs/a%20b.txt", "delete"},
	} {
		t.Run(test.method+test.path, func(t *testing.T) {
			a := scopedAuthorization(t)
			o := &scopedOperations{t: t, authorization: a, want: test.operation, err: &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}}
			auth := &scopedAuthentication{authorization: a}
			w := scopedRequest(o, auth, test.method, test.path)
			var body api.ErrorResponse
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if w.Code != http.StatusForbidden || body.Error.Code != "forbidden" || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || o.seen != test.operation || auth.called != 1 {
				t.Fatalf("refusal changed: %d %v %s calls=%d operation=%s", w.Code, w.Header(), w.Body, auth.called, o.seen)
			}
			if w.Header().Get("Content-Disposition") != "" || w.Header().Get("Content-Length") != "" || strings.Contains(w.Body.String(), "docs/") {
				t.Fatalf("refusal exposed attachment metadata: %v %s", w.Header(), w.Body)
			}
		})
	}
}

func TestScopedAttachmentPreviewNavigationAndValidation(t *testing.T) {
	for _, profile := range []model.CredentialPolicyProfile{"", model.ScopedPATProfile} {
		a := scopedAuthorization(t)
		a.Profile = profile
		o := &scopedOperations{t: t, authorization: a}
		auth := &scopedAuthentication{authorization: a}
		w := scopedRequest(o, auth, http.MethodGet, "/preview/docs/a%20b.txt?v=%2F")
		if w.Code != http.StatusFound || w.Header().Get("Location") != "https://"+scopedTask+".preview.daynight.test"+scopedBase+"/preview/docs/a%20b.txt?v=%2F" || auth.called != 0 || o.seen != "" {
			t.Fatalf("preview navigation changed: %d %v calls=%d", w.Code, w.Header(), auth.called)
		}
	}
	a := scopedAuthorization(t)
	a.Profile = ""
	o := &scopedOperations{t: t, authorization: a}
	auth := &scopedAuthentication{authorization: a}
	w := scopedRequest(o, auth, http.MethodHead, "/preview/docs/a%20b.txt")
	if w.Code != http.StatusInternalServerError || o.seen != "" || auth.called != 1 {
		t.Fatalf("invalid policy reached Open: %d operation=%s calls=%d", w.Code, o.seen, auth.called)
	}
}

func TestScopedAttachmentAdmittedContentAndUploadLifetime(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPut} {
		t.Run(method, func(t *testing.T) {
			a := scopedAuthorization(t)
			o := &scopedOperations{t: t, authorization: a, want: "open", content: "admitted bytes"}
			if method == http.MethodPut {
				o.want = "upload"
			}
			auth := &scopedAuthentication{authorization: a}
			w := scopedRequest(o, auth, method, "/attachments/files/docs/a%20b.txt")
			status := http.StatusOK
			if method == http.MethodPut {
				status = http.StatusCreated
			}
			if w.Code != status || !o.closed || auth.called != 1 {
				t.Fatalf("admitted operation changed: %d closed=%v auth=%d body=%s", w.Code, o.closed, auth.called, w.Body)
			}
			if method == http.MethodGet && w.Body.String() != o.content || method == http.MethodHead && w.Body.Len() != 0 {
				t.Fatalf("content changed: %q", w.Body)
			}
		})
	}
}
