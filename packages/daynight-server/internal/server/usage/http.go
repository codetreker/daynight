package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
)

type Authentication interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}
type operations interface {
	Capabilities() map[string]any
	Register(context.Context, model.Principal, app.Registration) (app.RegistrationResult, error)
	State(context.Context, model.Principal, string) (model.UsageRecord, error)
	Rotate(context.Context, model.Principal, string, app.GrantRequest) (app.RegistrationResult, error)
	Revoke(context.Context, model.Principal, string, string) (model.UsageRecord, error)
	Batch(context.Context, string, string, app.Batch) (app.BatchResult, error)
	Sources(context.Context, string, string, []string) (app.SourcesResult, error)
	TaskSummaries(context.Context, model.Principal, string, []string) (app.Summaries, error)
	TestSummary(context.Context, model.Principal, string) (model.UsageSummary, error)
	Records(context.Context, model.Principal, string, string, string, app.PageRequest) (app.RecordsPage, error)
	Aggregate(context.Context, model.Principal, string, string, string, string) (app.Aggregate, error)
}
type handler struct {
	service operations
	auth    Authentication
	logger  *slog.Logger
}

func RegisterRoutes(mux *http.ServeMux, service *app.Service, auth Authentication, logger *slog.Logger) {
	RegisterRoutesWithScopeObserver(mux, service, auth, logger, nil)
}

// RegisterRoutesWithScopeObserver exposes classifications of the routes actually installed.
func RegisterRoutesWithScopeObserver(mux *http.ServeMux, service *app.Service, auth Authentication, logger *slog.Logger, observe func(ScopeRoute)) {
	if service == nil {
		return
	}
	registerRoutesObserved(mux, service, auth, auth, logger, observe)
}
func registerRoutes(mux *http.ServeMux, service operations, auth Authentication, logger *slog.Logger) {
	registerRoutesObserved(mux, service, auth, auth, logger, nil)
}
func registerRoutesObserved(mux *http.ServeMux, service operations, auth, readAuth Authentication, logger *slog.Logger, observe func(ScopeRoute)) {
	h := &handler{service, auth, logger}
	routes := routeRegistry{mux, observe}
	routes.handle("GET /api/usage/v1/capabilities", auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		h.write(w, r, http.StatusOK, service.Capabilities())
	}), routeCapability)
	routes.handle("POST /api/usage/v1/registrations", auth.Require(h.register), routeProducer)
	routes.handle("GET /api/usage/v1/states/{stateId}", auth.Require(h.state), routeProducer)
	routes.handle("POST /api/usage/v1/states/{stateId}/grant", auth.Require(h.rotate), routeProducer)
	routes.handle("POST /api/usage/v1/states/{stateId}/revoke", auth.Require(h.revoke), routeProducer)
	routes.handle("POST /api/usage/v1/states/{stateId}/batches", h.batch, routeGrant)
	routes.handle("GET /api/usage/v1/states/{stateId}/sources", h.sources, routeGrant)
	routes.handle("GET /api/projects/{projectId}/tasks/{taskId}/usage/v1/summary", readAuth.Require(h.taskSummary), routeRead)
	routes.handle("POST /api/projects/{projectId}/usage/v1/task-summaries", readAuth.Require(h.taskSummaries), routeRead)
	routes.handle("GET /api/projects/{projectId}/tasks/{taskId}/usage/v1/records", readAuth.Require(h.records), routeRead)
	routes.handle("GET /api/test-sessions/{sessionId}/usage/v1/summary", readAuth.Require(h.testSummary), routeRead)
	routes.handle("GET /api/test-sessions/{sessionId}/usage/v1/records", readAuth.Require(h.records), routeRead)
	routes.handle("GET /api/projects/{projectId}/usage/v1/aggregates/chain/{scopeId}", readAuth.Require(h.chain), routeRead)
	routes.handle("GET /api/projects/{projectId}/usage/v1/aggregates/goal/{scopeId}", readAuth.Require(h.goal), routeRead)
}

func (h *handler) write(w http.ResponseWriter, r *http.Request, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "no-store")
	}
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		h.logger.ErrorContext(r.Context(), "usage response failed", "request_id", httpx.RequestID(r.Context()), "error", err)
	}
}
func (h *handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	var f *model.UsageFault
	if !errors.As(err, &f) {
		if errors.Is(err, model.ErrNotFound) {
			f = &model.UsageFault{Code: "resource_unavailable"}
		} else {
			httpx.WriteError(w, r, h.logger, "usage", "request", err)
			return
		}
	}
	status := http.StatusBadRequest
	switch f.Code {
	case "invalid_grant":
		status = 401
	case "permission_revoked", "aggregate_scope_restricted":
		status = 403
	case "resource_unavailable":
		status = 404
	case "usage_changed", "source_conflict", "finality_regression", "registration_conflict", "registration_unavailable", "reset_required", "cursor_expired":
		status = 409
	case "upload_expired", "origin_unavailable":
		status = 410
	case "body_too_large":
		status = 413
	case "unsupported_scope", "profile_unverified", "aggregate_scope_too_large":
		status = 422
	case "write_disabled":
		status = 501
	case "write_outcome_unknown", "write_not_committed":
		status = 503
	}
	body := map[string]any{"code": f.Code, "requestId": httpx.RequestID(r.Context())}
	if f.EventID != "" {
		body["eventId"] = f.EventID
	}
	if f.SourceKey != "" {
		body["sourceKey"] = f.SourceKey
	}
	if f.CurrentRevision != nil {
		body["currentRevision"] = f.CurrentRevision
	}
	if f.CurrentBodyHash != "" {
		body["currentBodyHash"] = f.CurrentBodyHash
	}
	if f.DiagnosticCommitted {
		body["diagnosticCommitted"] = true
		body["rowVersion"] = f.RowVersion
	}
	h.write(w, r, status, map[string]any{"error": body})
}
func parse(w http.ResponseWriter, r *http.Request, target any) ([]byte, error) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return nil, core.Fault("invalid_body")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256*1024))
	if err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			return nil, core.Fault("body_too_large")
		}
		return nil, err
	}
	if !utf8.Valid(raw) || !validSurrogates(raw) {
		return nil, core.Fault("invalid_body")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err = uniqueJSONDepth(d, 0); err != nil {
		return nil, err
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, core.Fault("invalid_body")
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	d.UseNumber()
	if err = d.Decode(target); err != nil {
		return nil, core.Fault("invalid_body")
	}
	return raw, nil
}
func uniqueJSONDepth(d *json.Decoder, depth int) error {
	if depth > 64 {
		return core.Fault("invalid_body")
	}
	t, err := d.Token()
	if err != nil {
		return core.Fault("invalid_body")
	}
	delimiter, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			key, e := d.Token()
			if e != nil {
				return core.Fault("invalid_body")
			}
			s, ok := key.(string)
			if !ok || seen[s] {
				return core.Fault("invalid_body")
			}
			seen[s] = true
			if e = uniqueJSONDepth(d, depth+1); e != nil {
				return e
			}
		}
	case '[':
		for d.More() {
			if err = uniqueJSONDepth(d, depth+1); err != nil {
				return err
			}
		}
	default:
		return core.Fault("invalid_body")
	}
	_, err = d.Token()
	if err != nil {
		return core.Fault("invalid_body")
	}
	return nil
}
func validSurrogates(raw []byte) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return false
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return false
		}
		n, e := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if e != nil {
			return false
		}
		i += 4
		if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
		if n >= 0xd800 && n <= 0xdbff {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return false
			}
			low, e := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if e != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}
func path(r *http.Request, name string) (string, error) {
	s := r.PathValue(name)
	if !core.UUID(s) {
		return "", core.Fault("resource_unavailable")
	}
	return s, nil
}
func grant(r *http.Request) (string, error) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return "", core.Fault("invalid_grant")
	}
	token := strings.TrimPrefix(values[0], "Bearer ")
	if len(token) != 43 {
		return "", core.Fault("invalid_grant")
	}
	return token, nil
}
func conditional(w http.ResponseWriter, r *http.Request, etag string) bool {
	w.Header().Set("ETag", `"`+etag+`"`)
	w.Header().Set("Cache-Control", "private, no-cache")
	for _, v := range strings.Split(r.Header.Get("If-None-Match"), ",") {
		if strings.TrimPrefix(strings.TrimSpace(v), "W/") == `"`+etag+`"` || strings.TrimSpace(v) == "*" {
			w.WriteHeader(http.StatusNotModified)
			return true
		}
	}
	return false
}
func (h *handler) register(w http.ResponseWriter, r *http.Request, p model.Principal) {
	var input app.Registration
	if _, err := parse(w, r, &input); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.service.Register(r.Context(), p, input)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	status := 200
	if out.Created {
		status = 201
	}
	h.write(w, r, status, out)
}
func (h *handler) state(w http.ResponseWriter, r *http.Request, p model.Principal) {
	id, err := path(r, "stateId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.service.State(r.Context(), p, id)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.write(w, r, 200, out)
}
func (h *handler) rotate(w http.ResponseWriter, r *http.Request, p model.Principal) {
	id, err := path(r, "stateId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var input app.GrantRequest
	if _, err = parse(w, r, &input); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.service.Rotate(r.Context(), p, id, input)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.write(w, r, 200, out)
}
func (h *handler) revoke(w http.ResponseWriter, r *http.Request, p model.Principal) {
	id, err := path(r, "stateId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var input struct {
		Expected string `json:"expectedRowVersion"`
	}
	if _, err = parse(w, r, &input); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.service.Revoke(r.Context(), p, id, input.Expected)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.write(w, r, 200, map[string]any{"state": out})
}
func (h *handler) batch(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Protocol string            `json:"protocol"`
		BatchID  string            `json:"batchId"`
		Events   []json.RawMessage `json:"events"`
	}
	if _, err := parse(w, r, &input); err != nil {
		h.fail(w, r, err)
		return
	}
	batch := app.Batch{Protocol: input.Protocol, BatchID: input.BatchID, Events: []model.UsageEvent{}}
	for _, raw := range input.Events {
		if len(raw) > 16*1024 {
			h.fail(w, r, core.Fault("body_too_large"))
			return
		}
		e, err := decodeEvent(raw)
		if err != nil {
			h.fail(w, r, err)
			return
		}
		batch.Events = append(batch.Events, e)
	}
	id, err := path(r, "stateId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	token, err := grant(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.service.Batch(r.Context(), id, token, batch)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.write(w, r, 200, out)
}
func decodeEvent(raw []byte) (model.UsageEvent, error) {
	var e model.UsageEvent
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return e, core.Fault("invalid_body")
	}
	var kind string
	if err := json.Unmarshal(object["kind"], &kind); err != nil {
		return e, core.Fault("invalid_body")
	}
	keys := "eventId,kind,reasonCodes,observedAt"
	switch kind {
	case "measurement":
		keys += ",originatingStateId,sourceKey,nativeTurnId,nativeCallId,model,profileId,revisionAuthority,sourceRevision,finality,disposition,aggregationRole,includedInSourceKey,metrics,nativeMetrics"
	case "execution_state":
		keys += ",stateSequence,collectionState,capability,nativeStartedAt,nativeEndedAt,seal"
	default:
		return e, core.Fault("invalid_body")
	}
	allowed := map[string]bool{}
	for _, k := range strings.Split(keys, ",") {
		allowed[k] = true
		if _, ok := object[k]; !ok {
			return e, core.Fault("invalid_body")
		}
	}
	for k := range object {
		if !allowed[k] {
			return e, core.Fault("invalid_body")
		}
		seal := string(bytes.TrimSpace(object["seal"]))
		if kind == "execution_state" && seal != "true" && seal != "false" {
			return e, core.Fault("invalid_body")
		}
	}
	if kind == "measurement" {
		if len(object["nativeMetrics"]) > 4096 {
			return e, core.Fault("invalid_measurement")
		}
		var metrics map[string]json.RawMessage
		if json.Unmarshal(object["metrics"], &metrics) != nil || len(metrics) != 7 {
			return e, core.Fault("invalid_body")
		}
		for _, k := range []string{"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens", "providerTotalTokens"} {
			if _, ok := metrics[k]; !ok {
				return e, core.Fault("invalid_body")
			}
		}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	d.UseNumber()
	if d.Decode(&e) != nil {
		return e, core.Fault("invalid_body")
	}
	return e, nil
}
func (h *handler) sources(w http.ResponseWriter, r *http.Request) {
	id, err := path(r, "stateId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	token, err := grant(r)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.service.Sources(r.Context(), id, token, r.URL.Query()["key"])
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.write(w, r, 200, out)
}
func (h *handler) taskSummary(w http.ResponseWriter, r *http.Request, p model.Principal) {
	project, err := path(r, "projectId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	task, err := path(r, "taskId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.service.TaskSummaries(r.Context(), p, project, []string{task})
	if err != nil {
		h.fail(w, r, err)
		return
	}
	summary := out.Items[0].Summary
	if conditional(w, r, summary.ETag) {
		return
	}
	h.write(w, r, 200, summary)
}
func (h *handler) taskSummaries(w http.ResponseWriter, r *http.Request, p model.Principal) {
	project, err := path(r, "projectId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	var input struct {
		TaskIDs []string `json:"taskIds"`
	}
	if _, err = parse(w, r, &input); err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.service.TaskSummaries(r.Context(), p, project, input.TaskIDs)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if conditional(w, r, out.ETag) {
		return
	}
	h.write(w, r, 200, out)
}
func (h *handler) testSummary(w http.ResponseWriter, r *http.Request, p model.Principal) {
	id, err := path(r, "sessionId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.service.TestSummary(r.Context(), p, id)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	if conditional(w, r, out.ETag) {
		return
	}
	h.write(w, r, 200, out)
}
func (h *handler) records(w http.ResponseWriter, r *http.Request, p model.Principal) {
	project, task, session := r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId")
	if session != "" && !core.UUID(session) || session == "" && (!core.UUID(project) || !core.UUID(task)) {
		h.fail(w, r, core.Fault("resource_unavailable"))
		return
	}
	q, err := pageQuery(r.URL.RawQuery)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	limit := 100
	if q.Has("limit") {
		limit, err = strconv.Atoi(q.Get("limit"))
		if err != nil {
			h.fail(w, r, core.Fault("invalid_filter"))
			return
		}
	}
	input := app.PageRequest{Kind: q.Get("kind"), StateID: q.Get("stateId"), Model: q.Get("model"), Provider: q.Get("provider"), Role: q.Get("aggregationRole"), Cursor: q.Get("cursor"), Limit: limit}
	out, err := h.service.Records(r.Context(), p, project, task, session, input)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.write(w, r, 200, out)
}
func (h *handler) chain(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.aggregate(w, r, p, "chain")
}
func (h *handler) goal(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.aggregate(w, r, p, "goal")
}
func (h *handler) aggregate(w http.ResponseWriter, r *http.Request, p model.Principal, kind string) {
	project, err := path(r, "projectId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	id, err := path(r, "scopeId")
	if err != nil {
		h.fail(w, r, err)
		return
	}
	q, err := pageQuery(r.URL.RawQuery)
	if err != nil {
		h.fail(w, r, err)
		return
	}
	out, err := h.service.Aggregate(r.Context(), p, project, kind, id, q.Get("cursor"))
	if err != nil {
		h.fail(w, r, err)
		return
	}
	h.write(w, r, 200, out)
}

// pageQuery rejects malformed input before using any partial parse result.
func pageQuery(raw string) (url.Values, error) {
	q, err := url.ParseQuery(raw)
	if err != nil {
		return nil, core.Fault("invalid_filter")
	}
	if len(q["cursor"]) > 1 {
		return nil, core.Fault("invalid_cursor")
	}
	return q, nil
}
