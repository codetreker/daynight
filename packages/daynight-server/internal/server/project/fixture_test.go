package project

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

type requestMarker struct{}

type httpHarness struct {
	t                *testing.T
	Projects         *projectMock
	Memberships      *membershipMock
	Auth             *authhttp.RequestAuthentication
	Logs             bytes.Buffer
	Handler          http.Handler
	Principal        model.Principal
	Project          model.Project
	Cookie           *http.Cookie
	Origin           string
	AuthenticateFunc authhttp.AuthenticateCredential
	mu               sync.Mutex
	calls            map[string]int
}

func newHTTPHarness(t *testing.T) *httpHarness {
	t.Helper()
	h := &httpHarness{t: t, calls: map[string]int{}, Origin: "http://127.0.0.1:8787", Principal: model.Principal{UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "10000000-0000-4000-8000-000000000002"}}
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	h.Project = model.Project{ID: "20000000-0000-4000-8000-000000000001", Name: "Shared project", RepoURL: "https://example.com/shared.git", CreatedAt: now, UpdatedAt: now, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}, Ownership: model.ProjectOwnership{TeamID: "30000000-0000-4000-8000-000000000001", Version: 1}}
	h.Cookie = &http.Cookie{Name: "daynight_session", Value: "controlled-credential"}
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	h.AuthenticateFunc = func(ctx context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		if ctx.Value(requestMarker{}) != h {
			t.Error("authentication lost request context")
		}
		if (kind != model.SessionCredential && kind != model.PATCredential) || secret != h.Cookie.Value {
			return model.Principal{}, authhttp.Failure()
		}
		return h.Principal, nil
	}
	var err error
	h.Auth, err = authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		return h.AuthenticateFunc(ctx, kind, secret)
	}, authconfig.AuthSettings{PublicOrigin: h.Origin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	h.Projects = &projectMock{h: h}
	h.Memberships = &membershipMock{h: h}
	mux := http.NewServeMux()
	RegisterRoutes(mux, h.Projects, h.Auth, logger)
	NewMembershipRoutes(h.Memberships, h.Auth, logger).RegisterRoutes(mux)
	h.Handler = httpx.RequestLogging(logger, mux)
	return h
}

func (h *httpHarness) request(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r = r.WithContext(context.WithValue(r.Context(), requestMarker{}, h))
	r.Header.Set("Origin", h.Origin)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Request-ID", "project-test")
	r.AddCookie(h.Cookie)
	return r
}

func (h *httpHarness) call(method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	r := h.request(method, path, body)
	if len(cookies) > 0 {
		r.Header.Del("Cookie")
		for _, cookie := range cookies {
			if cookie != nil {
				r.AddCookie(cookie)
			}
		}
	}
	w := httptest.NewRecorder()
	h.Handler.ServeHTTP(w, r)
	return w
}

func (h *httpHarness) invoked(name string, ctx context.Context, p model.Principal) {
	h.t.Helper()
	h.mu.Lock()
	h.calls[name]++
	h.mu.Unlock()
	if ctx.Value(requestMarker{}) != h {
		h.t.Errorf("%s lost request context", name)
	}
	if !reflect.DeepEqual(p, h.Principal) {
		h.t.Errorf("%s principal=%+v want=%+v", name, p, h.Principal)
	}
}

func (h *httpHarness) assertCalls(want map[string]int) {
	h.t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(want) == 0 && len(h.calls) == 0 {
		return
	}
	if !reflect.DeepEqual(h.calls, want) {
		h.t.Errorf("business calls=%v want=%v", h.calls, want)
	}
}

func jsonBody(t *testing.T, input any) string {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
func decodeResponse[T any](t *testing.T, w *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status=%d want=%d body=%s", w.Code, status, w.Body)
	}
	if contentType := w.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type=%q want application/json", contentType)
	}
	var value T
	if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

type projectMock struct {
	h                    *httpHarness
	CreateWithAccessFunc func(ctx context.Context, p model.Principal, input coreproject.CreateProject) (model.Project, model.ProjectAccess, error)
	GetWithAccessFunc    func(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error)
	ListScopedFunc       func(ctx context.Context, p model.Principal, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error)
	AccessFunc           func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error)
	UpdateSettingsFunc   func(ctx context.Context, p model.Principal, id string, input coreproject.UpdateProjectSettings) (model.Project, error)
	TransferPreviewFunc  func(ctx context.Context, p model.Principal, id, target string) (coreproject.TransferPreview, error)
	TransferFunc         func(ctx context.Context, p model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error)
	DeletionPreviewFunc  func(ctx context.Context, p model.Principal, id string, page model.PageRequest) (projectservice.DeletionPreview, error)
	DeleteFunc           func(ctx context.Context, p model.Principal, id string) (projectservice.DeletionReceipt, error)
}

func (m *projectMock) CreateWithAccess(ctx context.Context, p model.Principal, input coreproject.CreateProject) (model.Project, model.ProjectAccess, error) {
	m.h.invoked("CreateWithAccess", ctx, p)
	if m.CreateWithAccessFunc == nil {
		m.h.t.Errorf("unexpected CreateWithAccess call")
		panic(fmt.Sprintf("unexpected %s call", "CreateWithAccess"))
	}
	return m.CreateWithAccessFunc(ctx, p, input)
}

func (m *projectMock) GetWithAccess(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
	m.h.invoked("GetWithAccess", ctx, p)
	if m.GetWithAccessFunc == nil {
		m.h.t.Errorf("unexpected GetWithAccess call")
		panic(fmt.Sprintf("unexpected %s call", "GetWithAccess"))
	}
	return m.GetWithAccessFunc(ctx, p, id)
}

func (m *projectMock) ListScoped(ctx context.Context, p model.Principal, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
	m.h.invoked("ListScoped", ctx, p)
	if m.ListScopedFunc == nil {
		m.h.t.Errorf("unexpected ListScoped call")
		panic(fmt.Sprintf("unexpected %s call", "ListScoped"))
	}
	return m.ListScopedFunc(ctx, p, input)
}

func (m *projectMock) Access(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	m.h.invoked("Access", ctx, p)
	if m.AccessFunc == nil {
		m.h.t.Errorf("unexpected Access call")
		panic(fmt.Sprintf("unexpected %s call", "Access"))
	}
	return m.AccessFunc(ctx, p, id)
}

func (m *projectMock) UpdateSettings(ctx context.Context, p model.Principal, id string, input coreproject.UpdateProjectSettings) (model.Project, error) {
	m.h.invoked("UpdateSettings", ctx, p)
	if m.UpdateSettingsFunc == nil {
		m.h.t.Errorf("unexpected UpdateSettings call")
		panic(fmt.Sprintf("unexpected %s call", "UpdateSettings"))
	}
	return m.UpdateSettingsFunc(ctx, p, id, input)
}

func (m *projectMock) TransferPreview(ctx context.Context, p model.Principal, id, target string) (coreproject.TransferPreview, error) {
	m.h.invoked("TransferPreview", ctx, p)
	if m.TransferPreviewFunc == nil {
		m.h.t.Errorf("unexpected TransferPreview call")
		panic(fmt.Sprintf("unexpected %s call", "TransferPreview"))
	}
	return m.TransferPreviewFunc(ctx, p, id, target)
}

func (m *projectMock) Transfer(ctx context.Context, p model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error) {
	m.h.invoked("Transfer", ctx, p)
	if m.TransferFunc == nil {
		m.h.t.Errorf("unexpected Transfer call")
		panic(fmt.Sprintf("unexpected %s call", "Transfer"))
	}
	return m.TransferFunc(ctx, p, id, input)
}

func (m *projectMock) DeletionPreview(ctx context.Context, p model.Principal, id string, page model.PageRequest) (projectservice.DeletionPreview, error) {
	m.h.invoked("DeletionPreview", ctx, p)
	if m.DeletionPreviewFunc == nil {
		m.h.t.Errorf("unexpected DeletionPreview call")
		panic(fmt.Sprintf("unexpected %s call", "DeletionPreview"))
	}
	return m.DeletionPreviewFunc(ctx, p, id, page)
}

func (m *projectMock) Delete(ctx context.Context, p model.Principal, id string) (projectservice.DeletionReceipt, error) {
	m.h.invoked("Delete", ctx, p)
	if m.DeleteFunc == nil {
		m.h.t.Errorf("unexpected Delete call")
		panic(fmt.Sprintf("unexpected %s call", "Delete"))
	}
	return m.DeleteFunc(ctx, p, id)
}

type membershipMock struct {
	h                     *httpHarness
	ListWithAccessFunc    func(ctx context.Context, p model.Principal, id string) (coreproject.ProjectParticipants, error)
	SetRoleFunc           func(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error)
	RemoveFunc            func(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) error
	SetGrantFunc          func(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error)
	RemoveGrantFunc       func(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) (coreproject.RemoveGrantResult, error)
	CreateInvitationFunc  func(ctx context.Context, p model.Principal, id, expected string) (coreproject.MintedInvitation, error)
	ListInvitationsFunc   func(ctx context.Context, p model.Principal, id string) ([]model.ProjectInvitation, error)
	RevokeInvitationFunc  func(ctx context.Context, p model.Principal, id, inviteID, expected string) error
	InspectInvitationFunc func(ctx context.Context, p model.Principal, secret string) (coreproject.InvitationInspection, error)
	AcceptInvitationFunc  func(ctx context.Context, p model.Principal, secret, expected string) (coreproject.InvitationAcceptance, error)
}

func (m *membershipMock) ListWithAccess(ctx context.Context, p model.Principal, id string) (coreproject.ProjectParticipants, error) {
	m.h.invoked("ListWithAccess", ctx, p)
	if m.ListWithAccessFunc == nil {
		m.h.t.Errorf("unexpected ListWithAccess call")
		panic(fmt.Sprintf("unexpected %s call", "ListWithAccess"))
	}
	return m.ListWithAccessFunc(ctx, p, id)
}

func (m *membershipMock) SetRole(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error) {
	m.h.invoked("SetRole", ctx, p)
	if m.SetRoleFunc == nil {
		m.h.t.Errorf("unexpected SetRole call")
		panic(fmt.Sprintf("unexpected %s call", "SetRole"))
	}
	return m.SetRoleFunc(ctx, p, projectID, userID, input)
}

func (m *membershipMock) Remove(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) error {
	m.h.invoked("Remove", ctx, p)
	if m.RemoveFunc == nil {
		m.h.t.Errorf("unexpected Remove call")
		panic(fmt.Sprintf("unexpected %s call", "Remove"))
	}
	return m.RemoveFunc(ctx, p, projectID, userID, input)
}

func (m *membershipMock) SetGrant(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error) {
	m.h.invoked("SetGrant", ctx, p)
	if m.SetGrantFunc == nil {
		m.h.t.Errorf("unexpected SetGrant call")
		panic(fmt.Sprintf("unexpected %s call", "SetGrant"))
	}
	return m.SetGrantFunc(ctx, p, projectID, userID, input)
}

func (m *membershipMock) RemoveGrant(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) (coreproject.RemoveGrantResult, error) {
	m.h.invoked("RemoveGrant", ctx, p)
	if m.RemoveGrantFunc == nil {
		m.h.t.Errorf("unexpected RemoveGrant call")
		panic(fmt.Sprintf("unexpected %s call", "RemoveGrant"))
	}
	return m.RemoveGrantFunc(ctx, p, projectID, userID, input)
}

func (m *membershipMock) CreateInvitation(ctx context.Context, p model.Principal, id, expected string) (coreproject.MintedInvitation, error) {
	m.h.invoked("CreateInvitation", ctx, p)
	if m.CreateInvitationFunc == nil {
		m.h.t.Errorf("unexpected CreateInvitation call")
		panic(fmt.Sprintf("unexpected %s call", "CreateInvitation"))
	}
	return m.CreateInvitationFunc(ctx, p, id, expected)
}

func (m *membershipMock) ListInvitations(ctx context.Context, p model.Principal, id string) ([]model.ProjectInvitation, error) {
	m.h.invoked("ListInvitations", ctx, p)
	if m.ListInvitationsFunc == nil {
		m.h.t.Errorf("unexpected ListInvitations call")
		panic(fmt.Sprintf("unexpected %s call", "ListInvitations"))
	}
	return m.ListInvitationsFunc(ctx, p, id)
}

func (m *membershipMock) RevokeInvitation(ctx context.Context, p model.Principal, id, inviteID, expected string) error {
	m.h.invoked("RevokeInvitation", ctx, p)
	if m.RevokeInvitationFunc == nil {
		m.h.t.Errorf("unexpected RevokeInvitation call")
		panic(fmt.Sprintf("unexpected %s call", "RevokeInvitation"))
	}
	return m.RevokeInvitationFunc(ctx, p, id, inviteID, expected)
}

func (m *membershipMock) InspectInvitation(ctx context.Context, p model.Principal, secret string) (coreproject.InvitationInspection, error) {
	m.h.invoked("InspectInvitation", ctx, p)
	if m.InspectInvitationFunc == nil {
		m.h.t.Errorf("unexpected InspectInvitation call")
		panic(fmt.Sprintf("unexpected %s call", "InspectInvitation"))
	}
	return m.InspectInvitationFunc(ctx, p, secret)
}

func (m *membershipMock) AcceptInvitation(ctx context.Context, p model.Principal, secret, expected string) (coreproject.InvitationAcceptance, error) {
	m.h.invoked("AcceptInvitation", ctx, p)
	if m.AcceptInvitationFunc == nil {
		m.h.t.Errorf("unexpected AcceptInvitation call")
		panic(fmt.Sprintf("unexpected %s call", "AcceptInvitation"))
	}
	return m.AcceptInvitationFunc(ctx, p, secret, expected)
}
