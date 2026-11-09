package session_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func TestImageReadAndCompletionRejectMalformedRequestsBeforeCallingService(t *testing.T) {
	f := sessionHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID
	upload := base + "/image-uploads/" + uuid.NewString()
	resource := base + "/resources/" + uuid.NewString() + "/content"
	for _, tc := range []struct {
		name, method, path, body string
		headers                  map[string]string
	}{
		{"release revision", http.MethodDelete, upload, "", map[string]string{"Daynight-Session-Content-Revision": "1"}},
		{"capabilities revision", http.MethodGet, base + "/image-capabilities", "", map[string]string{"Daynight-Session-Content-Revision": "1"}},
		{"capabilities query", http.MethodGet, base + "/image-capabilities?extra=1", "", nil},
		{"completion revision", http.MethodPost, upload + "/complete", `{}`, map[string]string{"Daynight-Session-Content-Revision": "1"}},
		{"completion content type", http.MethodPost, upload + "/complete", `{}`, map[string]string{"Content-Type": "text/plain"}},
		{"resource revision", http.MethodGet, resource + "?offset=0&limit=1", "", map[string]string{"Daynight-Session-Content-Revision": "1"}},
		{"resource query", http.MethodGet, resource + "?offset=0&limit=1&extra=1", "", nil},
		{"resource decimal limit", http.MethodGet, resource + "?offset=0&limit=01", "", nil},
		{"resource missing limit", http.MethodGet, resource + "?offset=0", "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := imageHTTPRequest(f, tc.method, tc.path, tc.body, tc.headers)
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"invalid_input"`) {
				t.Fatal(response.Code, response.Body.String())
			}
		})
	}
	if f.backend.TotalCalls() != 0 {
		t.Fatal("malformed media requests reached the service")
	}
}

func TestImageServiceRefusalPreservesPublicCodeAndScope(t *testing.T) {
	f := sessionHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID
	resource := uuid.NewString()
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.ReadResource = func(ctx context.Context, p model.Principal, project, task, id string, input sp.ImageReadRequest) (sp.ImageReadChunk, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return sp.ImageReadChunk{}, err
			}
			if input.ResourceID != resource || input.Offset != "0" || input.Limit != 1 {
				t.Fatal("resource refusal changed the original range", input)
			}
			return sp.ImageReadChunk{}, &model.Fault{Code: "lease_expired", Message: "Original lease expired."}
		}
	})
	response := imageHTTPRequest(f, http.MethodGet, base+"/resources/"+resource+"/content?offset=0&limit=1", "", nil)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"code":"lease_expired"`) {
		t.Fatal(response.Code, response.Body.String())
	}
}
