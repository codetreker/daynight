package github

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type AdminOperations interface {
	ListAdmins(context.Context, model.Principal, string, core.ListAppsInput) (core.AdminPage, error)
	ListAdminInvitations(context.Context, model.Principal, string, core.ListAppsInput) (core.AdminInvitationPage, error)
	CreateAdminInvitation(context.Context, model.Principal, string, string) (core.MintedAdminInvitation, error)
	RevokeAdminInvitation(context.Context, model.Principal, string, string, string) (core.AdminInvitationRevocation, error)
	RemoveAdmin(context.Context, model.Principal, string, string, core.RemoveAdminInput) (core.AdminRemoval, error)
	InspectAdminInvitation(context.Context, model.Principal, string) (core.AdminInvitationInspection, error)
	AcceptAdminInvitation(context.Context, model.Principal, string, string) (core.AdminInvitationAcceptance, error)
}

type adminHandler struct {
	operations AdminOperations
	origin     string
	logger     *slog.Logger
}

// RegisterAdminRoutes installs the adapter only when its invitation reception
// page is available. origin must be the configured trusted public origin.
func RegisterAdminRoutes(mux *http.ServeMux, ops AdminOperations, auth RouteAuthentication, origin string, logger *slog.Logger) {
	registerAdminRoutes(NewRouteRegistry(mux, nil), ops, auth, origin, logger)
}

// RegisterAdminRoutesWithRegistry exposes the same registration facts to an assembler.
func RegisterAdminRoutesWithRegistry(routes *RouteRegistry, ops AdminOperations, auth RouteAuthentication, origin string, logger *slog.Logger) {
	registerAdminRoutes(routes, ops, auth, origin, logger)
}

func registerAdminRoutes(routes *RouteRegistry, ops AdminOperations, auth RouteAuthentication, origin string, logger *slog.Logger) {
	h := &adminHandler{operations: ops, origin: origin, logger: logger}
	for _, route := range []struct {
		pattern, method, allow string
		handler                httpx.AuthenticatedHandler
		class                  routeClass
	}{
		{"/api/v1/github/apps/{id}/admins", "GET", "GET, HEAD", h.listAdmins, routeRead},
		{"/api/v1/github/apps/{id}/admin-invitations", "GET", "GET, HEAD, POST", h.listInvitations, routeRead},
		{"/api/v1/github/apps/{id}/admins/{userId}/remove", "POST", "POST", h.removeAdmin, routeManage},
		{"/api/v1/github/apps/{id}/admin-invitations/{inviteId}/revoke", "POST", "POST", h.revokeInvitation, routeReadManage},
		{"/api/v1/github-app-admin-invitations/inspect", "POST", "POST", h.inspectInvitation, routeRead},
		{"/api/v1/github-app-admin-invitations/accept", "POST", "POST", h.acceptInvitation, routeReadManage},
	} {
		routes.handle(route.method+" "+route.pattern, auth.Require(route.handler), route.class)
		routes.handle(route.pattern, auth.Require(httpx.ResourceMethodNotAllowed(logger, route.allow)), routeFallback)
	}
	routes.handle("POST /api/v1/github/apps/{id}/admin-invitations", auth.Require(h.createInvitation), routeReadManage)
}

func adminMembershipResponse(m githubpr.AdminMembership) api.GitHubAppAdminMembership {
	return api.GitHubAppAdminMembership{AppID: m.AppID, UserID: m.UserID, MembershipVersion: decimal(m.Version), CreatedAt: m.CreatedAt.UTC(), UpdatedAt: m.UpdatedAt.UTC()}
}
func adminInvitationResponse(i githubpr.AppInvitation) api.GitHubAppAdminInvitation {
	return api.GitHubAppAdminInvitation{ID: i.ID, AppID: i.AppID, CreatedBy: i.CreatedBy, IssuerMembershipVersion: decimal(i.IssuerMembershipVersion), CreatedAt: i.CreatedAt.UTC(), ExpiresAt: i.ExpiresAt.UTC(), RevokedAt: utc(i.RevokedAt), ConsumedAt: utc(i.ConsumedAt), ConsumedBy: i.ConsumedBy, Available: i.Available}
}

var errAdminDeadline = errors.New("github app administration deadline exceeded")

func (h *adminHandler) run(w http.ResponseWriter, r *http.Request, p model.Principal, phase string, mutate bool, status int, f func(*http.Request, string) (any, error)) {
	ctx, cancel := context.WithTimeoutCause(r.Context(), core.OperationTimeout, errAdminDeadline)
	defer cancel()
	h.runWithContext(w, r, p, phase, mutate, status, ctx, f)
}
func (h *adminHandler) runWithContext(w http.ResponseWriter, r *http.Request, p model.Principal, phase string, mutate bool, status int, ctx context.Context, f func(*http.Request, string) (any, error)) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	id := r.PathValue("id")
	err := ctx.Err()
	if err == nil && id != "" {
		id, err = model.CanonicalID(id)
		logger = logger.With("app_resource_id", id)
	}
	var result any
	work := r.WithContext(ctx)
	if err == nil {
		result, err = f(work, id)
		r.Body = work.Body
	}
	if err != nil {
		var bodyError *httpx.BodyReadError
		if errors.As(err, &bodyError) && (bodyError.Status == http.StatusRequestEntityTooLarge || bodyError.Status == http.StatusRequestTimeout) {
			httpx.WriteBodyError(w, r, logger, "github", phase, err)
			return
		}
		if bodyError != nil && errors.Is(err, context.DeadlineExceeded) && errors.Is(context.Cause(ctx), errAdminDeadline) {
			httpx.WriteBodyError(w, r, logger, "github", phase, &httpx.BodyReadError{Cause: err, Status: http.StatusRequestTimeout, Code: "request_timeout", Message: "request body read timed out"})
			return
		}
		var management *service.ManagementError
		_, known := httpx.KnownFault(err)
		if r.Context().Err() == nil && !errors.As(err, &management) && !known && errors.Is(err, context.DeadlineExceeded) {
			httpx.LogFailure(logger, r.Context(), "github", phase, err)
			err = &model.Fault{Code: "timeout", Message: "GitHub App operation timed out."}
		}
		if errors.As(err, &management) && management.Code == "github_write_outcome_unknown" {
			logger = logger.With("github_error_code", management.Code, "write_outcome", "unknown")
		}
		(&appHandler{logger: h.logger}).writeError(w, r, logger, phase, err)
		return
	}
	if mutate {
		httpx.WriteMutationJSON(w, r, logger, "github", status, result)
	} else {
		httpx.WriteJSON(w, r, logger, status, result)
	}
}

func adminPageInput(r *http.Request) (core.ListAppsInput, error) {
	input := core.ListAppsInput{Limit: 25}
	values, err := httpx.QueryValues(r, "limit", "cursor")
	if err != nil {
		return input, err
	}
	if value, ok := values["limit"]; ok {
		n, e := strconv.Atoi(value[0])
		if e != nil || n < 1 || n > 100 || strconv.Itoa(n) != value[0] {
			return input, httpx.InvalidInput("limit must be an integer from 1 to 100")
		}
		input.Limit = n
	}
	if value, ok := values["cursor"]; ok {
		input.Cursor = value[0]
	}
	return input, nil
}
func adminFields(w http.ResponseWriter, r *http.Request, names ...string) (map[string]json.RawMessage, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return nil, err
	}
	fields, err := httpx.DecodeObjectLimitWithTimeout(w, r, appWriteBytes, core.OperationTimeout, names...)
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		if raw, ok := fields[name]; ok && !jsonunicode.Valid(raw) {
			return nil, httpx.InvalidInput(name + " must contain valid Unicode")
		}
	}
	if err = r.Context().Err(); err != nil {
		return nil, err
	}
	return fields, nil
}

func (h *adminHandler) listAdmins(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "list_admins", false, http.StatusOK, func(work *http.Request, id string) (any, error) {
		input, err := adminPageInput(work)
		if err != nil {
			return nil, err
		}
		page, err := h.operations.ListAdmins(work.Context(), p, id, input)
		if err != nil {
			return nil, err
		}
		response := api.GitHubAppAdminPage{Items: make([]api.GitHubAppAdmin, 0, len(page.Items)), NextCursor: page.NextCursor}
		for _, member := range page.Items {
			response.Items = append(response.Items, api.GitHubAppAdmin{GitHubAppAdminMembership: adminMembershipResponse(member.AdminMembership), Profile: api.ProjectParticipantProfile{Name: member.Name, Email: member.Email, AvatarURL: member.AvatarURL}})
		}
		return response, nil
	})
}
func (h *adminHandler) removeAdmin(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "remove_admin", true, http.StatusOK, func(work *http.Request, id string) (any, error) {
		userID, err := model.CanonicalID(work.PathValue("userId"))
		if err != nil {
			return nil, err
		}
		fields, err := adminFields(w, work, "membershipVersion", "expectedUserId")
		if err != nil {
			return nil, err
		}
		version, err := decimalField(fields, "membershipVersion")
		if err != nil {
			return nil, err
		}
		expected, err := httpx.RequiredString(fields, "expectedUserId")
		if err != nil {
			return nil, err
		}
		result, err := h.operations.RemoveAdmin(work.Context(), p, id, userID, core.RemoveAdminInput{MembershipVersion: version, ExpectedUserID: expected})
		if err != nil {
			return nil, err
		}
		return api.GitHubAppAdminRemoval{AppID: result.AppID, UserID: result.UserID, Removed: result.Removed, ActorIsAdmin: result.ActorIsAdmin}, nil
	})
}
