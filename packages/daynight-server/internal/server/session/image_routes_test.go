package session_test

import (
	"context"
	"encoding/base64"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func imageHTTPRequest(f *sessionHTTPFixture, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(f.handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Daynight-Session-Content-Revision", "2")
	for k, v := range headers {
		request.Header.Set(k, v)
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}
func TestImageUploadHTTPKeepsScopedReceiptsAndBinaryChunks(t *testing.T) {
	f := sessionHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID
	id := uuid.NewString()
	digest := strings.Repeat("a", 64)
	spec := sp.ImageUploadSpec{UploadID: id, ImageID: uuid.NewString(), Target: sp.ImageTarget{ServerOrigin: "https://daynight.example", ActorUserID: f.handler.principal.UserID, Fence: f.snapshot.Fence}, Name: "image.png", MediaType: "image/png", ByteLength: "3", SHA256: digest}
	receipt := sp.ImageUploadReceipt{UploadID: id, ImageID: spec.ImageID, Target: spec.Target, State: "receiving", AcceptedOffset: "0"}
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.PrepareUpload = func(ctx context.Context, p model.Principal, project, task, session string, input sp.ImageUploadSpec) (sp.ImageUploadReceipt, bool, error) {
			if e := f.scopeArguments(ctx, p, project, task, session); e != nil {
				return receipt, false, e
			}
			if !reflect.DeepEqual(input, spec) {
				t.Fatal("prepare body changed")
			}
			return receipt, true, nil
		}
		c.WriteUploadChunk = func(ctx context.Context, p model.Principal, project, task, session, upload string, input sp.ImageChunkWrite) (sp.ImageUploadReceipt, error) {
			if e := f.scopeArguments(ctx, p, project, task, session); e != nil {
				return receipt, e
			}
			if upload != id || input.UploadID != id || input.Offset != "0" || input.SHA256 != digest || input.Data != base64.StdEncoding.EncodeToString([]byte("png")) {
				t.Fatal("binary chunk adaptation changed")
			}
			return receipt, nil
		}
		c.CompleteUpload = func(ctx context.Context, p model.Principal, project, task, session, upload string, input sp.ImageUploadComplete) (sp.ImageUploadReceipt, error) {
			if e := f.scopeArguments(ctx, p, project, task, session); e != nil {
				return receipt, e
			}
			if upload != id || input.ByteLength != "3" || input.SHA256 != digest {
				t.Fatal("completion body changed")
			}
			return receipt, nil
		}
		c.GetUpload = func(ctx context.Context, p model.Principal, project, task, session, upload string) (sp.ImageUploadReceipt, error) {
			return receipt, f.scopeArguments(ctx, p, project, task, session)
		}
		c.ReleaseUpload = c.GetUpload
		c.ReadResource = func(ctx context.Context, p model.Principal, project, task, session string, input sp.ImageReadRequest) (sp.ImageReadChunk, error) {
			if input.ResourceID != id || input.Offset != "0" || input.Limit != 3 {
				t.Fatal("resource range changed")
			}
			return sp.ImageReadChunk{ResourceID: id, SHA256: digest, ByteLength: "3", Offset: "0", Data: "cG5n", EOF: true}, f.scopeArguments(ctx, p, project, task, session)
		}
		c.ImageCapabilities = func(ctx context.Context, p model.Principal, project, task, session string) (map[string]any, error) {
			return map[string]any{"contentRevision": 2}, f.scopeArguments(ctx, p, project, task, session)
		}
	})
	path := base + "/image-uploads/" + id
	decodeResponse[sp.ImageUploadReceipt](t, imageHTTPRequest(f, "PUT", path, jsonBody(t, spec), nil), 201)
	decodeResponse[sp.ImageUploadReceipt](t, imageHTTPRequest(f, "PUT", path+"/chunks?offset=0", "png", map[string]string{"Content-Type": "application/octet-stream", "Daynight-Chunk-SHA256": digest}), 200)
	decodeResponse[sp.ImageUploadReceipt](t, imageHTTPRequest(f, "POST", path+"/complete", jsonBody(t, sp.ImageUploadComplete{SHA256: digest, ByteLength: "3"}), nil), 200)
	decodeResponse[sp.ImageUploadReceipt](t, imageHTTPRequest(f, "GET", path, "", nil), 200)
	decodeResponse[sp.ImageUploadReceipt](t, imageHTTPRequest(f, "DELETE", path, "", nil), 200)
	decodeResponse[sp.ImageReadChunk](t, imageHTTPRequest(f, "GET", base+"/resources/"+id+"/content?offset=0&limit=3", "", nil), 200)
	decodeResponse[map[string]any](t, imageHTTPRequest(f, "GET", base+"/image-capabilities", "", nil), 200)
}
func TestImageHTTPRejectsInvalidProtocolBeforeBusinessCalls(t *testing.T) {
	f := sessionHTTPSetup(t)
	id := uuid.NewString()
	base := f.base + "/" + f.snapshot.SessionID
	path := base + "/image-uploads/" + id
	hash := strings.Repeat("a", 64)
	for _, tc := range []struct {
		name, method, path, body string
		headers                  map[string]string
	}{
		{"invalid upload identity", "GET", base + "/image-uploads/not-a-uuid", "", nil},
		{"uppercase upload identity", "GET", base + "/image-uploads/" + strings.ToUpper(id), "", nil},
		{"terminal protocol", "GET", path, "", map[string]string{"Daynight-Session-Protocol": "daynight.session.v2"}},
		{"invalid protocol", "GET", path, "", map[string]string{"Daynight-Session-Protocol": "other"}},
		{"missing revision", "GET", path, "", map[string]string{"Daynight-Session-Content-Revision": ""}},
		{"encoded body", "GET", path, "", map[string]string{"Content-Encoding": "gzip"}},
		{"extra query", "GET", path + "?extra=1", "", nil},
		{"bad spec", "PUT", path, `{}`, nil},
		{"bad completion", "POST", path + "/complete", `{}`, nil},
		{"bad content type", "PUT", path + "/chunks?offset=0", "png", nil},
		{"noncanonical offset", "PUT", path + "/chunks?offset=00", "png", nil},
		{"negative offset", "PUT", path + "/chunks?offset=-1", "png", nil},
		{"repeated query", "PUT", path + "/chunks?offset=0&offset=0", "png", nil},
		{"missing hash", "PUT", path + "/chunks?offset=0", "png", map[string]string{"Content-Type": "application/octet-stream"}},
		{"empty chunk", "PUT", path + "/chunks?offset=0", "", map[string]string{"Content-Type": "application/octet-stream", "Daynight-Chunk-SHA256": hash}},
		{"oversized chunk", "PUT", path + "/chunks?offset=0", strings.Repeat("x", 524289), map[string]string{"Content-Type": "application/octet-stream", "Daynight-Chunk-SHA256": hash}},
		{"invalid read limit", "GET", base + "/resources/" + id + "/content?offset=0&limit=524289", "", nil},
		{"bad read offset", "GET", base + "/resources/" + id + "/content?offset=00&limit=3", "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if response := imageHTTPRequest(f, tc.method, tc.path, tc.body, tc.headers); response.Code != 400 {
				t.Fatalf("invalid request status %d: %s", response.Code, response.Body)
			}
		})
	}
	if f.backend.TotalCalls() != 0 {
		t.Fatal("invalid image protocol reached business usecases")
	}
}

func TestImageOccurrenceHTTPPropagatesOriginalImageAndStrictRetry(t *testing.T) {
	f := sessionHTTPSetup(t)
	image := uuid.NewString()
	path := f.base + "/" + f.snapshot.SessionID + "/image-occurrences/" + image
	status := sp.ImageOccurrenceStatus{ImageID: image, Revision: "2", State: "failed", Action: "retry_source", Error: &sp.ImageError{Code: "invalid_image", Message: "Original source failed."}}
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.GetImageOccurrence = func(ctx context.Context, p model.Principal, project, task, session, id string) (sp.ImageOccurrenceStatus, error) {
			if id != image {
				t.Fatal("original image changed", id)
			}
			return status, f.scopeArguments(ctx, p, project, task, session)
		}
		c.RetryImageOccurrence = func(ctx context.Context, p model.Principal, project, task, session, id string) (sp.ImageOccurrenceRetryReceipt, error) {
			if id != image {
				t.Fatal("original image changed", id)
			}
			return sp.ImageOccurrenceRetryReceipt{Capture: sp.ImageCaptureReceipt{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Revision: "3", State: "reserved"}}, f.scopeArguments(ctx, p, project, task, session)
		}
	})
	got := decodeResponse[sp.ImageOccurrenceStatus](t, imageHTTPRequest(f, "GET", path, "", nil), 200)
	if !reflect.DeepEqual(got, status) {
		t.Fatal("occurrence result changed", got)
	}
	decodeResponse[sp.ImageOccurrenceRetryReceipt](t, imageHTTPRequest(f, "POST", path+"/retry", `{}`, nil), 200)
	before := f.backend.TotalCalls()
	for _, tc := range []struct {
		method, path, body string
		headers            map[string]string
	}{
		{"GET", path + "?replacement=1", "", nil},
		{"GET", strings.Replace(path, image, "not-an-image", 1), "", nil},
		{"GET", strings.Replace(path, image, strings.ToUpper(image), 1), "", nil},
		{"POST", path + "/retry", `null`, nil},
		{"POST", path + "/retry", `[]`, nil},
		{"POST", path + "/retry", `{"url":"https://replacement.example/image.png"}`, nil},
		{"POST", path + "/retry", `{} {}`, nil},
		{"POST", path + "/retry", `{}`, map[string]string{"Daynight-Session-Content-Revision": "1"}},
		{"POST", path + "/retry", `{}`, map[string]string{"Daynight-Session-Protocol": "daynight.session.v2"}},
	} {
		response := imageHTTPRequest(f, tc.method, tc.path, tc.body, tc.headers)
		if response.Code != 400 {
			t.Fatalf("invalid retry status %d: %s", response.Code, response.Body)
		}
	}
	if f.backend.TotalCalls() != before {
		t.Fatal("invalid retry reached a business usecase")
	}
}
