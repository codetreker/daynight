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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
)

type GrantOperations interface {
	PreviewGrant(context.Context, model.Principal, string, string) (store.GitHubGrantPreview, error)
	GetGrant(context.Context, model.Principal, string, string) (store.GitHubTeamGrant, error)
	ListGrants(context.Context, model.Principal, string, int, string) (core.GrantPage, error)
	ListTeamApps(context.Context, model.Principal, string, int, string) (core.TeamAppPage, error)
	CreateGrant(context.Context, model.Principal, string, core.CreateGrantInput) (store.GitHubTeamGrant, error)
	RevokeGrant(context.Context, model.Principal, string, string, core.RevokeGrantInput) error
	Impact(context.Context, model.Principal, core.AppImpactInput) (core.AppImpactPage, error)
	ImpactProjects(context.Context, model.Principal, core.AppImpactInput) (core.AppImpactProjectsPage, error)
}

type grantHandler struct {
	operations GrantOperations
	logger     *slog.Logger
}

// RegisterGrantRoutes installs the independent grant adapter. The caller supplies
// authentication for each route.
func RegisterGrantRoutes(mux *http.ServeMux, ops GrantOperations, auth RouteAuthentication, logger *slog.Logger) {
	h := &grantHandler{operations: ops, logger: logger}
	base := "/api/v1/github/apps/{id}"
	mux.HandleFunc("POST "+base+"/team-grant-preview", auth.Require(h.preview))
	mux.HandleFunc("GET "+base+"/team-grants", auth.Require(h.list))
	mux.HandleFunc("POST "+base+"/team-grants", auth.Require(h.create))
	mux.HandleFunc("GET "+base+"/team-grants/{grantId}", auth.Require(h.get))
	mux.HandleFunc("POST "+base+"/team-grants/{grantId}/revoke", auth.Require(h.revoke))
	mux.HandleFunc("GET "+base+"/removal-preview", auth.Require(h.impact(false, false)))
	mux.HandleFunc("GET "+base+"/removal-preview/projects", auth.Require(h.impact(false, true)))
	mux.HandleFunc("GET "+base+"/team-grants/{grantId}/revocation-preview", auth.Require(h.impact(true, false)))
	mux.HandleFunc("GET "+base+"/team-grants/{grantId}/revocation-preview/projects", auth.Require(h.impact(true, true)))
	mux.HandleFunc("GET /api/v1/teams/{teamId}/github/apps", auth.Require(h.teamApps))
	mux.HandleFunc(base+"/team-grant-preview", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc(base+"/team-grants", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc(base+"/team-grants/{grantId}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc(base+"/team-grants/{grantId}/revoke", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc(base+"/removal-preview", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc(base+"/removal-preview/projects", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc(base+"/team-grants/{grantId}/revocation-preview", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc(base+"/team-grants/{grantId}/revocation-preview/projects", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("/api/v1/teams/{teamId}/github/apps", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
}

func grantTeam(t store.GitHubGrantTeam) api.GitHubGrantTeam {
	out := api.GitHubGrantTeam{ID: t.ID, Kind: t.Kind, Name: t.Name, Version: decimal(t.Version)}
	if t.PersonalOwner != nil {
		out.PersonalOwner = &api.GitHubGrantPersonalOwner{UserID: t.PersonalOwner.UserID, Name: t.PersonalOwner.Name}
	}
	return out
}
func grantResponse(g store.GitHubTeamGrant) api.GitHubTeamGrant {
	return api.GitHubTeamGrant{ID: g.ID, AppID: g.AppID, Team: grantTeam(g.Team), CreatedAt: g.CreatedAt.UTC()}
}
func pathID(r *http.Request, key string) (string, error) { return model.CanonicalID(r.PathValue(key)) }
func grantPageInput(r *http.Request) (int, string, error) {
	q, err := httpx.QueryValues(r, "limit", "cursor")
	if err != nil {
		return 0, "", err
	}
	limit := 25
	if v, ok := q["limit"]; ok {
		n, e := strconv.Atoi(v[0])
		if e != nil || n < 1 || n > 100 || strconv.Itoa(n) != v[0] {
			return 0, "", httpx.InvalidInput("limit must be an integer from 1 to 100")
		}
		limit = n
	}
	cursor := ""
	if v, ok := q["cursor"]; ok {
		cursor = v[0]
	}
	return limit, cursor, nil
}
func (h *grantHandler) fail(w http.ResponseWriter, r *http.Request, phase string, err error) {
	logger := h.logger.With("phase", phase)
	var management *service.ManagementError
	failed, _ := store.DatabaseErrorFacts(err)
	facts := operation.CompletionFacts(err)
	_, known := httpx.KnownFault(err)
	if r.Context().Err() == nil && !errors.As(err, &management) && !known && !failed && !facts.CleanupFailed && (facts.Phase == "" || facts.Phase == "operation") && (facts.Outcome == "" || facts.Outcome == store.TransactionNotCommitted) && errors.Is(err, context.DeadlineExceeded) {
		err = &model.Fault{Code: "timeout", Message: "GitHub App operation timed out."}
	}
	if f, ok := httpx.KnownFault(err); ok && httpx.ErrorKind(err) == f.Code && (f.Code == "github_grant_changed" || f.Code == "impact_changed" || f.Code == "github_admin_changed") {
		httpx.CloseUnreadBody(w, r)
		httpx.LogFailure(logger, r.Context(), "github", phase, err)
		if r.Context().Err() == nil {
			httpx.WriteJSON(w, r, logger, http.StatusConflict, api.ErrorResponse{Error: api.Error{Code: f.Code, Message: f.Message, RequestID: httpx.RequestID(r.Context())}})
		}
		return
	}
	(&appHandler{logger: h.logger}).writeError(w, r, logger, phase, err)
}

// bodyOperation starts the local operation budget before reading the request.
// The original context remains responsible for delivering timeout and unknown results.
func (h *grantHandler) bodyOperation(w http.ResponseWriter, r *http.Request, p model.Principal, phase string, mutate bool, op func(context.Context, *http.Request) (any, int, string, error)) {
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeoutCause(r.Context(), core.OperationTimeout, errAppWriteDeadline)
	defer cancel()
	work := r.WithContext(ctx)
	value, status, location, err := op(ctx, work)
	r.Body = work.Body
	if err != nil {
		var body *httpx.BodyReadError
		if errors.As(err, &body) && (body.Status == http.StatusRequestEntityTooLarge || body.Status == http.StatusRequestTimeout) {
			httpx.WriteError(w, r, h.logger, "github", phase, err)
			return
		}
		if body != nil && errors.Is(err, context.DeadlineExceeded) && errors.Is(context.Cause(ctx), errAppWriteDeadline) {
			httpx.WriteError(w, r, h.logger, "github", phase, &httpx.BodyReadError{Cause: err, Status: http.StatusRequestTimeout, Code: "request_timeout", Message: "request body read timed out"})
			return
		}
		h.fail(w, r, phase, err)
		return
	}
	if mutate {
		if location != "" {
			response := appCreatedWriter{ResponseWriter: w, ctx: r.Context(), location: location}
			httpx.WriteMutationJSON(&response, r, h.logger, "github", status, value)
		} else {
			httpx.WriteMutationJSON(w, r, h.logger, "github", status, value)
		}
	} else {
		httpx.WriteJSON(w, r, h.logger, status, value)
	}
}

func (h *grantHandler) preview(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.bodyOperation(w, r, p, "grant_preview", false, func(ctx context.Context, work *http.Request) (any, int, string, error) {
		id, err := pathID(work, "id")
		if err == nil {
			_, err = httpx.QueryValues(work)
		}
		var teamID string
		if err == nil {
			var fields map[string]json.RawMessage
			fields, err = httpx.DecodeObjectLimitWithTimeout(w, work, appWriteBytes, core.OperationTimeout, "teamId")
			if err == nil {
				teamID, err = httpx.RequiredString(fields, "teamId")
			}
			if err == nil {
				teamID, err = model.CanonicalID(teamID)
			}
		}
		if err == nil {
			err = ctx.Err()
		}
		if err != nil {
			return nil, 0, "", err
		}
		result, err := h.operations.PreviewGrant(ctx, p, id, teamID)
		if err != nil {
			return nil, 0, "", err
		}
		out := api.GitHubGrantPreview{AppID: result.AppID, Version: decimal(result.Version), TargetTeam: grantTeam(result.TargetTeam)}
		if result.Grant != nil {
			g := grantResponse(*result.Grant)
			out.Grant = &g
		}
		return out, http.StatusOK, "", nil
	})
}
func (h *grantHandler) list(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	id, err := pathID(r, "id")
	limit, cursor, e := grantPageInput(r)
	if err == nil {
		err = e
	}
	if err != nil {
		h.fail(w, r, "grants", err)
		return
	}
	page, err := h.operations.ListGrants(r.Context(), p, id, limit, cursor)
	if err != nil {
		h.fail(w, r, "grants", err)
		return
	}
	out := api.GitHubTeamGrantPage{Items: make([]api.GitHubTeamGrant, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, v := range page.Items {
		out.Items = append(out.Items, grantResponse(v))
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, out)
}
func (h *grantHandler) get(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	id, err := pathID(r, "id")
	grant, e := pathID(r, "grantId")
	if err == nil {
		err = e
	}
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	if err != nil {
		h.fail(w, r, "grant", err)
		return
	}
	result, err := h.operations.GetGrant(r.Context(), p, id, grant)
	if err != nil {
		h.fail(w, r, "grant", err)
		return
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, grantResponse(result))
}
func (h *grantHandler) teamApps(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	id, err := pathID(r, "teamId")
	limit, cursor, e := grantPageInput(r)
	if err == nil {
		err = e
	}
	if err != nil {
		h.fail(w, r, "team_apps", err)
		return
	}
	page, err := h.operations.ListTeamApps(r.Context(), p, id, limit, cursor)
	if err != nil {
		h.fail(w, r, "team_apps", err)
		return
	}
	out := api.GitHubTeamAppPage{Items: make([]api.GitHubTeamApp, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, v := range page.Items {
		out.Items = append(out.Items, api.GitHubTeamApp{GrantID: v.GrantID, App: api.GitHubTeamAppIdentity{ID: v.ID, GitHubAppID: decimal(v.GitHubAppID), Name: v.Name, GitHubSlug: v.GitHubSlug, Version: decimal(v.Version)}, CreatedAt: v.CreatedAt.UTC()})
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, out)
}
func (h *grantHandler) impact(grant, projects bool) func(http.ResponseWriter, *http.Request, model.Principal) {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		w.Header().Set("Cache-Control", "no-store")
		id, err := pathID(r, "id")
		var g *string
		if grant {
			v, e := pathID(r, "grantId")
			if err == nil {
				err = e
			}
			g = &v
		}
		limit, cursor, e := grantPageInput(r)
		if err == nil {
			err = e
		}
		if err != nil {
			h.fail(w, r, "impact", err)
			return
		}
		in := core.AppImpactInput{AppID: id, GrantID: g, Limit: limit, Cursor: cursor}
		if projects {
			page, e := h.operations.ImpactProjects(r.Context(), p, in)
			if e != nil {
				h.fail(w, r, "impact_projects", e)
				return
			}
			out := api.GitHubImpactProjectPage{Items: make([]api.GitHubImpactProject, 0, len(page.Items)), HiddenProjects: decimal(page.HiddenProjects), NextCursor: page.NextCursor}
			for _, v := range page.Items {
				out.Items = append(out.Items, api.GitHubImpactProject{ID: v.ID, Name: v.Name, RepoURL: v.RepoURL})
			}
			httpx.WriteJSON(w, r, h.logger, http.StatusOK, out)
			return
		}
		page, e := h.operations.Impact(r.Context(), p, in)
		if e != nil {
			h.fail(w, r, "impact", e)
			return
		}
		out := api.GitHubAppImpact{AppID: page.AppID, GrantID: page.GrantID, Version: decimal(page.Version), ImpactVersion: decimal(page.ImpactVersion), TotalProjects: decimal(page.TotalProjects), VisibleProjects: decimal(page.VisibleProjects), HiddenProjects: decimal(page.HiddenProjects), Teams: make([]api.GitHubImpactTeam, 0, len(page.Teams)), NextCursor: page.NextCursor}
		for _, v := range page.Teams {
			out.Teams = append(out.Teams, api.GitHubImpactTeam{Team: api.GitHubImpactTeamRef{ID: v.Team.ID, Kind: v.Team.Kind, Name: v.Team.Name}, Projects: decimal(v.Projects)})
		}
		httpx.WriteJSON(w, r, h.logger, http.StatusOK, out)
	}
}

func (h *grantHandler) create(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.bodyOperation(w, r, p, "grant_create", true, func(ctx context.Context, work *http.Request) (any, int, string, error) {
		id, err := pathID(work, "id")
		if err == nil {
			_, err = httpx.QueryValues(work)
		}
		var in core.CreateGrantInput
		if err == nil {
			var fields map[string]json.RawMessage
			fields, err = httpx.DecodeObjectLimitWithTimeout(w, work, appWriteBytes, core.OperationTimeout, "id", "version", "teamId", "teamVersion", "expectedUserId")
			if err == nil {
				in.ID, err = httpx.RequiredString(fields, "id")
			}
			if err == nil {
				in.ID, err = model.CanonicalID(in.ID)
			}
			if err == nil {
				in.TeamID, err = httpx.RequiredString(fields, "teamId")
			}
			if err == nil {
				in.TeamID, err = model.CanonicalID(in.TeamID)
			}
			if err == nil {
				in.Version, err = decimalField(fields, "version")
			}
			if err == nil {
				in.TeamVersion, err = decimalField(fields, "teamVersion")
			}
			if err == nil {
				in.ExpectedUserID, err = httpx.RequiredString(fields, "expectedUserId")
			}
		}
		if err == nil {
			err = ctx.Err()
		}
		if err != nil {
			return nil, 0, "", err
		}
		result, err := h.operations.CreateGrant(ctx, p, id, in)
		if err != nil {
			return nil, 0, "", err
		}
		return grantResponse(result), http.StatusCreated, "/api/v1/github/apps/" + id + "/team-grants/" + result.ID, nil
	})
}
func (h *grantHandler) revoke(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.bodyOperation(w, r, p, "grant_revoke", true, func(ctx context.Context, work *http.Request) (any, int, string, error) {
		id, err := pathID(work, "id")
		grant, e := pathID(work, "grantId")
		if err == nil {
			err = e
		}
		if err == nil {
			_, err = httpx.QueryValues(work)
		}
		var in core.RevokeGrantInput
		if err == nil {
			var fields map[string]json.RawMessage
			fields, err = httpx.DecodeObjectLimitWithTimeout(w, work, appWriteBytes, core.OperationTimeout, "version", "impactVersion", "expectedUserId")
			if err == nil {
				in.Version, err = decimalField(fields, "version")
			}
			if err == nil {
				in.ImpactVersion, err = decimalField(fields, "impactVersion")
			}
			if err == nil {
				in.ExpectedUserID, err = httpx.RequiredString(fields, "expectedUserId")
			}
		}
		if err == nil {
			err = ctx.Err()
		}
		if err != nil {
			return nil, 0, "", err
		}
		if err = h.operations.RevokeGrant(ctx, p, id, grant, in); err != nil {
			return nil, 0, "", err
		}
		return api.GitHubGrantRevoked{AppID: id, GrantID: grant, Revoked: true}, http.StatusOK, "", nil
	})
}
