package session_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
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

func TestControllerUpgradeAdvertisesDirectUpload(t *testing.T) {
	f := sessionHTTPSetup(t)
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.AuthenticateController = func(ctx context.Context, token string) error {
			if token != f.grant.Token {
				t.Fatal("controller grant changed")
			}
			return nil
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http://", "ws://", 1)+"/api/v1/controller-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + f.grant.Token}}, Subprotocols: []string{sp.Protocol}})
	if err != nil {
		t.Fatal("controller upgrade", err)
	}
	defer conn.CloseNow()
	if response.Header.Get("Daynight-Session-Direct-Upload-Version") != "1" {
		t.Fatal("direct upload capability missing from upgrade", response.Header)
	}
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
	capabilities := imageHTTPRequest(f, "GET", base+"/image-capabilities", "", nil)
	decodeResponse[map[string]any](t, capabilities, 200)
	if capabilities.Header().Get("Daynight-Session-Direct-Upload-Version") != "1" {
		t.Fatal("direct upload capability missing", capabilities.Header())
	}
}

func TestDirectImageUploadHTTPUsesActualContentAndBoundedBody(t *testing.T) {
	f := sessionHTTPSetup(t)
	id := uuid.NewString()
	data := []byte("png")
	digest := sha256.Sum256(data)
	hash := hex.EncodeToString(digest[:])
	input := sp.DirectImageContent{Spec: sp.ImageUploadSpec{UploadID: id, ImageID: uuid.NewString(), Target: sp.ImageTarget{ServerOrigin: "https://daynight.example", ActorUserID: f.handler.principal.UserID, Fence: f.snapshot.Fence}, Name: "image.png", MediaType: "image/png", ByteLength: "3", SHA256: hash}, Offset: "0", SHA256: hash, Data: base64.StdEncoding.EncodeToString(data)}
	receipt := sp.ImageUploadReceipt{UploadID: id, ImageID: input.Spec.ImageID, Target: input.Spec.Target, State: "receiving", AcceptedOffset: "3"}
	created := true
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.DirectUpload = func(ctx context.Context, p model.Principal, project, task, session string, actual sp.DirectImageContent) (sp.ImageUploadReceipt, bool, error) {
			if err := f.scopeArguments(ctx, p, project, task, session); err != nil {
				return receipt, false, err
			}
			if !reflect.DeepEqual(actual, input) {
				t.Fatal("direct upload changed", actual)
			}
			return receipt, created, nil
		}
	})
	f.backend.ExpectCalls("DirectUpload", 4)
	path := f.base + "/" + f.snapshot.SessionID + "/image-uploads/" + id + "/content"
	body := jsonBody(t, input)
	got := decodeResponse[sp.ImageUploadReceipt](t, imageHTTPRequest(f, "PUT", path, body, nil), 201)
	if got.AcceptedOffset != "3" {
		t.Fatal("actual offset not returned", got)
	}
	created = false
	decodeResponse[sp.ImageUploadReceipt](t, imageHTTPRequest(f, "PUT", path, body, nil), 200)
	boundary := body + strings.Repeat(" ", (1<<20)-len(body))
	decodeResponse[sp.ImageUploadReceipt](t, imageHTTPRequest(f, "PUT", path, boundary, nil), 200)
	if response := imageHTTPRequest(f, "PUT", path, boundary+" ", nil); response.Code != 413 {
		t.Fatal("oversized complete encoding was accepted", response.Code, response.Body)
	}
	small := input
	large := []byte(strings.Repeat("x", 512*1024))
	largeHash := sha256.Sum256(large)
	input.Spec.ByteLength = "524288"
	input.Spec.SHA256 = hex.EncodeToString(largeHash[:])
	input.SHA256 = input.Spec.SHA256
	input.Data = base64.StdEncoding.EncodeToString(large)
	largeBody := jsonBody(t, input)
	if len(largeBody) >= 1<<20 {
		t.Fatal("complete 512 KiB body exceeds budget", len(largeBody))
	}
	receipt.AcceptedOffset = "524288"
	if got = decodeResponse[sp.ImageUploadReceipt](t, imageHTTPRequest(f, "PUT", path, largeBody, nil), 200); got.AcceptedOffset != "524288" {
		t.Fatal("large upload offset changed", got)
	}
	input = small
	for _, invalid := range []struct {
		path, body string
		headers    map[string]string
	}{
		{path, `{}`, nil},
		{path, strings.Replace(body, `"offset":"0"`, `"offset":"1"`, 1), nil},
		{path, strings.Replace(body, `"data":"cG5n"`, `"data":""`, 1), nil},
		{path, strings.Replace(body, `"sha256":"`+hash+`"`, `"sha256":"bad"`, 1), nil},
		{path, strings.Replace(body, `"data":"cG5n"`, `"data":"eHh4"`, 1), nil},
		{strings.Replace(path, id, uuid.NewString(), 1), body, nil},
		{path, strings.TrimSuffix(body, "}") + `,"extra":true}`, nil},
		{path + "?extra=1", body, nil},
		{path, body, map[string]string{"Content-Type": "text/plain"}},
		{path, body, map[string]string{"Content-Encoding": "gzip"}},
		{path, body, map[string]string{"Daynight-Session-Content-Revision": "1"}},
		{path, body, map[string]string{"Daynight-Session-Protocol": "daynight.session.v2"}},
	} {
		if response := imageHTTPRequest(f, "PUT", invalid.path, invalid.body, invalid.headers); response.Code != 400 {
			t.Fatal("invalid direct upload accepted", response.Code, response.Body)
		}
	}
	if f.backend.Called("DirectUpload") != 4 {
		t.Fatal("invalid body reached direct upload")
	}
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
