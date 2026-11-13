package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

const browserAPIOrigin = "https://application.example"
const corsRequestHeaders = "Authorization, Content-Type, Accept, If-None-Match, X-Request-ID, Daynight-Worker-Protocol, Daynight-Worker-Configuration, Daynight-Worker-Control-Mode, Daynight-Worker-Tool-Paths, Daynight-Bot-Attention, Daynight-Worker-Prompts, Daynight-Session-Protocol, X-Daynight-Startup-Version, Daynight-Browser-Client, Daynight-Session-Content-Revision, Daynight-Chunk-SHA256"
const corsExposedHeaders = "Daynight-User-ID, Daynight-Task-Epoch, X-Request-ID, Location, ETag, Content-Disposition, Retry-After, Allow, WWW-Authenticate, Daynight-Worker-Control-Mode, Daynight-Worker-Tool-Paths, Daynight-Bot-Attention, Daynight-Worker-Configuration, Daynight-Session-Direct-Upload-Version"

func rootCORSFixture(t *testing.T, origin string, principal model.Principal) (http.Handler, *httpTestStore, *rootIdentityWitness) {
	t.Helper()
	cfg := configuredTestConfig()
	cfg.S2S.AllowedOrigin = origin
	db := newHTTPTestStoreForPrincipal(t, principal)
	client, err := service.NewIdentityClient(cfg.UniAuth)
	if err != nil {
		t.Fatal(err)
	}
	app := service.NewModules(cfg, db, nil, attachmentTestFiles(t), client)
	app.CredentialUsage = unusedUsageRecorder(testLogger())
	witness := &rootIdentityWitness{IdentityOperations: app.Identity}
	app.Identity = witness
	app.Webhooks = &webhookservice.Service{DB: db}
	root, err := New(app, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		root.BeginShutdown()
		if err := root.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		if err := app.Engine.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	return httpx.RequestLogging(testLogger(), root), db, witness
}

func corsHTTP(t *testing.T, handler http.Handler, method, path string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, nil)
	r.Header = headers.Clone()
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func corsHeaderTokens(raw []string) map[string]bool {
	result := map[string]bool{}
	for _, value := range raw {
		for token := range strings.SplitSeq(value, ",") {
			result[strings.ToLower(strings.TrimSpace(token))] = true
		}
	}
	return result
}

func assertBrowserCORS(t *testing.T, w *httptest.ResponseRecorder, preflight bool) {
	t.Helper()
	if w.Header().Get("Access-Control-Allow-Origin") != browserAPIOrigin || w.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("browser policy: %v", w.Header())
	}
	exposed := corsHeaderTokens(w.Header().Values("Access-Control-Expose-Headers"))
	want := corsHeaderTokens([]string{corsExposedHeaders})
	if len(exposed) != len(want) {
		t.Fatalf("exposed headers: %v", exposed)
	}
	for name := range want {
		if !exposed[name] {
			t.Fatalf("missing exposed header %s", name)
		}
	}
	vary := corsHeaderTokens(w.Header().Values("Vary"))
	if !vary["origin"] || preflight && (!vary["access-control-request-method"] || !vary["access-control-request-headers"]) {
		t.Fatalf("Vary: %v", w.Header().Values("Vary"))
	}
}

func TestRootCORSRegisteredUserPreflights(t *testing.T) {
	handler, db, witness := rootCORSFixture(t, browserAPIOrigin, defaultHTTPPrincipal())
	db.WriteIdentityCall = func(context.Context, func(store.IdentityScope) error) (store.Completion, error) {
		t.Fatal("preflight reached identity initialization")
		return store.Completion{}, nil
	}
	const id = "10000000-0000-4000-8000-000000000001"
	p := "/api/v1/projects/" + id
	task := p + "/tasks/" + id
	worker := "/api/v1/me/workers/" + id
	team := "/api/v1/teams/" + id
	session := task + "/sessions/" + id
	testSession := "/api/v1/test-sessions/" + id
	var routes []struct{ methods, path string }
	add := func(methods, path string) { routes = append(routes, struct{ methods, path string }{methods, path}) }
	add("GET HEAD PATCH", "/api/v1/me")
	add("POST", "/api/v1/auth/logout")
	add("GET HEAD POST", "/api/v1/me/tokens")
	add("PATCH DELETE", "/api/v1/me/tokens/"+id)
	for _, op := range []string{"inspect", "decision", "logout"} {
		add("POST", "/api/v1/auth/device/"+op)
	}
	add("GET", "/api/v1/oauth/grants")
	add("GET", "/api/v2/oauth/grants")
	add("POST", "/api/v1/oauth/grants/"+id+"/revoke")
	add("GET HEAD POST", "/api/v1/projects")
	add("GET HEAD DELETE", p)
	for _, op := range []string{"deletion-preview", "access", "members", "task-work", "task-assignees", "task-graph", "task-sync"} {
		add("GET HEAD", p+"/"+op)
	}
	for _, op := range []string{"transfer-preview", "transfer"} {
		add("POST", p+"/"+op)
	}
	add("PATCH", p+"/settings")
	add("PATCH DELETE", p+"/members/"+id)
	add("PUT DELETE", p+"/grants/"+id)
	add("GET HEAD POST", p+"/invitations")
	add("DELETE", p+"/invitations/"+id)
	for _, prefix := range []string{"invitations", "team-invitations"} {
		for _, op := range []string{"inspect", "accept"} {
			add("POST", "/api/v1/"+prefix+"/"+op)
		}
	}
	add("GET HEAD POST", "/api/v1/teams")
	add("GET HEAD PATCH DELETE", team)
	for _, op := range []string{"members", "invitations"} {
		add("GET HEAD POST", team+"/"+op)
	}
	add("PATCH DELETE", team+"/members/"+id)
	add("DELETE", team+"/invitations/"+id)
	add("GET HEAD", "/api/v1/me/workers")
	add("GET HEAD", worker)
	add("POST", "/api/v1/me/workers/monitoring/query")
	add("GET PUT", worker+"/monitoring")
	add("GET HEAD PUT", worker+"/configuration")
	add("POST", worker+"/report")
	add("POST", worker+"/readonly/requests")
	add("GET", worker+"/readonly/channel")
	for _, path := range []string{"/api/v1/me/worker-prompt", "/api/v1/me/projects/" + id + "/worker-prompt", worker + "/prompt"} {
		add("GET HEAD PUT", path)
	}
	add("GET HEAD POST", p+"/tasks")
	add("GET HEAD PATCH DELETE", task)
	add("PUT", task+"/status")
	add("POST", p+"/tasks/search")
	add("GET HEAD", "/api/v1/task-properties/schema")
	add("GET HEAD", task+"/properties")
	add("PUT DELETE", task+"/properties/name")
	add("POST PATCH", task+"/worker-claim")
	for _, op := range []string{"release", "withdraw"} {
		add("POST", task+"/worker-claim/"+op)
	}
	add("GET HEAD POST", task+"/steps")
	add("GET HEAD PATCH DELETE", task+"/steps/abcdef01")
	for _, op := range []string{"status", "position"} {
		add("PUT", task+"/steps/abcdef01/"+op)
	}
	add("GET HEAD POST", task+"/thread/messages")
	add("GET HEAD", task+"/attachments")
	add("GET HEAD PUT DELETE", task+"/attachments/files/file")
	add("GET HEAD", task+"/preview/file")
	add("GET HEAD POST", "/api/v1/me/bots")
	add("GET HEAD", "/api/v1/me/bots/defaults")
	add("GET HEAD DELETE", "/api/v1/me/bots/"+id)
	add("POST", "/api/v1/bots/"+id+"/attention/seen")
	add("GET HEAD", worker+"/bots")
	for _, op := range []string{"register", "grant", "report", "deletion-complete"} {
		add("POST", worker+"/bots/"+id+"/"+op)
	}
	add("GET", "/api/v1/session-capabilities")
	add("GET", "/api/v1/test-session-capabilities")
	add("GET POST", task+"/sessions")
	add("GET", task+"/sessions/current")
	for _, op := range []string{"timeline", "channel", "state", "inspection", "messages", "message-content", "archive/receipt", "archive/state"} {
		add("GET", session+"/"+op)
	}
	for _, op := range []string{"recording-evidence", "automation-recovery"} {
		add("GET", session+"/"+op+"/"+id)
	}
	add("GET POST", "/api/v1/test-sessions")
	add("GET", testSession)
	add("POST", testSession+"/stop")
	for _, base := range []string{session, testSession} {
		for _, op := range []string{"controller-grant", "commands"} {
			add("POST", base+"/"+op)
		}
		for _, op := range []string{"timeline", "channel"} {
			add("GET", base+"/"+op)
		}
		add("GET", base+"/operations/"+id)
		add("GET", base+"/resources/"+id+"/content")
		add("GET PUT DELETE", base+"/image-uploads/"+id)
		add("PUT", base+"/image-uploads/"+id+"/content")
		add("PUT", base+"/image-uploads/"+id+"/chunks")
		add("POST", base+"/image-uploads/"+id+"/complete")
		add("GET", base+"/image-capabilities")
		add("GET", base+"/image-occurrences/"+id)
		add("POST", base+"/image-occurrences/"+id+"/retry")
		add("GET", base+"/archive")
		add("GET", base+"/archive/content")
		add("GET", base+"/archive/files/"+id)
	}
	add("GET HEAD", "/api/v1/webhook-event-types")
	for _, base := range []string{"/api/v1/me/webhooks", team + "/webhooks"} {
		add("GET HEAD POST", base)
		add("GET HEAD PATCH DELETE", base+"/"+id)
		add("GET HEAD", base+"/operations/"+id)
		add("GET HEAD", base+"/"+id+"/signing-secret")
		add("POST", base+"/"+id+"/signing-secret/rotations")
		add("GET HEAD", base+"/"+id+"/deliveries")
		add("GET HEAD", base+"/"+id+"/deliveries/"+id)
		for _, op := range []string{"attempts", "payload"} {
			add("GET HEAD", base+"/"+id+"/deliveries/"+id+"/"+op)
		}
		add("POST", base+"/"+id+"/deliveries/"+id+"/redeliveries")
	}
	for _, route := range routes {
		for _, method := range strings.Fields(route.methods) {
			t.Run(method+" "+route.path, func(t *testing.T) {
				headers := http.Header{"Origin": {browserAPIOrigin}, "Access-Control-Request-Method": {method}, "Access-Control-Request-Headers": {strings.ToLower(corsRequestHeaders)}}
				w := corsHTTP(t, handler, http.MethodOptions, route.path, headers)
				if w.Code != http.StatusNoContent || w.Body.Len() != 0 || w.Header().Get("Access-Control-Allow-Methods") != method {
					t.Fatalf("preflight: %d %s %v", w.Code, w.Body.String(), w.Header())
				}
				assertBrowserCORS(t, w, true)
			})
		}
	}
	if witness.calls != 0 {
		t.Fatalf("preflight authentication calls: %d", witness.calls)
	}
}

func TestRootCORSRefusesUnregisteredMethodsAndProducerHeaders(t *testing.T) {
	handler, _, witness := rootCORSFixture(t, browserAPIOrigin, defaultHTTPPrincipal())
	const id = "10000000-0000-4000-8000-000000000001"
	task := "/api/v1/projects/" + id + "/tasks/" + id
	session := task + "/sessions/" + id
	for _, route := range []struct{ method, path string }{
		{"DELETE", "/api/v1/me"}, {"HEAD", "/api/v1/me/workers/" + id + "/monitoring"}, {"HEAD", "/api/v1/oauth/grants"},
		{"HEAD", "/api/v1/session-capabilities"}, {"HEAD", task + "/sessions"}, {"HEAD", session + "/state"},
		{"HEAD", session + "/channel"}, {"HEAD", session + "/archive"}, {"GET", task[:strings.LastIndex(task, "/")] + "/search"},
		{"GET", "/api/v1/me/webhooks/" + id + "/deliveries/" + id + "/redeliveries"}, {"POST", "/api/v1/unknown"},
		{"TRACE", "/api/v1/me"},
		{"GET", "/api/v1/bots/" + id + "/attention/seen"},
		{"HEAD", "/api/v1/bots/" + id + "/attention/seen"},
		{"DELETE", "/api/v1/bots/" + id + "/attention/seen"},
		{"POST", "/api/v1/bots/" + id + "/attention/other"},
		{"POST", "/api/v1/assistant-task-events/attention"},
	} {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			w := corsHTTP(t, handler, "OPTIONS", route.path, http.Header{"Origin": {browserAPIOrigin}, "Access-Control-Request-Method": {route.method}})
			if w.Code != 403 {
				t.Fatalf("unsupported method: %d %s", w.Code, w.Body.String())
			}
			assertBrowserCORS(t, w, true)
		})
	}
	for _, name := range []string{"Daynight-Controller-Fence", "Daynight-Controller-Token", "Daynight-File-Byte-Length", "Daynight-File-SHA256", "Content-Encoding", "X-Unknown"} {
		t.Run(name, func(t *testing.T) {
			w := corsHTTP(t, handler, "OPTIONS", "/api/v1/me", http.Header{"Origin": {browserAPIOrigin}, "Access-Control-Request-Method": {"GET"}, "Access-Control-Request-Headers": {"Authorization, " + name}})
			if w.Code != 403 {
				t.Fatalf("producer header allowed: %d", w.Code)
			}
			assertBrowserCORS(t, w, true)
		})
	}
	if witness.calls != 0 {
		t.Fatalf("refused preflight authenticated %d times", witness.calls)
	}
}

func TestRootCORSKeepsResponseAndAuthenticationSemantics(t *testing.T) {
	handler, db, witness := rootCORSFixture(t, browserAPIOrigin, defaultHTTPPrincipal())
	const id = "10000000-0000-4000-8000-000000000001"
	headers := http.Header{"Origin": {browserAPIOrigin}, "X-Request-Id": {"cors-response"}}
	for _, tc := range []struct {
		method, path string
		status       int
		code         string
	}{
		{"GET", "/api/v1/me", 401, "unauthenticated"},
		{"POST", "/api/v1/bots/" + id + "/attention/seen", 401, "unauthenticated"},
		{"GET", "/api/v1/projects/" + id + "/tasks/" + id + "/attachments/files/a/../b", 400, "invalid_input"},
		{"GET", "/api/v1/unknown", 404, "not_found"},
	} {
		w := corsHTTP(t, handler, tc.method, tc.path, headers)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
		assertBrowserCORS(t, w, false)
	}
	if witness.calls != 0 {
		t.Fatalf("credentials reached identity: %d", witness.calls)
	}
	headers.Set("Authorization", "Bearer "+defaultHTTPToken())
	for _, tc := range []struct {
		method, path string
		status       int
	}{{"GET", "/api/v1/task-properties/schema", 200}, {"DELETE", "/api/v1/me", 405}, {"HEAD", "/api/v1/me/workers/" + id + "/monitoring", 405}, {"POST", "/api/v1/bots/" + id + "/attention/seen", 400}, {"GET", "/api/v1/bots/" + id + "/attention/seen", 405}} {
		w := corsHTTP(t, handler, tc.method, tc.path, headers)
		if w.Code != tc.status {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body.String())
		}
		assertBrowserCORS(t, w, false)
		if w.Header().Get("Daynight-User-ID") != defaultHTTPPrincipal().UserID || w.Header().Get("X-Request-ID") != "cors-response" {
			t.Fatalf("protocol identity headers: %v", w.Header())
		}
	}
	for _, tc := range []struct {
		code   string
		status int
	}{{"forbidden", 403}, {"resource_conflict", 409}} {
		db.ReadSnapshotCall = func(context.Context, func(store.SnapshotScope) error) error {
			return &model.Fault{Code: tc.code, Message: "Controlled domain refusal."}
		}
		w := corsHTTP(t, handler, "GET", "/api/v1/projects/"+id, headers)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) {
			t.Fatalf("domain error: %d %s", w.Code, w.Body.String())
		}
		assertBrowserCORS(t, w, false)
	}
}

func TestRootCORSOriginAndNativeCredentialPolicies(t *testing.T) {
	for _, allowed := range []string{browserAPIOrigin, ""} {
		t.Run("configured="+allowed, func(t *testing.T) {
			handler, _, witness := rootCORSFixture(t, allowed, defaultHTTPPrincipal())
			for _, origins := range [][]string{nil, {"https://other.example"}, {browserAPIOrigin + "/"}, {browserAPIOrigin, browserAPIOrigin}, {browserAPIOrigin}} {
				headers := http.Header{"Authorization": {"Bearer " + defaultHTTPToken()}}
				if origins != nil {
					headers["Origin"] = origins
				}
				w := corsHTTP(t, handler, "GET", "/api/v1/task-properties/schema", headers)
				if w.Code != 200 {
					t.Fatalf("Origin changed native REST authentication: %d %s", w.Code, w.Body.String())
				}
				want := ""
				if allowed != "" && len(origins) == 1 && origins[0] == allowed {
					want = allowed
				}
				if w.Header().Get("Access-Control-Allow-Origin") != want {
					t.Fatalf("Origin %v: %v", origins, w.Header())
				}
			}
			before := witness.calls
			w := corsHTTP(t, handler, "OPTIONS", "/api/v1/me", http.Header{"Origin": {browserAPIOrigin}, "Access-Control-Request-Method": {"GET"}})
			expected := http.StatusNoContent
			if allowed == "" {
				expected = http.StatusUnauthorized
			}
			if w.Code != expected || witness.calls != before {
				t.Fatalf("configured browser preflight: %d authentication calls=%d", w.Code, witness.calls-before)
			}
			if allowed != "" {
				for _, origins := range [][]string{nil, {"https://other.example"}, {browserAPIOrigin, browserAPIOrigin}} {
					headers := http.Header{"Access-Control-Request-Method": {"GET"}}
					if origins != nil {
						headers["Origin"] = origins
					}
					w := corsHTTP(t, handler, "OPTIONS", "/api/v1/me", headers)
					if w.Code != http.StatusForbidden || witness.calls != before || w.Header().Get("Access-Control-Allow-Origin") != "" {
						t.Fatalf("unapproved preflight: %d calls=%d %v", w.Code, witness.calls-before, w.Header())
					}
				}
			}

		})
	}
	principal := defaultHTTPPrincipal()
	principal.Kind = model.SessionCredential
	handler, _, _ := rootCORSFixture(t, browserAPIOrigin, principal)
	w := corsHTTP(t, handler, "PATCH", "/api/v1/me", http.Header{"Origin": {browserAPIOrigin}, "Cookie": {"__Host-daynight_session=" + httpTestToken(model.SessionCredential)}})
	if w.Code != 403 || !strings.Contains(w.Body.String(), "Cookie writes require the exact main-site Origin") {
		t.Fatalf("Cookie mutation admission: %d %s", w.Code, w.Body.String())
	}
	assertBrowserCORS(t, w, false)
	w = corsHTTP(t, handler, "PATCH", "/api/v1/me", http.Header{"Origin": {configuredTestConfig().Server.PublicOrigin}, "Cookie": {"__Host-daynight_session=" + httpTestToken(model.SessionCredential)}})
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"code":"invalid_input"`) {
		t.Fatalf("main-site Cookie mutation did not reach body validation: %d %s", w.Code, w.Body.String())
	}
	handler, _, _ = rootCORSFixture(t, browserAPIOrigin, defaultHTTPPrincipal())
	w = corsHTTP(t, handler, "GET", "/api/v1/oauth/grants", http.Header{"Origin": {browserAPIOrigin}, "Authorization": {"Bearer " + defaultHTTPToken()}})
	if w.Code != 403 {
		t.Fatalf("PAT gained session-only grant capability: %d %s", w.Code, w.Body.String())
	}
	assertBrowserCORS(t, w, false)
}

func TestRootCORSLeavesPublicPolicies(t *testing.T) {
	handler, _, witness := rootCORSFixture(t, browserAPIOrigin, defaultHTTPPrincipal())
	for _, route := range []struct{ method, path string }{
		{"GET", "/healthz"}, {"POST", "/api/v1/oauth/s2s/token"},
		{"GET", "/api/v1/controller-channel"}, {"PUT", "/api/v1/controller-resources/10000000-0000-4000-8000-000000000001"},
	} {
		w := corsHTTP(t, handler, "OPTIONS", route.path, http.Header{"Origin": {browserAPIOrigin}, "Access-Control-Request-Method": {route.method}})
		if w.Header().Get("Access-Control-Allow-Origin") != "" || w.Code == 204 {
			t.Fatalf("public browser capability %s: %d %v", route.path, w.Code, w.Header())
		}
	}
	w := corsHTTP(t, handler, "OPTIONS", "/oauth/token", http.Header{"Origin": {browserAPIOrigin}, "Access-Control-Request-Method": {"POST"}, "Access-Control-Request-Headers": {"Content-Type"}})
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("public OAuth CORS changed: %d %v", w.Code, w.Header())
	}
	if witness.calls != 0 {
		t.Fatalf("excluded preflight authenticated %d times", witness.calls)
	}
}

func TestRootCORSProducerRoutesKeepTheirAdmission(t *testing.T) {
	handler, db, witness := rootCORSFixture(t, browserAPIOrigin, defaultHTTPPrincipal())
	native, nativeDB, nativeWitness := rootCORSFixture(t, "", defaultHTTPPrincipal())
	noIdentity := func(context.Context, func(store.IdentityScope) error) (store.Completion, error) {
		t.Fatal("producer preflight or missing credentials reached identity initialization")
		return store.Completion{}, nil
	}
	db.WriteIdentityCall = noIdentity
	nativeDB.WriteIdentityCall = noIdentity
	const id = "10000000-0000-4000-8000-000000000001"
	session := "/api/v1/projects/" + id + "/tasks/" + id + "/sessions/" + id
	testSession := "/api/v1/test-sessions/" + id
	var routes []struct{ methods, path string }
	add := func(methods, path string) { routes = append(routes, struct{ methods, path string }{methods, path}) }
	add("GET HEAD", session+"/worker-channel")
	add("POST", session+"/worker-messages")
	for _, base := range []string{session, testSession} {
		add("PUT", base+"/image-history-ledger/"+id)
		add("GET HEAD", base+"/image-history-ledger/"+id+"/status")
		add("POST PUT", base+"/archive")
		add("GET HEAD POST", base+"/archive/prepare")
		add("POST", base+"/archive/source-tail")
		add("POST", base+"/archive/seal")
		add("PUT", base+"/archive/content")
		add("PUT", base+"/archive/prepare/history/"+id)
		add("GET HEAD", base+"/archive/prepare/history/"+id+"/status")
		add("PUT", base+"/archive/files/"+id)
		add("GET HEAD", base+"/archive/files/"+id+"/status")
	}
	for _, route := range routes {
		for _, method := range strings.Fields(route.methods) {
			t.Run(method+" "+route.path, func(t *testing.T) {
				preflight := corsHTTP(t, handler, "OPTIONS", route.path, http.Header{
					"Origin": {browserAPIOrigin}, "Access-Control-Request-Method": {method},
					"Access-Control-Request-Headers": {"Authorization, Content-Type, Daynight-Session-Protocol, Daynight-Chunk-SHA256"},
				})
				if preflight.Code != http.StatusForbidden || preflight.Header().Get("Access-Control-Allow-Origin") != "" ||
					preflight.Header().Get("Access-Control-Allow-Methods") != "" || preflight.Header().Get("Access-Control-Expose-Headers") != "" {
					t.Fatalf("producer preflight: %d %s %v", preflight.Code, preflight.Body.String(), preflight.Header())
				}
				headers := http.Header{"Origin": {browserAPIOrigin}, "X-Request-Id": {"producer-admission"}}
				actual := corsHTTP(t, handler, method, route.path, headers)
				original := corsHTTP(t, native, method, route.path, headers)
				if actual.Code != original.Code || actual.Body.String() != original.Body.String() || actual.Code < 400 ||
					actual.Header().Get("Access-Control-Allow-Origin") != "" || actual.Header().Get("Access-Control-Expose-Headers") != "" {
					t.Fatalf("producer admission changed: current=%d %s original=%d %s headers=%v", actual.Code, actual.Body.String(), original.Code, original.Body.String(), actual.Header())
				}
			})
		}
	}
	if witness.calls != 0 || nativeWitness.calls != 0 {
		t.Fatalf("producer credential-less authentication calls: current=%d original=%d", witness.calls, nativeWitness.calls)
	}
}
