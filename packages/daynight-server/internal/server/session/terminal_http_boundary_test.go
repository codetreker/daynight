package session_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func TestTerminalCapabilitiesAreExplicit(t *testing.T) {
	authentication := newRouteAuthentication(t, "https://daynight.example")
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	token := authentication.Credential(principal)
	routes := sessionhttp.NewRoutes(nil, authentication.Authentication, testLogger())
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/session-capabilities", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set(v2.ProtocolHeader, v2.Protocol)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"recordingResponsibilityVersion":1`) || !strings.Contains(w.Body.String(), v2.Protocol) {
		t.Fatal(w.Body.String())
	}
	if authentication.Count() != 1 {
		t.Fatal("capabilities did not authenticate the supplied credential exactly once")
	}
}

func TestTerminalHTTPRefusesMalformedAndCrossRouteMessages(t *testing.T) {
	f := terminalHTTPSetup(t)
	for _, protocol := range []string{"future", " "} {
		w := terminalRequest(f.h, http.MethodGet, f.base+"/current", "", protocol)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "unsupported_protocol") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, body := range []string{"{}", `{"protocol":"daynight.session.v2","protocol":"daynight.session.v2"}`} {
		w := terminalRequest(f.h, http.MethodPost, f.base, body, v2.Protocol)
		if w.Code != http.StatusBadRequest {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	f.register(t)
	path := f.base + "/" + f.message.SessionID
	w := terminalRequest(f.h, http.MethodGet, path+"/timeline", "", v2.Protocol)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "unsupported_content_kind") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = terminalRequest(f.h, http.MethodPost, path+"/worker-messages", jsonBody(t, f.message), v2.Protocol)
	if w.Code != http.StatusBadRequest {
		t.Fatal(w.Code, w.Body.String())
	}
	w = terminalRequest(f.h, http.MethodGet, path+"/channel", "", v2.Protocol)
	if w.Code != http.StatusBadRequest {
		t.Fatal(w.Code, w.Body.String())
	}
	w = terminalRequest(f.h, http.MethodGet, path+"/archive/receipt", "", v2.Protocol, "terminal-archive-status")
	if w.Code != http.StatusConflict {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestTerminalHTTPBoundaryAndReadbackErrors(t *testing.T) {
	f := terminalHTTPSetup(t)
	f.register(t)
	path := f.base + "/" + f.message.SessionID
	for _, tc := range []struct {
		method, suffix, body, protocol string
		code                           int
		plans                          []string
	}{
		{"GET", "/state", "", v2.Protocol, 200, []string{"terminal-state"}},
		{"GET", "/archive/state", "", v2.Protocol, 200, []string{"terminal-archive-state"}},
		{"GET", "/archive/state", "", "", 400, nil},
		{"GET", "/archive/state", "", sp.Protocol, 400, nil},
		{"GET", "/archive/state", "", "future", 400, nil},
		{"GET", "/archive/state?extra=1", "", v2.Protocol, 400, nil},
		{"GET", "/archive/state?generation=1&generation=2", "", v2.Protocol, 400, nil},
		{"HEAD", "/archive/state", "", v2.Protocol, 405, nil},
		{"POST", "/archive/state", "{}", v2.Protocol, 405, nil},
		{"DELETE", "/archive/state", "", v2.Protocol, 405, nil},
		{"GET", "/state", "", "", 400, nil},
		{"HEAD", "/state", "", v2.Protocol, 405, nil},
		{"DELETE", "/state", "", v2.Protocol, 405, nil},
		{"HEAD", "/worker-messages", "", v2.Protocol, 405, nil},
		{"GET", "/archive", "", v2.Protocol, 200, []string{"terminal-archive-status"}},
		{"GET", "/archive/content", "", v2.Protocol, 409, []string{"terminal-upload-preflight", "terminal-read-content"}},
		{"PUT", "/archive", "{}", v2.Protocol, 409, []string{"terminal-upload-preflight"}},
		{"GET", "/recording-evidence/" + uuid.NewString() + "?generation=1", "", v2.Protocol, 404, []string{"terminal-evidence-read"}},
		{"GET", "/recording-evidence/" + uuid.NewString() + "?extra=1", "", v2.Protocol, 400, nil},
		{"GET", "/automation-recovery/" + uuid.NewString(), "", v2.Protocol, 404, []string{"terminal-recovery-read"}},
		{"GET", "/automation-recovery/" + uuid.NewString() + "?extra=1", "", v2.Protocol, 400, nil},
		{"GET", "/automation-recovery/" + uuid.NewString(), "", sp.Protocol, 400, nil},
		{"GET", "/state?extra=1", "", v2.Protocol, 400, nil},
		{"GET", "/operations/" + uuid.NewString(), "", v2.Protocol, 404, []string{"terminal-operation"}},
		{"POST", "/commands", jsonBody(t, f.message), v2.Protocol, 400, nil},
		{"POST", "/worker-messages?extra=1", jsonBody(t, f.message), v2.Protocol, 400, nil},
		{"GET", "/worker-channel?extra=1", "", v2.Protocol, 400, nil},
		{"GET", "/worker-channel", "", v2.Protocol, 400, nil},
		{"GET", "/channel?extra=1", "", v2.Protocol, 400, nil},
	} {
		t.Run(tc.method+tc.suffix+tc.protocol, func(t *testing.T) {
			w := terminalRequest(f.h, tc.method, path+tc.suffix, tc.body, tc.protocol, tc.plans...)
			if w.Code != tc.code {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	for _, query := range []string{"?limit=no", "?extra=1"} {
		w := terminalRequest(f.h, http.MethodGet, f.base+query, "", v2.Protocol)
		if w.Code != http.StatusBadRequest {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, contentType := range []string{"text/plain", "application/json; charset=latin1"} {
		r := httptest.NewRequest(http.MethodPost, f.base, strings.NewReader(jsonBody(t, f.message)))
		authorizeResourceRequest(f.h, r)
		r.Header.Set(v2.ProtocolHeader, v2.Protocol)
		r.Header.Set("Content-Type", contentType)
		w := httptest.NewRecorder()
		f.h.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	other := f.message
	other.SessionID = uuid.NewString()
	w := terminalRequest(f.h, http.MethodPost, path+"/worker-messages", jsonBody(t, other), v2.Protocol)
	if w.Code != http.StatusConflict {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, epoch := range []string{"0", "01", "no"} {
		r := httptest.NewRequest(http.MethodPost, path+"/worker-messages", strings.NewReader(jsonBody(t, f.message)))
		authorizeResourceRequest(f.h, r)
		r.Header.Set(v2.ProtocolHeader, v2.Protocol)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Daynight-Connection-Epoch", epoch)
		w := httptest.NewRecorder()
		f.h.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestTerminalWorkerChannelRejectsBinaryRegistration(t *testing.T) {
	f := terminalHTTPSetup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	header := f.backend.PlanHeader()
	header.Set("Authorization", "Bearer "+f.h.token)
	c, _, err := websocket.Dial(ctx, f.server.URL+f.base+"/"+f.message.SessionID+"/worker-channel", &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err = c.Write(ctx, websocket.MessageBinary, []byte(jsonBody(t, f.message))); err != nil {
		t.Fatal(err)
	}
	if _, _, err = c.Read(ctx); err == nil {
		t.Fatal("binary registration accepted")
	}
	if ctx.Err() != nil {
		t.Fatal("binary registration did not close the socket before the caller deadline", err)
	}
}
