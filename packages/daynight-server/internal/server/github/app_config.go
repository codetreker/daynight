package github

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type AppConfigOperations interface {
	UpdateApp(context.Context, model.Principal, string, core.UpdateAppInput) (core.AppMetadata, error)
	RemoveApp(context.Context, model.Principal, string, core.RemoveAppInput) error
}

type appConfigHandler struct {
	operations AppConfigOperations
	origin     string
	logger     *slog.Logger
}

// registerAppConfigRoutes adds configuration routes to the unmounted App adapter.
func registerAppConfigRoutes(routes *RouteRegistry, ops AppConfigOperations, auth RouteAuthentication, origin string, logger *slog.Logger) {
	h := &appConfigHandler{operations: ops, origin: origin, logger: logger}
	routes.handle("PATCH /api/v1/github/apps/{id}", auth.Require(h.update), routeReadManage)
	routes.handle("POST /api/v1/github/apps/{id}/remove", auth.Require(h.remove), routeManage)
	routes.handle("/api/v1/github/apps/{id}/remove", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")), routeFallback)
}

func configFields(w http.ResponseWriter, r *http.Request, budget time.Duration, names ...string) (map[string]json.RawMessage, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return nil, err
	}
	fields, err := httpx.DecodeObjectLimitWithTimeout(w, r, appWriteBytes, budget, names...)
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		if raw, ok := fields[name]; ok && !jsonunicode.Valid(raw) {
			return nil, httpx.InvalidInput(name + " must contain valid Unicode")
		}
	}
	return fields, nil
}

func (h *appConfigHandler) run(w http.ResponseWriter, r *http.Request, p model.Principal, phase string, budget time.Duration, operation func(context.Context, *http.Request, string, time.Time) (any, error)) {
	w.Header().Set("Cache-Control", "no-store")
	start := time.Now()
	ctx, cancel := context.WithTimeoutCause(r.Context(), budget, errAppWriteDeadline)
	defer cancel()
	id, err := pathID(r, "id")
	work := r.WithContext(ctx)
	var result any
	if err == nil {
		result, err = operation(ctx, work, id, start)
	}
	r.Body = work.Body
	if err != nil {
		var body *httpx.BodyReadError
		if errors.As(err, &body) && (body.Status == http.StatusRequestEntityTooLarge || body.Status == http.StatusRequestTimeout) {
			httpx.WriteBodyError(w, r, h.logger, "github", phase, err)
			return
		}
		if body != nil && errors.Is(err, context.DeadlineExceeded) && errors.Is(context.Cause(ctx), errAppWriteDeadline) {
			httpx.WriteBodyError(w, r, h.logger, "github", phase, &httpx.BodyReadError{Cause: err, Status: http.StatusRequestTimeout, Code: "request_timeout", Message: "request body read timed out"})
			return
		}
		(&grantHandler{logger: h.logger}).fail(w, r, phase, err)
		return
	}
	httpx.WriteMutationJSON(w, r, h.logger, "github", http.StatusOK, result)
}

func (h *appConfigHandler) update(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "update_app", appWriteBudget, func(ctx context.Context, work *http.Request, id string, start time.Time) (any, error) {
		fields, err := configFields(w, work, core.OperationTimeout, "version", "expectedUserId", "name", "privateKeyPem", "webhookSecret")
		if err != nil {
			return nil, err
		}
		var in core.UpdateAppInput
		if in.Version, err = decimalField(fields, "version"); err != nil {
			return nil, err
		}
		if in.ExpectedUserID, err = httpx.RequiredString(fields, "expectedUserId"); err != nil {
			return nil, err
		}
		for _, field := range []struct {
			name   string
			target **string
		}{{"name", &in.Name}, {"privateKeyPem", &in.PrivateKeyPEM}, {"webhookSecret", &in.WebhookSecret}} {
			if _, ok := fields[field.name]; ok {
				value, e := httpx.RequiredString(fields, field.name)
				if e != nil {
					return nil, e
				}
				*field.target = &value
			}
		}
		if in.Name == nil && in.PrivateKeyPEM == nil && in.WebhookSecret == nil {
			return nil, httpx.InvalidInput("at least one configuration field is required")
		}
		if in.Name != nil && (len(*in.Name) > 1024 || utf8.RuneCountInString(*in.Name) > 256 || strings.ContainsRune(*in.Name, 0) || strings.TrimFunc(*in.Name, unicode.IsSpace) == "") {
			return nil, httpx.InvalidInput("name must contain non-whitespace text without NUL and fit its size limit")
		}
		if in.PrivateKeyPEM != nil && (len(*in.PrivateKeyPEM) == 0 || len(*in.PrivateKeyPEM) > 65536) {
			return nil, httpx.InvalidInput("privateKeyPem must be nonempty and fit its size limit")
		}
		if in.WebhookSecret != nil && (len(*in.WebhookSecret) == 0 || len(*in.WebhookSecret) > 4096) {
			return nil, httpx.InvalidInput("webhookSecret must be nonempty and fit its size limit")
		}
		if in.PrivateKeyPEM == nil && in.WebhookSecret == nil {
			var cancel context.CancelFunc
			ctx, cancel = context.WithDeadline(ctx, start.Add(core.OperationTimeout))
			defer cancel()
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		out, err := h.operations.UpdateApp(ctx, p, id, in)
		if err != nil {
			return nil, err
		}
		return (&appHandler{origin: h.origin}).response(out), nil
	})
}

func (h *appConfigHandler) remove(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "remove_app", core.OperationTimeout, func(ctx context.Context, work *http.Request, id string, _ time.Time) (any, error) {
		fields, err := configFields(w, work, core.OperationTimeout, "version", "impactVersion", "expectedUserId")
		if err != nil {
			return nil, err
		}
		var in core.RemoveAppInput
		if in.Version, err = decimalField(fields, "version"); err != nil {
			return nil, err
		}
		if in.ImpactVersion, err = decimalField(fields, "impactVersion"); err != nil {
			return nil, err
		}
		if in.ExpectedUserID, err = httpx.RequiredString(fields, "expectedUserId"); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := h.operations.RemoveApp(ctx, p, id, in); err != nil {
			return nil, err
		}
		return api.GitHubAppRemoval{AppID: id, Removed: true}, nil
	})
}
