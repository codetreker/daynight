package github

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

type ProjectAppOperations interface {
	Get(context.Context, model.Principal, string) (core.ProjectAppStatus, error)
	Discover(context.Context, model.Principal, string, core.ProjectAppSelection) (core.InstallationCandidate, error)
	Connect(context.Context, model.Principal, string, core.ProjectAppConnect) (core.ProjectAppStatus, error)
	Disconnect(context.Context, model.Principal, string, core.ProjectAppDisconnect) (core.ProjectAppStatus, error)
	Settings(context.Context, model.Principal, string, int64, int32) (core.ProjectAppStatus, error)
	Sync(context.Context, model.Principal, string, int64, bool) (core.ProjectAppStatus, error)
}

type projectAppHandler struct {
	operations ProjectAppOperations
	logger     *slog.Logger
}

// RegisterProjectAppRoutes installs the App-aware project connection adapter.
func RegisterProjectAppRoutes(mux httpx.RouteRegistrar, ops ProjectAppOperations, auth RouteAuthentication, logger *slog.Logger) {
	registerProjectAppRoutes(NewRouteRegistry(mux, nil), ops, auth, logger)
}

// RegisterProjectAppRoutesWithRegistry exposes the same registration facts to an assembler.
func RegisterProjectAppRoutesWithRegistry(routes *RouteRegistry, ops ProjectAppOperations, auth RouteAuthentication, logger *slog.Logger) {
	registerProjectAppRoutes(routes, ops, auth, logger)
}

func registerProjectAppRoutes(routes *RouteRegistry, ops ProjectAppOperations, auth RouteAuthentication, logger *slog.Logger) {
	h := &projectAppHandler{operations: ops, logger: logger}
	base := "/api/v1/projects/{projectId}/github"
	routes.handle("GET "+base, auth.Require(h.status), routeRead)
	routes.handle("GET "+base+"/installation", auth.Require(h.discover), routeRead)
	routes.handle("POST "+base+"/connect", auth.Require(h.connect), routeReadManage)
	routes.handle("POST "+base+"/disconnect", auth.Require(h.disconnect), routeReadManage)
	routes.handle("PATCH "+base+"/settings", auth.Require(h.settings), routeReadManage)
	routes.handle("PATCH "+base+"/sync", auth.Require(h.sync), routeReadManage)
	for _, route := range []struct{ path, allow string }{{"", "GET, HEAD"}, {"/installation", "GET, HEAD"}, {"/connect", "POST"}, {"/disconnect", "POST"}, {"/settings", "PATCH"}, {"/sync", "PATCH"}} {
		routes.handle(base+route.path, auth.Require(httpx.ResourceMethodNotAllowed(logger, route.allow)), routeFallback)
	}
}

type projectAppLog struct{ logger *slog.Logger }

func (l *projectAppLog) selection(in core.ProjectAppSelection) {
	l.logger = l.logger.With("requested_app_resource_id", in.AppResourceID, "requested_grant_id", in.GrantID,
		"expected_app_version", in.AppVersion, "expected_ownership_version", in.OwnershipVersion)
}

func (l *projectAppLog) status(value core.ProjectAppStatus) {
	l.logger = l.logger.With("version", value.Connection.Version, "generation", value.Connection.Generation)
	if value.App != nil {
		l.logger = l.logger.With("app_resource_id", value.App.ID, "app_id", value.App.GitHubAppID)
	}
	if value.GrantID != nil {
		l.logger = l.logger.With("grant_id", *value.GrantID)
	}
}

func (h *projectAppHandler) run(w http.ResponseWriter, r *http.Request, p model.Principal, phase string, mutate bool, budget time.Duration, op func(*http.Request, string, *projectAppLog) (any, error)) {
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeoutCause(r.Context(), budget, errAppWriteDeadline)
	defer cancel()
	work := r.WithContext(ctx)
	id, err := pathID(work, "projectId")
	log := &projectAppLog{logger: h.logger.With("user_id", p.UserID, "operation_phase", phase)}
	var result any
	if err == nil {
		log.logger = log.logger.With("project_id", id)
		result, err = op(work, id, log)
	}
	r.Body = work.Body
	if err != nil {
		if _, ok := err.(*httpx.BodyReadError); ok {
			if errors.Is(err, context.DeadlineExceeded) && errors.Is(context.Cause(ctx), errAppWriteDeadline) {
				err = &httpx.BodyReadError{Cause: err, Status: http.StatusRequestTimeout, Code: "request_timeout", Message: "request body read timed out"}
			}
			httpx.WriteBodyError(w, r, log.logger, "github", phase, err)
			return
		}
		var management *service.ManagementError
		var code, message string
		if errors.As(err, &management) && management.Code != "github_unavailable" && management.Code != "github_rate_limited" && management.Code != "github_write_outcome_unknown" {
			code, message = management.Code, management.Message
		} else if fault, ok := httpx.KnownFault(err); ok && httpx.ErrorKind(err) == fault.Code && (fault.Code == "github_not_connected" || fault.Code == "github_connection_unavailable") {
			code, message = fault.Code, fault.Message
		}
		if code != "" {
			httpx.CloseUnreadBody(w, r)
			httpx.LogFailure(log.logger, r.Context(), "github", phase, err)
			if r.Context().Err() == nil {
				httpx.WriteJSON(w, r, log.logger, http.StatusConflict, api.ErrorResponse{Error: api.Error{Code: code, Message: message, RequestID: httpx.RequestID(r.Context())}})
			}
			return
		}
		(&grantHandler{logger: log.logger}).fail(w, r, phase, err)
		return
	}
	if mutate {
		httpx.WriteMutationJSON(w, r, log.logger, "github", http.StatusOK, result)
	} else {
		httpx.WriteJSON(w, r, log.logger, http.StatusOK, result)
	}
}

func projectAppResponse(s core.ProjectAppStatus, mutate bool) (api.GitHubProjectAppStatus, error) {
	base, err := statusResponse(s.Status)
	if err != nil && mutate {
		err = &service.ManagementError{Code: "github_write_outcome_unknown", Message: "GitHub configuration write outcome is unknown; read the resource before deciding what to do.", Cause: err}
	}
	if err != nil {
		return api.GitHubProjectAppStatus{}, err
	}
	out := api.GitHubProjectAppStatus{GitHubStatus: base, CanManageConnection: s.CanManageConnection, GrantID: s.GrantID}
	if s.App != nil {
		out.App = &api.GitHubProjectAppRef{ID: s.App.ID, GitHubAppID: decimal(s.App.GitHubAppID), Name: s.App.Name, GitHubSlug: s.App.GitHubSlug}
	}
	return out, nil
}

func (h *projectAppHandler) status(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "status", false, core.OperationTimeout, func(work *http.Request, id string, log *projectAppLog) (any, error) {
		if _, err := query(work); err != nil {
			return nil, err
		}
		value, err := h.operations.Get(work.Context(), p, id)
		if err != nil {
			return nil, err
		}
		log.status(value)
		return projectAppResponse(value, false)
	})
}

func projectAppSelection(fields map[string]json.RawMessage) (core.ProjectAppSelection, error) {
	var in core.ProjectAppSelection
	for _, field := range []struct {
		name   string
		target *string
	}{{"appResourceId", &in.AppResourceID}, {"grantId", &in.GrantID}} {
		value, err := httpx.RequiredString(fields, field.name)
		if err != nil {
			return in, err
		}
		*field.target, err = model.CanonicalID(value)
		if err != nil {
			return in, err
		}
	}
	var err error
	if in.AppVersion, err = decimalField(fields, "appVersion"); err != nil {
		return in, err
	}
	in.OwnershipVersion, err = decimalField(fields, "ownershipVersion")
	return in, err
}

func (h *projectAppHandler) discover(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "discover", false, appWriteBudget, func(work *http.Request, id string, log *projectAppLog) (any, error) {
		values, err := query(work, "appResourceId", "appVersion", "grantId", "ownershipVersion")
		if err != nil {
			return nil, err
		}
		fields := make(map[string]json.RawMessage, len(values))
		for key, value := range values {
			fields[key], err = json.Marshal(value[0])
			if err != nil {
				return nil, err
			}
		}
		in, err := projectAppSelection(fields)
		if err != nil {
			return nil, err
		}
		log.selection(in)
		value, err := h.operations.Discover(work.Context(), p, id, in)
		if err != nil {
			return nil, err
		}
		private := value.Repository.Private
		return api.GitHubInstallationCandidate{Installation: api.GitHubInstallation{ID: decimal(value.Installation.ID), AccountLogin: value.Installation.AccountLogin}, Repository: api.GitHubRepository{ID: decimal(value.Repository.ID), FullName: value.Repository.FullName, Private: &private}}, nil
	})
}

func projectAppFields(w http.ResponseWriter, r *http.Request, names ...string) (map[string]json.RawMessage, error) {
	if _, err := query(r); err != nil {
		return nil, err
	}
	return httpx.DecodeObjectLimitWithTimeout(w, r, appWriteBytes, core.OperationTimeout, names...)
}

func (h *projectAppHandler) connect(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "connect", true, appWriteBudget, func(work *http.Request, id string, log *projectAppLog) (any, error) {
		fields, err := projectAppFields(w, work, "version", "ownershipVersion", "appResourceId", "appVersion", "grantId", "installationId")
		if err != nil {
			return nil, err
		}
		selection, err := projectAppSelection(fields)
		if err != nil {
			return nil, err
		}
		in := core.ProjectAppConnect{ProjectAppSelection: selection}
		if in.Version, err = decimalField(fields, "version"); err != nil {
			return nil, err
		}
		if in.InstallationID, err = decimalField(fields, "installationId"); err != nil {
			return nil, err
		}
		log.selection(selection)
		log.logger = log.logger.With("expected_version", in.Version)
		value, err := h.operations.Connect(work.Context(), p, id, in)
		if err != nil {
			return nil, err
		}
		log.status(value)
		return projectAppResponse(value, true)
	})
}

func (h *projectAppHandler) disconnect(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "disconnect", true, core.OperationTimeout, func(work *http.Request, id string, log *projectAppLog) (any, error) {
		fields, err := projectAppFields(w, work, "version", "ownershipVersion")
		if err != nil {
			return nil, err
		}
		var in core.ProjectAppDisconnect
		if in.Version, err = decimalField(fields, "version"); err != nil {
			return nil, err
		}
		if in.OwnershipVersion, err = decimalField(fields, "ownershipVersion"); err != nil {
			return nil, err
		}
		log.logger = log.logger.With("expected_version", in.Version, "expected_ownership_version", in.OwnershipVersion)
		value, err := h.operations.Disconnect(work.Context(), p, id, in)
		if err != nil {
			return nil, err
		}
		log.status(value)
		return projectAppResponse(value, true)
	})
}

func (h *projectAppHandler) settings(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "settings", true, core.OperationTimeout, func(work *http.Request, id string, log *projectAppLog) (any, error) {
		fields, err := projectAppFields(w, work, "version", "pollIntervalMinutes")
		if err != nil {
			return nil, err
		}
		version, err := decimalField(fields, "version")
		if err != nil {
			return nil, err
		}
		var minutes int32
		if err := json.Unmarshal(fields["pollIntervalMinutes"], &minutes); err != nil || minutes < 1 {
			return nil, httpx.InvalidInput("pollIntervalMinutes must be a positive 32-bit integer")
		}
		log.logger = log.logger.With("expected_version", version)
		value, err := h.operations.Settings(work.Context(), p, id, version, minutes)
		if err != nil {
			return nil, err
		}
		log.status(value)
		return projectAppResponse(value, true)
	})
}

func (h *projectAppHandler) sync(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "sync_config", true, core.OperationTimeout, func(work *http.Request, id string, log *projectAppLog) (any, error) {
		fields, err := projectAppFields(w, work, "version", "syncEnabled")
		if err != nil {
			return nil, err
		}
		version, err := decimalField(fields, "version")
		if err != nil {
			return nil, err
		}
		var enabled *bool
		if err := json.Unmarshal(fields["syncEnabled"], &enabled); err != nil || enabled == nil {
			return nil, httpx.InvalidInput("syncEnabled must be a boolean")
		}
		log.logger = log.logger.With("expected_version", version)
		value, err := h.operations.Sync(work.Context(), p, id, version, *enabled)
		if err != nil {
			return nil, err
		}
		log.status(value)
		return projectAppResponse(value, true)
	})
}
