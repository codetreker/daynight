package github

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestAdminInputRefusals(t *testing.T) {
	noCall := adminOps{call: func(context.Context, model.Principal, string, ...any) (any, error) {
		t.Fatal("business called after protocol refusal")
		return nil, nil
	}}
	h := adminMux(t, noCall, io.Discard)
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", appPath + "/bad/admins", "", 400},
		{"GET", adminBase + "/admins?unexpected=1", "", 400},
		{"GET", adminBase + "/admins?limit=0", "", 400},
		{"GET", adminBase + "/admins?limit=01", "", 400},
		{"GET", adminBase + "/admins?limit=101", "", 400},
		{"GET", adminBase + "/admins?limit=bad", "", 400},
		{"GET", adminBase + "/admin-invitations?limit=2&limit=3", "", 400},
		{"POST", adminBase + "/admin-invitations", `{"expectedUserId":null}`, 400},
		{"POST", adminBase + "/admin-invitations", `{"expectedUserId":"\ud800"}`, 400},
		{"POST", adminBase + "/admin-invitations", `{"expectedUserId":"x","role":"admin"}`, 400},
		{"POST", adminBase + "/admin-invitations?token=secret", adminExpected, 400},
		{"POST", adminBase + "/admin-invitations", "{", 400},
		{"POST", adminBase + "/admin-invitations", strings.Repeat("x", appWriteBytes+1), 413},
		{"POST", adminBase + "/admin-invitations/bad/revoke", adminExpected, 400},
		{"POST", adminBase + "/admin-invitations/" + adminInviteID + "/revoke", `{}`, 400},
		{"POST", adminBase + "/admin-invitations/" + adminInviteID + "/revoke", `{"expectedUserId":false}`, 400},
		{"POST", adminBase + "/admins/bad/remove", adminExpected, 400},
		{"POST", adminBase + "/admins/" + userID + "/remove", `{}`, 400},
		{"POST", adminBase + "/admins/" + userID + "/remove", `{"membershipVersion":"0"}`, 400},
		{"POST", adminBase + "/admins/" + userID + "/remove", `{"membershipVersion":"01"}`, 400},
		{"POST", adminBase + "/admins/" + userID + "/remove", `{"membershipVersion":2}`, 400},
		{"POST", adminBase + "/admins/" + userID + "/remove", `{"membershipVersion":"2"}`, 400},
		{"POST", "/api/v1/github-app-admin-invitations/inspect", `{}`, 400},
		{"POST", "/api/v1/github-app-admin-invitations/inspect", `{"token":null}`, 400},
		{"POST", "/api/v1/github-app-admin-invitations/inspect?token=secret", `{"token":"secret"}`, 400},
		{"POST", "/api/v1/github-app-admin-invitations/accept", `{}`, 400},
		{"POST", "/api/v1/github-app-admin-invitations/accept", `{"token":true}`, 400},
		{"POST", "/api/v1/github-app-admin-invitations/accept", `{"token":"secret"}`, 400},
	} {
		t.Run(tc.method+tc.path+tc.body[:min(len(tc.body), 40)], func(t *testing.T) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, appRequest(tc.method, tc.path, tc.body))
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body)
			}
		})
	}
	for _, tc := range adminRequests() {
		r := appRequest(tc.method, tc.path, tc.body)
		r.Header.Del("Authorization")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("auth %s: %d %s", tc.name, w.Code, w.Body)
		}
		method := "PUT"
		w = httptest.NewRecorder()
		h.ServeHTTP(w, appRequest(method, strings.Split(tc.path, "?")[0], ""))
		if w.Code != 405 || w.Header().Get("Allow") == "" {
			t.Fatalf("method %s: %d %v %s", tc.name, w.Code, w.Header(), w.Body)
		}
	}
}

func TestAdminEmptyAndNullablePages(t *testing.T) {
	for _, tc := range adminRequests() {
		if tc.name != "admins" && tc.name != "invitations" && tc.name != "inspect" {
			continue
		}
		t.Run(tc.name, func(t *testing.T) {
			h := adminMux(t, adminOps{call: func(context.Context, model.Principal, string, ...any) (any, error) {
				switch tc.name {
				case "admins":
					return core.AdminPage{}, nil
				case "invitations":
					return core.AdminInvitationPage{}, nil
				default:
					return core.AdminInvitationInspection{}, nil
				}
			}}, io.Discard)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, appRequest(tc.method, tc.path, tc.body))
			expected := `"items":[]`
			if tc.name == "inspect" {
				expected = `"membership":null`
			}
			if w.Code != 200 || !strings.Contains(w.Body.String(), expected) {
				t.Fatalf("status=%d body=%s", w.Code, w.Body)
			}
		})
	}
}

func TestAdminCancellationAndResponseFailure(t *testing.T) {
	for _, tc := range adminRequests() {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			started := make(chan struct{})
			finished := make(chan struct{})
			calls := 0
			var logs bytes.Buffer
			h := adminMux(t, adminOps{call: func(work context.Context, _ model.Principal, _ string, _ ...any) (any, error) {
				calls++
				close(started)
				<-work.Done()
				return nil, work.Err()
			}}, &logs)
			w := httptest.NewRecorder()
			go func() { h.ServeHTTP(w, appRequest(tc.method, tc.path, tc.body).WithContext(ctx)); close(finished) }()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("business did not start")
			}
			cancel()
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("request did not finish")
			}
			if calls != 1 || w.Body.Len() != 0 || !strings.Contains(logs.String(), "canceled") {
				t.Fatalf("calls=%d body=%s logs=%s", calls, w.Body, logs.String())
			}
		})
	}
	for _, tc := range adminRequests() {
		if tc.method != "POST" || tc.name == "inspect" {
			continue
		}
		t.Run(tc.name+" response failure", func(t *testing.T) {
			calls := 0
			var logs bytes.Buffer
			h := adminMux(t, adminOps{call: func(context.Context, model.Principal, string, ...any) (any, error) {
				calls++
				switch tc.name {
				case "create":
					return core.MintedAdminInvitation{Invitation: adminInvitation(), Secret: adminToken}, nil
				case "revoke":
					return core.AdminInvitationRevocation{AppID: appID}, nil
				case "remove":
					return core.AdminRemoval{AppID: appID}, nil
				default:
					return core.AdminInvitationAcceptance{AppID: appID, Membership: adminMember()}, nil
				}
			}}, &logs)
			w := &adminFailedWriter{header: make(http.Header)}
			h.ServeHTTP(w, appRequest(tc.method, tc.path, tc.body))
			if calls != 1 || w.writes != 1 || !strings.Contains(logs.String(), "write_outcome=unknown") || strings.Contains(logs.String(), adminToken) {
				t.Fatalf("calls=%d writes=%d log=%s", calls, w.writes, logs.String())
			}
		})
	}
}

type adminFailedWriter struct {
	header http.Header
	writes int
}

func (w *adminFailedWriter) Header() http.Header         { return w.header }
func (w *adminFailedWriter) WriteHeader(int)             {}
func (w *adminFailedWriter) Write(p []byte) (int, error) { w.writes++; return len(p) - 1, nil }

func TestAdminBudgetBeforeAndDuringBody(t *testing.T) {
	var logs bytes.Buffer
	h := &adminHandler{logger: slog.New(slog.NewTextHandler(&logs, nil))}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w := httptest.NewRecorder()
	r := appRequest("POST", adminBase+"/admin-invitations", "").WithContext(ctx)
	body := &unreadAppBody{}
	r.Body = body
	h.run(w, r, model.Principal{UserID: userID}, "create_admin_invitation", true, 201, func(*http.Request, string) (any, error) { t.Fatal("callback after cancellation"); return nil, nil })
	if body.reads != 0 || w.Body.Len() != 0 {
		t.Fatalf("reads=%d body=%s", body.reads, w.Body)
	}
	budget := &controlledAppBudget{Context: context.Background(), done: make(chan struct{})}
	r = appRequest("POST", adminBase+"/admin-invitations", "")
	r.Body = expireAppBody{budget: budget}
	w = httptest.NewRecorder()
	h.runWithContext(w, r, model.Principal{UserID: userID}, "create_admin_invitation", true, 201, budget, func(work *http.Request, _ string) (any, error) { return adminFields(w, work, "expectedUserId") })
	if w.Code != 504 || !strings.Contains(w.Body.String(), `"code":"timeout"`) {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
}

func TestAdminInternalDeadlineBodyError(t *testing.T) {
	h := &adminHandler{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx, cancel := context.WithTimeoutCause(context.Background(), 100*time.Millisecond, errAdminDeadline)
	defer cancel()
	w := httptest.NewRecorder()
	r := appRequest("POST", adminBase+"/admin-invitations", "")
	h.runWithContext(w, r, model.Principal{UserID: userID}, "create_admin_invitation", true, 201, ctx, func(*http.Request, string) (any, error) {
		<-ctx.Done()
		return nil, &httpx.BodyReadError{Cause: context.DeadlineExceeded, Status: 400, Code: "invalid_input", Message: "bounded"}
	})
	if w.Code != 408 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
}
