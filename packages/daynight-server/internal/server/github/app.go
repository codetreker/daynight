package github

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

const appWriteBudget = 45 * time.Second
const appWriteBytes = 131072

var errAppWriteDeadline = errors.New("github app write deadline exceeded")

type AppOperations interface {
	CreateApp(context.Context, model.Principal, core.CreateAppInput) (core.AppMetadata, error)
	GetApp(context.Context, model.Principal, string) (core.AppMetadata, error)
	ListApps(context.Context, model.Principal, core.ListAppsInput) (core.AppPage, error)
}

type appHandler struct {
	operations AppOperations
	origin     string
	logger     *slog.Logger
}

// RegisterAppRoutes installs the independent App adapter. origin is the trusted
// configured public origin, never an incoming Host header.
func RegisterAppRoutes(mux *http.ServeMux, ops AppOperations, auth RouteAuthentication, origin string, logger *slog.Logger) {
	h := &appHandler{operations: ops, origin: origin, logger: logger}
	mux.HandleFunc("GET /api/v1/github/apps", auth.Require(h.list))
	mux.HandleFunc("POST /api/v1/github/apps", auth.Require(h.create))
	mux.HandleFunc("GET /api/v1/github/apps/{id}", auth.Require(h.get))
	mux.HandleFunc("/api/v1/github/apps", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("/api/v1/github/apps/{id}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
}

func (h *appHandler) response(v core.AppMetadata) api.GitHubApp {
	return api.GitHubApp{ID: v.ID, GitHubAppID: decimal(v.GitHubAppID), Name: v.Name, GitHubName: v.GitHubName, GitHubSlug: v.GitHubSlug, Version: decimal(v.Version), Administrators: decimal(v.Administrators), AuthorizedTeams: decimal(v.AuthorizedTeams), ConnectedProjects: decimal(v.ConnectedProjects), WebhookURL: h.origin + "/api/v1/github/apps/" + v.ID + "/webhook", CreatedAt: v.CreatedAt.UTC(), UpdatedAt: v.UpdatedAt.UTC()}
}

func (h *appHandler) list(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	values, err := httpx.QueryValues(r, "limit", "cursor")
	input := core.ListAppsInput{Limit: 25}
	if err == nil {
		if value, ok := values["limit"]; ok {
			n, e := strconv.Atoi(value[0])
			if e != nil || n < 1 || n > 100 || strconv.Itoa(n) != value[0] {
				err = httpx.InvalidInput("limit must be an integer from 1 to 100")
			} else {
				input.Limit = n
			}
		}
		if value, ok := values["cursor"]; ok {
			input.Cursor = value[0]
		}
	}
	if err != nil {
		h.writeError(w, r, logger, "list", err)
		return
	}
	page, err := h.operations.ListApps(r.Context(), p, input)
	if err != nil {
		h.writeError(w, r, logger, "list", err)
		return
	}
	result := api.GitHubAppPage{Items: make([]api.GitHubApp, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, v := range page.Items {
		result.Items = append(result.Items, h.response(v))
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, result)
}

func (h *appHandler) get(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	id, err := model.CanonicalID(r.PathValue("id"))
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	if err != nil {
		h.writeError(w, r, logger, "get", err)
		return
	}
	value, err := h.operations.GetApp(r.Context(), p, id)
	if err != nil {
		h.writeError(w, r, logger.With("app_resource_id", id), "get", err)
		return
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, h.response(value))
}

func appCreateInput(w http.ResponseWriter, r *http.Request) (core.CreateAppInput, error) {
	var input core.CreateAppInput
	if _, err := httpx.QueryValues(r); err != nil {
		return input, err
	}
	fields, err := httpx.DecodeObjectLimitWithTimeout(w, r, appWriteBytes, appWriteBudget, "id", "name", "githubAppId", "privateKeyPem", "webhookSecret", "expectedUserId")
	if err != nil {
		return input, err
	}
	for _, key := range []string{"id", "name", "githubAppId", "privateKeyPem", "webhookSecret", "expectedUserId"} {
		if raw, ok := fields[key]; ok && !jsonunicode.Valid(raw) {
			return input, httpx.InvalidInput(key + " must contain valid Unicode")
		}
	}
	var rawID string
	if rawID, err = httpx.RequiredString(fields, "id"); err != nil {
		return input, err
	}
	if input.ID, err = model.CanonicalID(rawID); err != nil {
		return input, err
	}
	if input.Name, err = httpx.RequiredString(fields, "name"); err != nil {
		return input, err
	}
	if len(input.Name) > 1024 || utf8.RuneCountInString(input.Name) > 256 || strings.ContainsRune(input.Name, 0) || strings.TrimFunc(input.Name, unicode.IsSpace) == "" {
		return input, httpx.InvalidInput("name must contain non-whitespace text without NUL and fit its size limit")
	}
	if input.GitHubAppID, err = decimalField(fields, "githubAppId"); err != nil {
		return input, err
	}
	if input.PrivateKeyPEM, err = httpx.RequiredString(fields, "privateKeyPem"); err != nil {
		return input, err
	}
	if len(input.PrivateKeyPEM) == 0 || len(input.PrivateKeyPEM) > 65536 {
		return input, httpx.InvalidInput("privateKeyPem must fit its size limit")
	}
	if input.WebhookSecret, err = httpx.RequiredString(fields, "webhookSecret"); err != nil {
		return input, httpx.InvalidInput("webhookSecret must be a string")
	}
	if len(input.WebhookSecret) == 0 || len(input.WebhookSecret) > 4096 {
		return input, httpx.InvalidInput("webhookSecret must be nonempty and fit its size limit")
	}
	if input.ExpectedUserID, err = httpx.RequiredString(fields, "expectedUserId"); err != nil {
		return input, err
	}
	return input, nil
}

func (h *appHandler) create(w http.ResponseWriter, r *http.Request, p model.Principal) {
	ctx, cancel := context.WithTimeoutCause(r.Context(), appWriteBudget, errAppWriteDeadline)
	defer cancel()
	h.createWithContext(w, r, p, ctx)
}

// The operation budget covers body reading and the service, while the original
// request context controls response delivery after an internal deadline.
func (h *appHandler) createWithContext(w http.ResponseWriter, r *http.Request, p model.Principal, ctx context.Context) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	if err := ctx.Err(); err != nil {
		h.writeCreateError(w, r, logger, err)
		return
	}
	workRequest := r.WithContext(ctx)
	input, err := appCreateInput(w, workRequest)
	r.Body = workRequest.Body
	// A terminal body refusal may itself cancel the transport context while
	// the response socket remains writable. Preserve httpx's bounded rejection.
	var bodyError *httpx.BodyReadError
	if errors.As(err, &bodyError) && (bodyError.Status == http.StatusRequestEntityTooLarge || bodyError.Status == http.StatusRequestTimeout) {
		httpx.WriteError(w, r, logger, "github", "create", err)
		return
	}
	if bodyError != nil && errors.Is(err, context.DeadlineExceeded) && errors.Is(context.Cause(ctx), errAppWriteDeadline) {
		// Closing the incomplete body may cancel the original transport context.
		// Only this handler's own deadline permits a bounded timeout response.
		timeout := &httpx.BodyReadError{Cause: err, Status: http.StatusRequestTimeout, Code: "request_timeout", Message: "request body read timed out"}
		httpx.WriteError(w, r, logger, "github", "create", timeout)
		return
	}
	if err == nil {
		err = ctx.Err()
	}
	if err != nil {
		h.writeCreateError(w, r, logger, err)
		return
	}
	result, err := h.operations.CreateApp(ctx, p, input)
	if err != nil {
		h.writeCreateError(w, r, logger.With("app_resource_id", input.ID), err)
		return
	}
	response := appCreatedWriter{ResponseWriter: w, ctx: r.Context(), location: "/api/v1/github/apps/" + result.ID}
	httpx.WriteMutationJSON(&response, r, logger, "github", http.StatusCreated, h.response(result))
}

func (h *appHandler) writeCreateError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	if r.Context().Err() != nil {
		httpx.CloseUnreadBody(w, r)
		httpx.LogFailure(logger, r.Context(), "github", "create", err)
		return
	}
	var management *service.ManagementError
	_, knownFault := httpx.KnownFault(err)
	if !errors.As(err, &management) && !knownFault && errors.Is(err, context.DeadlineExceeded) {
		err = &model.Fault{Code: "timeout", Message: "GitHub App operation timed out."}
	}
	h.writeError(w, r, logger, "create", err)
}

// A Location is published only with the successful response, after encoding and
// the mutation writer's cancellation check.
type appCreatedWriter struct {
	http.ResponseWriter
	ctx      context.Context
	location string
}

func (w *appCreatedWriter) WriteHeader(status int) {
	if w.ctx.Err() != nil {
		return
	}
	if status == http.StatusCreated {
		w.Header().Set("Location", w.location)
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *appCreatedWriter) Write(data []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.ResponseWriter.Write(data)
}

func (h *appHandler) writeError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, phase string, err error) {
	var code, message string
	var mgmt *service.ManagementError
	if errors.As(err, &mgmt) {
		code, message = mgmt.Code, mgmt.Message
	} else if fault, ok := httpx.KnownFault(err); ok && httpx.ErrorKind(err) == fault.Code {
		code, message = fault.Code, fault.Message
	}
	status := 0
	switch code {
	case "github_app_already_registered", "github_app_id_conflict":
		status = http.StatusConflict
	case "github_app_credentials_invalid":
		status = http.StatusUnprocessableEntity
	case "github_write_outcome_unknown":
		status = http.StatusServiceUnavailable
	case "github_unavailable", "github_rate_limited":
		status = http.StatusBadGateway
	}
	if status == 0 {
		httpx.WriteError(w, r, logger, "github", phase, err)
		return
	}
	httpx.CloseUnreadBody(w, r)
	httpx.LogFailure(logger, r.Context(), "github", phase, err)
	if r.Context().Err() != nil {
		return
	}
	response := api.Error{Code: code, Message: message, RequestID: httpx.RequestID(r.Context())}
	if code == "github_write_outcome_unknown" {
		value := "unknown"
		response.Details = &api.ErrorDetails{WriteOutcome: &value}
	}
	httpx.WriteJSON(w, r, logger, status, api.ErrorResponse{Error: response})
}
