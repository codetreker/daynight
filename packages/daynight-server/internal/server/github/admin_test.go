package github

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

const adminBase = appPath + "/" + appID
const adminInviteID = "44444444-4444-4444-8444-444444444444"
const adminToken = "dn_gai_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"
const adminExpected = `{"expectedUserId":"` + userID + `"}`

type adminOps struct {
	call func(context.Context, model.Principal, string, ...any) (any, error)
}

func (s adminOps) ListAdmins(ctx context.Context, p model.Principal, id string, in core.ListAppsInput) (core.AdminPage, error) {
	v, e := s.call(ctx, p, "admins", id, in)
	if e != nil {
		return core.AdminPage{}, e
	}
	return v.(core.AdminPage), nil
}
func (s adminOps) ListAdminInvitations(ctx context.Context, p model.Principal, id string, in core.ListAppsInput) (core.AdminInvitationPage, error) {
	v, e := s.call(ctx, p, "invitations", id, in)
	if e != nil {
		return core.AdminInvitationPage{}, e
	}
	return v.(core.AdminInvitationPage), nil
}
func (s adminOps) CreateAdminInvitation(ctx context.Context, p model.Principal, id, expected string) (core.MintedAdminInvitation, error) {
	v, e := s.call(ctx, p, "create", id, expected)
	if e != nil {
		return core.MintedAdminInvitation{}, e
	}
	return v.(core.MintedAdminInvitation), nil
}
func (s adminOps) RevokeAdminInvitation(ctx context.Context, p model.Principal, id, invite, expected string) (core.AdminInvitationRevocation, error) {
	v, e := s.call(ctx, p, "revoke", id, invite, expected)
	if e != nil {
		return core.AdminInvitationRevocation{}, e
	}
	return v.(core.AdminInvitationRevocation), nil
}
func (s adminOps) RemoveAdmin(ctx context.Context, p model.Principal, id, user string, in core.RemoveAdminInput) (core.AdminRemoval, error) {
	v, e := s.call(ctx, p, "remove", id, user, in)
	if e != nil {
		return core.AdminRemoval{}, e
	}
	return v.(core.AdminRemoval), nil
}
func (s adminOps) InspectAdminInvitation(ctx context.Context, p model.Principal, token string) (core.AdminInvitationInspection, error) {
	v, e := s.call(ctx, p, "inspect", token)
	if e != nil {
		return core.AdminInvitationInspection{}, e
	}
	return v.(core.AdminInvitationInspection), nil
}
func (s adminOps) AcceptAdminInvitation(ctx context.Context, p model.Principal, token, expected string) (core.AdminInvitationAcceptance, error) {
	v, e := s.call(ctx, p, "accept", token, expected)
	if e != nil {
		return core.AdminInvitationAcceptance{}, e
	}
	return v.(core.AdminInvitationAcceptance), nil
}
func adminMux(t *testing.T, ops AdminOperations, log io.Writer) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(log, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
		if value != "valid" {
			return model.Principal{}, authhttp.Failure()
		}
		return model.Principal{Kind: kind, UserID: userID, CredentialID: projectID}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterAdminRoutes(mux, ops, auth, "https://daynight.example", logger)
	return httpx.RequestLogging(logger, mux)
}
func adminMember() githubpr.AdminMembership {
	stamp := time.Date(2026, 11, 1, 1, 0, 0, 0, time.FixedZone("offset", 3600))
	return githubpr.AdminMembership{AppID: appID, UserID: userID, Version: math.MaxInt64, CreatedAt: stamp, UpdatedAt: stamp}
}
func adminInvitation() githubpr.AppInvitation {
	m := adminMember()
	return githubpr.AppInvitation{ID: adminInviteID, AppID: appID, CreatedBy: userID, IssuerMembershipVersion: m.Version, CreatedAt: m.CreatedAt, ExpiresAt: m.CreatedAt.Add(7 * 24 * time.Hour), Available: true}
}

type adminRequestCase struct {
	name, method, path, body string
	status                   int
}

func adminRequests() []adminRequestCase {
	return []adminRequestCase{
		{"admins", "GET", adminBase + "/admins?limit=100&cursor=opaque", "", 200},
		{"invitations", "GET", adminBase + "/admin-invitations", "", 200},
		{"create", "POST", adminBase + "/admin-invitations", adminExpected, 201},
		{"revoke", "POST", adminBase + "/admin-invitations/" + adminInviteID + "/revoke", adminExpected, 200},
		{"remove", "POST", adminBase + "/admins/" + userID + "/remove", `{"membershipVersion":"9223372036854775807","expectedUserId":"` + userID + `"}`, 200},
		{"inspect", "POST", "/api/v1/github-app-admin-invitations/inspect", `{"token":"` + adminToken + `"}`, 200},
		{"accept", "POST", "/api/v1/github-app-admin-invitations/accept", `{"token":"` + adminToken + `","expectedUserId":"` + userID + `"}`, 200},
	}
}
func TestAdminProtocols(t *testing.T) {
	for _, tc := range adminRequests() {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			calls := 0
			next := "next"
			ops := adminOps{call: func(ctx context.Context, p model.Principal, op string, args ...any) (any, error) {
				calls++
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > core.OperationTimeout || p.UserID != userID || p.Kind != model.PATCredential || op != tc.name {
					t.Fatalf("ctx/principal/op: %v %+v %s", deadline, p, op)
				}
				if op != "inspect" && op != "accept" && args[0] != appID {
					t.Fatalf("app=%v", args)
				}
				m := adminMember()
				switch op {
				case "admins":
					if args[1] != (core.ListAppsInput{Limit: 100, Cursor: "opaque"}) {
						t.Fatalf("page=%+v", args)
					}
					name := "Name"
					return core.AdminPage{Items: []githubpr.AdminProfile{{AdminMembership: m, Name: &name}}, NextCursor: &next}, nil
				case "invitations":
					if args[1] != (core.ListAppsInput{Limit: 25}) {
						t.Fatalf("page=%+v", args)
					}
					return core.AdminInvitationPage{Items: []githubpr.AppInvitation{adminInvitation()}, NextCursor: &next}, nil
				case "create":
					if args[1] != userID {
						t.Fatalf("create=%v", args)
					}
					return core.MintedAdminInvitation{Invitation: adminInvitation(), Secret: adminToken}, nil
				case "revoke":
					if args[1] != adminInviteID || args[2] != userID {
						t.Fatalf("revoke=%v", args)
					}
					return core.AdminInvitationRevocation{AppID: appID, InvitationID: adminInviteID, Changed: false}, nil
				case "remove":
					if args[1] != userID || args[2] != (core.RemoveAdminInput{ExpectedUserID: userID, MembershipVersion: math.MaxInt64}) {
						t.Fatalf("remove=%+v", args)
					}
					return core.AdminRemoval{AppID: appID, UserID: userID, Removed: true, ActorIsAdmin: false}, nil
				case "inspect":
					if args[0] != adminToken {
						t.Fatalf("token=%v", args)
					}
					return core.AdminInvitationInspection{App: githubpr.AppIdentity{ID: appID, GitHubAppID: 9007199254740993, Name: "Name", GitHubName: "Remote", GitHubSlug: "remote"}, ExpiresAt: m.CreatedAt, Membership: &m}, nil
				case "accept":
					if args[0] != adminToken || args[1] != userID {
						t.Fatalf("accept=%v", args)
					}
					return core.AdminInvitationAcceptance{AppID: appID, Membership: m, Joined: false}, nil
				}
				t.Fatalf("unexpected %s", op)
				return nil, nil
			}}
			h := adminMux(t, ops, &logs)
			w := httptest.NewRecorder()
			r := appRequest(tc.method, tc.path, tc.body)
			r.Host = "attacker.example"
			h.ServeHTTP(w, r)
			body := w.Body.String()
			if w.Code != tc.status || calls != 1 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Daynight-User-ID") != userID {
				t.Fatalf("calls=%d status=%d headers=%v body=%s", calls, w.Code, w.Header(), body)
			}
			if tc.name == "create" {
				if !strings.Contains(body, `"link":"https://daynight.example/github-app-admin-invitations#`+adminToken+`"`) {
					t.Fatal(body)
				}
			} else if strings.Contains(body, adminToken) {
				t.Fatal("token returned")
			}
			if strings.Contains(logs.String(), adminToken) || strings.Contains(body, "tokenHash") || strings.Contains(body, "privateKey") {
				t.Fatal("secret exposed")
			}
			if tc.name == "remove" && (!strings.Contains(body, `"actorIsAdmin":false`) || strings.Contains(body, "membership")) {
				t.Fatal(body)
			}
			if tc.name == "inspect" && (strings.Contains(body, "administrators") || strings.Contains(body, "authorizedTeams") || strings.Contains(body, "profile")) {
				t.Fatal(body)
			}
			if tc.name == "admins" && !strings.Contains(body, `"membershipVersion":"9223372036854775807"`) {
				t.Fatal(body)
			}
		})
	}
}

func TestAdminErrors(t *testing.T) {
	for _, tc := range adminRequests() {
		t.Run(tc.name, func(t *testing.T) {
			for _, fault := range []struct {
				err    error
				status int
				code   string
			}{
				{&model.Fault{Code: "last_admin", Message: "last"}, 409, "last_admin"},
				{&model.Fault{Code: "invitation_unavailable", Message: "unavailable"}, 404, "invitation_unavailable"},
				{&model.Fault{Code: "not_found", Message: "hidden"}, 404, "not_found"},
				{&model.Fault{Code: "version_conflict", Message: "stale"}, 409, "version_conflict"},
				{&service.ManagementError{Code: "github_write_outcome_unknown", Message: "unknown"}, 503, "github_write_outcome_unknown"},
				{errors.New("database failure"), 500, "internal_error"},
				{context.DeadlineExceeded, 504, "timeout"},
			} {
				calls := 0
				var logs bytes.Buffer
				h := adminMux(t, adminOps{call: func(context.Context, model.Principal, string, ...any) (any, error) { calls++; return nil, fault.err }}, &logs)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, appRequest(tc.method, tc.path, tc.body))
				if calls != 1 || w.Code != fault.status || !strings.Contains(w.Body.String(), `"code":"`+fault.code+`"`) {
					t.Fatalf("%s calls=%d status=%d body=%s", fault.code, calls, w.Code, w.Body)
				}
				if fault.code == "github_write_outcome_unknown" && !strings.Contains(w.Body.String(), `"writeOutcome":"unknown"`) {
					t.Fatal(w.Body)
				}
				if !strings.Contains(logs.String(), fault.code) && fault.code != "internal_error" {
					t.Fatal(logs.String())
				}
			}
		})
	}
}
