package session

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestProducerRegistrationsCoexistWithScopedReads(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	binds, calls := 0, 0
	bind := func(_ *http.Request, _ model.Principal) (context.Context, error) {
		binds++
		return nil, &model.Fault{Code: "insufficient_scope", Message: "read denied"}
	}
	channel := func(*http.Request, model.Principal) (func(context.Context, string, string, string) error, error) {
		t.Error("unexpected channel admission")
		return nil, nil
	}
	if err := f.routes.EnableScopedSessionReads(bind, channel); err != nil {
		t.Fatal(err)
	}
	denied := &model.Fault{Code: "insufficient_scope", Message: "produce denied"}
	check := func(ctx context.Context, p model.Principal, project, task string) {
		calls++
		if ctx.Err() != nil || p != f.native || project != "" && (project != f.project || task != f.task) {
			t.Error("producer actor or target changed")
		}
	}
	f.routes.service.Register = func(ctx context.Context, p model.Principal, project, task string, _ sp.Registration) (sp.Snapshot, error) {
		check(ctx, p, project, task)
		return sp.Snapshot{}, denied
	}
	f.routes.service.RegisterTest = func(ctx context.Context, p model.Principal, _ sp.TestRegistration) (sp.Snapshot, error) {
		check(ctx, p, "", "")
		return sp.Snapshot{}, denied
	}
	f.routes.service.Grant = func(ctx context.Context, p model.Principal, project, task, id string, _ sp.Grant) (core.GrantResult, error) {
		check(ctx, p, project, task)
		if id != f.session {
			t.Error("grant session changed")
		}
		return core.GrantResult{Token: "private-token"}, denied
	}
	f.routes.service.PrepareUpload = func(ctx context.Context, p model.Principal, project, task, id string, _ sp.ImageUploadSpec) (sp.ImageUploadReceipt, bool, error) {
		check(ctx, p, project, task)
		if id != f.session {
			t.Error("upload session changed")
		}
		return sp.ImageUploadReceipt{}, false, denied
	}
	observed := map[string]ProducerRoute{}
	mux := http.NewServeMux()
	f.routes.RegisterRoutesWithProducerObserver(mux, func(route ProducerRoute) { observed[route.Pattern] = route })
	registration := sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	testRegistration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	grant := sp.Grant{Protocol: sp.Protocol, ClaimID: registration.ClaimID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"}
	testGrant := sp.Grant{Protocol: sp.Protocol, TestExecutionID: testRegistration.TestExecutionID, ControllerID: testRegistration.ControllerID, ControllerInstanceID: testRegistration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"}
	upload := uuid.NewString()
	spec := sp.ImageUploadSpec{UploadID: upload, ImageID: uuid.NewString(), Target: sp.ImageTarget{ServerOrigin: "https://daynight.example", ActorUserID: f.native.UserID, Fence: f.snapshot.Fence}, Name: "image.png", MediaType: "image/png", ByteLength: "3", SHA256: strings.Repeat("a", 64)}
	taskBase := "/api/v1/projects/" + f.project + "/tasks/" + f.task + "/sessions"
	testBase := "/api/v1/test-sessions"
	for _, tc := range []struct {
		method, path, pattern string
		body                  any
	}{
		{"POST", taskBase, "POST " + sessionBase, registration},
		{"POST", testBase, "POST /api/v1/test-sessions", testRegistration},
		{"POST", taskBase + "/" + f.session + "/controller-grant", "POST " + sessionBase + "/{sessionId}/controller-grant", grant},
		{"POST", testBase + "/" + f.session + "/controller-grant", "POST /api/v1/test-sessions/{sessionId}/controller-grant", testGrant},
		{"PUT", taskBase + "/" + f.session + "/image-uploads/" + upload, "PUT " + sessionBase + "/{sessionId}/image-uploads/{uploadId}", spec},
		{"PUT", testBase + "/" + f.session + "/image-uploads/" + upload, "PUT /api/v1/test-sessions/{sessionId}/image-uploads/{uploadId}", spec},
	} {
		entry, ok := observed[tc.pattern]
		if !ok || len(entry.Operations) != 1 || entry.Operations[0] != scopepolicy.SessionProduce {
			t.Fatalf("missing producer classification: %s", tc.pattern)
		}
		body, err := json.Marshal(tc.body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer native-secret")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Daynight-Session-Content-Revision", "2")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || strings.Contains(w.Body.String(), "private-token") {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body)
		}
	}
	if calls != 6 || binds != 0 {
		t.Fatalf("producer calls=%d read bindings=%d", calls, binds)
	}
	req := httptest.NewRequest("GET", taskBase+"/current", nil)
	req.Header.Set("Authorization", "Bearer native-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden || binds != 1 {
		t.Fatalf("read admission: %d binds=%d", w.Code, binds)
	}
}
