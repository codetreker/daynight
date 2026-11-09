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
	for _, tc := range []struct {
		name, code string
		chunk      bool
		status     int
	}{{"expired lease", "lease_expired", true, http.StatusConflict}, {"private chunk", "not_found", true, http.StatusNotFound}, {"private legacy", "not_found", false, http.StatusNotFound}} {
		t.Run(tc.name, func(t *testing.T) {
			f := sessionHTTPSetup(t)
			base := f.base + "/" + f.snapshot.SessionID
			resource := uuid.NewString()
			refusal := &model.Fault{Code: tc.code, Message: "Original resource is unavailable."}
			f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
				if tc.chunk {
					c.ReadResource = func(ctx context.Context, p model.Principal, project, task, id string, input sp.ImageReadRequest) (sp.ImageReadChunk, error) {
						if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
							return sp.ImageReadChunk{}, err
						}
						if input.ResourceID != resource || input.Offset != "0" || input.Limit != 1 {
							t.Fatal("resource refusal changed the original range", input)
						}
						return sp.ImageReadChunk{}, refusal
					}
				} else {
					c.Resource = func(ctx context.Context, p model.Principal, project, task, id, requested string) ([]byte, sp.Resource, error) {
						if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
							return nil, sp.Resource{}, err
						}
						if requested != resource {
							t.Fatal("legacy refusal changed the original resource", requested)
						}
						return nil, sp.Resource{}, refusal
					}
				}
			})
			path := base + "/resources/" + resource + "/content"
			if tc.chunk {
				path += "?offset=0&limit=1"
			}
			response := imageHTTPRequest(f, http.MethodGet, path, "", nil)
			if response.Code != tc.status || !strings.Contains(response.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatal(response.Code, response.Body.String())
			}
			if f.backend.TotalCalls() != 1 {
				t.Fatal("resource refusal retried or bypassed its direct use case", f.backend.TotalCalls())
			}
		})
	}
}
