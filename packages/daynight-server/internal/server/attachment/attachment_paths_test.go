package attachment_test

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
)

func TestStandaloneAttachmentPathsRejectNormalizationBeforeRedirect(t *testing.T) {
	var logs bytes.Buffer
	handler := uiTestHandler(t, &logs)
	base := "/projects/project/tasks/task/attachments/"
	for _, suffix := range []string{"", ".", "..", "nested/../private-file", "./private-file", "nested//private-file", "nested/", "%2e%2e/private-file", "nested%2fprivate-file", "nested%2Fprivate-file", "%5cprivate-file", "private%00file", "%ff", "C:/private-file", "../../../../../"} {
		assertStandaloneAttachmentInvalidPath(t, handler, base+suffix)
	}
	for _, target := range []string{
		strings.TrimSuffix(base, "/"),
		strings.Replace(base, "/projects/", "/projects//", 1) + "private-file",
		strings.Replace(base, "/projects/", "/./projects/", 1) + "private-file",
		strings.Replace(base, "/projects/", "/../projects/", 1) + "private-file",
		strings.Replace(base, "/tasks/", "/extra/../tasks/", 1) + "private-file",
		strings.Replace(base, "/attachments/", "/attachments%2Fprivate-file", 1),
		strings.Replace(base, "/attachments/", "/attachments%5Cprivate-file", 1),
		strings.Replace(base, "/projects/", "/projects%2F", 1) + "private-file",
		strings.Replace(base, "/tasks/", "/tasks%2F", 1) + "private-file",
		strings.Replace(base, "/project/", "/project%2Fother/", 1) + "private-file",
		strings.Replace(base, "/task/", "/task%2Fother/", 1) + "private-file",
		strings.Replace(base, "/project/", "/%2e/", 1) + "private-file",
		strings.Replace(base, "/task/", "/%2F/", 1) + "private-file",
	} {
		assertStandaloneAttachmentInvalidPath(t, handler, target)
	}
	if strings.Contains(logs.String(), "private") {
		t.Fatalf("invalid standalone attachment path leaked to logs: %s", &logs)
	}
	response := projectRequest(handler, http.MethodGet, "/projects//project", "")
	if response.Code != http.StatusTemporaryRedirect || response.Header().Get("Location") != "/projects/project" {
		t.Fatalf("ordinary project route normalization changed: %d %+v", response.Code, response.Header())
	}
}

func assertStandaloneAttachmentInvalidPath(t *testing.T, handler http.Handler, target string) {
	t.Helper()
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPatch, http.MethodPut, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(handler, method, target, "private-body")
		assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
		if response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" || strings.Contains(response.Body.String(), "<html") {
			t.Fatalf("invalid standalone path was redirected, cached, or served HTML: %s %s %d %+v", method, target, response.Code, response.Header())
		}
	}
}
