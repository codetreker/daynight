package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

const MaxJSONBody = transport.MaxRESTJSONBodyBytes

func InvalidInput(message string) error {
	return &model.Fault{Code: "invalid_input", Message: message}
}

func DecodeObject(w http.ResponseWriter, request *http.Request, allowed ...string) (map[string]json.RawMessage, error) {
	return DecodeObjectLimit(w, request, MaxJSONBody, allowed...)
}

func DecodeObjectLimit(w http.ResponseWriter, request *http.Request, limit int64, allowed ...string) (map[string]json.RawMessage, error) {
	return DecodeObjectLimitWithTimeout(w, request, limit, transport.JSONBodyReadTimeout, allowed...)
}

// DecodeObjectLimitWithTimeout starts the timeout on the first body read and
// applies it to the actual connection. Incomplete reads prevent connection reuse.
func DecodeObjectLimitWithTimeout(w http.ResponseWriter, request *http.Request, limit int64, timeout time.Duration, allowed ...string) (map[string]json.RawMessage, error) {
	mediaType, parameters, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") {
		CloseUnreadBody(w, request)
		return nil, InvalidInput("Content-Type must be application/json with UTF-8 encoding")
	}
	body, err := ReadBody(w, request, limit, timeout)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(body) {
		return nil, InvalidInput("request body must be valid UTF-8")
	}
	fields, err := jsonobject.Decode(body, "request body", allowed...)
	if err != nil {
		return nil, InvalidInput(err.Error())
	}
	return fields, nil
}

func containsField(allowed []string, key string) bool {
	for _, field := range allowed {
		if key == field {
			return true
		}
	}
	return false
}

func VersionInput(fields map[string]json.RawMessage) (int64, error) {
	var version int64
	if err := json.Unmarshal(fields["version"], &version); err != nil || version < 1 {
		return 0, InvalidInput("version is required and must be a positive 64-bit integer")
	}
	return version, nil
}

func RequiredString(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := OptionalString(fields, key)
	if err != nil {
		return "", err
	}
	if value == nil {
		return "", InvalidInput(key + " is required and must be a string")
	}
	return *value, nil
}

func OptionalString(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, exists := fields[key]
	if !exists {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, InvalidInput(key + " must be a string")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, InvalidInput(key + " must be a string")
	}
	return &value, nil
}

func OptionalBool(fields map[string]json.RawMessage, key string) (*bool, error) {
	raw, exists := fields[key]
	if !exists {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, InvalidInput(key + " must be a boolean")
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, InvalidInput(key + " must be a boolean")
	}
	return &value, nil
}

func OptionalStrings(fields map[string]json.RawMessage, key string) (*[]string, error) {
	raw, exists := fields[key]
	if !exists {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, InvalidInput(key + " must be an array of strings")
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, InvalidInput(key + " must be an array of strings")
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		var value string
		if bytes.Equal(bytes.TrimSpace(item), []byte("null")) || json.Unmarshal(item, &value) != nil {
			return nil, InvalidInput(key + " must be an array of strings")
		}
		values = append(values, value)
	}
	return &values, nil
}

func QueryValues(request *http.Request, allowed ...string) (url.Values, error) {
	if len(request.URL.RawQuery) > transport.MaxRawQueryBytes {
		return nil, &URITooLongError{}
	}
	values, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return nil, InvalidInput("query parameters must be valid URL encoding")
	}
	for key, entries := range values {
		if !containsField(allowed, key) {
			return nil, InvalidInput("query contains an unknown parameter")
		}
		if len(entries) != 1 || entries[0] == "" {
			return nil, InvalidInput("query parameters must occur once and must not be empty")
		}
	}
	return values, nil
}

func PageValues(values url.Values) (model.PageRequest, error) {
	page := model.PageRequest{Limit: 50}
	if value, exists := values["limit"]; exists {
		limit, err := strconv.Atoi(value[0])
		if err != nil || limit < 1 || limit > 100 {
			return model.PageRequest{}, InvalidInput("limit must be an integer from 1 to 100")
		}
		page.Limit = limit
	}
	if value, exists := values["cursor"]; exists {
		page.Cursor = &value[0]
	}
	return page, nil
}

func PageRequest(request *http.Request) (model.PageRequest, error) {
	values, err := QueryValues(request, "limit", "cursor")
	if err != nil {
		return model.PageRequest{}, err
	}
	return PageValues(values)
}

func WriteJSON(w http.ResponseWriter, request *http.Request, logger *slog.Logger, status int, value any) {
	if request.Context().Err() != nil {
		return
	}
	var body bytes.Buffer
	if err := json.NewEncoder(&body).Encode(value); err != nil {
		w.Header().Del("Location")
		WriteError(w, request, logger, "server", "response encoding", err)
		return
	}
	if request.Context().Err() != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	n, err := w.Write(body.Bytes())
	if err == nil && n != body.Len() {
		err = io.ErrShortWrite
	}
	if err != nil {
		LogFailure(logger, request.Context(), "server", "response", err)
	}
}

func WriteCreated(w http.ResponseWriter, request *http.Request, logger *slog.Logger, location string, value any) {
	if request.Context().Err() != nil {
		return
	}
	w.Header().Set("Location", location)
	WriteJSON(w, request, logger, http.StatusCreated, value)
}

func WriteError(w http.ResponseWriter, request *http.Request, logger *slog.Logger, component, phase string, err error) {
	if bodyReadFailure(err) != nil {
		WriteBodyError(w, request, logger, component, phase, err)
		return
	}
	var uriErr *URITooLongError
	if errors.As(err, &uriErr) {
		CloseUnreadBody(w, request)
		WriteJSON(w, request, logger, http.StatusRequestURITooLong, api.ErrorResponse{Error: api.Error{Code: "uri_too_long", Message: "request target exceeds its input limit", RequestID: RequestID(request.Context())}})
		return
	}
	CloseUnreadBody(w, request)
	LogFailure(logger, request.Context(), component, phase, err)
	if request.Context().Err() != nil {
		return
	}
	status := http.StatusInternalServerError
	response := api.Error{Code: "internal_error", Message: "internal server error", RequestID: RequestID(request.Context())}
	if fault, ok := KnownFault(err); ok && ErrorKind(err) == fault.Code {
		switch fault.Code {
		case "unauthenticated":
			status = http.StatusUnauthorized
		case "permission_denied", "forbidden":
			status = http.StatusForbidden
		case "invalid_image", "image_integrity", "image_decode_failed", "invalid_path", "invalid_cursor", "invalid_payload", "unsupported_protocol", "unsupported_content_kind", "invalid_input", "invalid_tag_filter", "invalid_search_expression":
			status = http.StatusBadRequest
		case "search_timeout", "timeout":
			status = http.StatusGatewayTimeout
		case "payload_too_large", "limit_exceeded":
			status = http.StatusRequestEntityTooLarge
		case "capability_error", "cleanup_unknown", "io_error", "offline", "controller_offline", "relay_instance_unavailable":
			status = http.StatusServiceUnavailable
		case "unsupported", "upgrade_required":
			status = http.StatusNotImplemented
		case "busy":
			status = http.StatusTooManyRequests
		case "history_unavailable":
			status = http.StatusServiceUnavailable
		case "unsupported_mode":
			status = http.StatusBadRequest
		case "claim_held", "claim_lost", "task_paused", "content_changed", "history_pending", "execution_changed":
			status = http.StatusConflict
		case "content_unavailable":
			status = http.StatusBadGateway
		case "resource_busy":
			status = http.StatusTooManyRequests
		case "capacity_exhausted":
			status = http.StatusServiceUnavailable
			w.Header().Set("Retry-After", "60")
		case "rate_limited":
			status = http.StatusTooManyRequests
			w.Header().Set("Retry-After", "60")
		case "task_deleted":
			status = http.StatusGone
		case "not_found", "tag_not_found", "message_not_found", "invitation_unavailable":
			status = http.StatusNotFound
		case "media_outcome_unknown", "clock_not_advanced", "message_outcome_unknown", "write_outcome_unknown", "monitoring_unavailable", "monitoring_write_outcome_unknown":
			status = http.StatusServiceUnavailable
		case "github_repository_mismatch":
			status = http.StatusConflict
		case "archive_conflict", "archive_incomplete", "component_unsupported", "quota_exceeded", "resource_in_use", "capability_changed", "configuration_not_initialized", "search_changed", "monitoring_revision_conflict", "monitoring_sequence_stale", "monitoring_sample_conflict", "monitoring_state_lost":
			status = http.StatusConflict
		case "cancelled", "unsupported_native_selection", "unsupported_selection", "unknown_default", "stale_configuration", "personal_team_immutable", "team_not_empty", "step_id_conflict", "steps_limit_exceeded", "version_exhausted", "stale_fence", "target_changed", "lease_expired", "input_busy", "automation_suspended", "input_unknown", "recording_limit", "source_corrupt", "stop_unknown", "archive_pending", "path_conflict", "version_conflict", "invalid_transition", "claim_conflict", "active_worker_limit_exceeded", "active_worker_claims", "last_admin", "identity_mismatch", "dependency_cycle", "dependency_unsatisfied", "session_conflict", "operation_conflict", "source_gap", "reconcile_required", "reset_required", "resource_conflict", "resource_limit_exceeded":
			status = http.StatusConflict
		}
		if status != http.StatusInternalServerError {
			response.Code, response.Message = fault.Code, fault.Message
			var claim *model.AssistantTaskClaimError
			if errors.As(err, &claim) {
				response.Details = &api.ErrorDetails{HolderBotID: claim.Claim.HolderBotID, ClaimGeneration: &claim.Claim.Generation, LeaseUntil: claim.Claim.LeaseUntil}
			}
			if len(fault.TaskIDs) > 0 {
				response.Details = &api.ErrorDetails{TaskIDs: fault.TaskIDs}
			}
			if fault.StepsLimit != nil {
				limits := fault.StepsLimit
				response.Details = &api.ErrorDetails{EncodedBytes: &limits.EncodedBytes, MaxEncodedBytes: &limits.MaxEncodedBytes}
			}

			if fault.SearchExpression != nil {
				details := fault.SearchExpression
				response.Details = &api.ErrorDetails{Reason: &details.Reason, Position: &details.Position, Length: &details.Length}
			}
		}
	}
	var identityError *model.IdentityProviderError
	if errors.As(err, &identityError) {
		switch identityError.Code {
		case "identity_configuration":
			status = http.StatusServiceUnavailable
		case "identity_timeout":
			status = http.StatusGatewayTimeout
		default:
			status = http.StatusBadGateway
		}
		response.Code, response.Message = identityError.Code, identityError.Error()
	}
	WriteJSON(w, request, logger, status, api.ErrorResponse{Error: response})
}

func MethodNotAllowed(logger *slog.Logger, allowed string) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if request.Context().Err() != nil {
			return
		}
		w.Header().Set("Allow", allowed)
		WriteJSON(w, request, logger, http.StatusMethodNotAllowed, api.ErrorResponse{
			Error: api.Error{Code: "method_not_allowed", Message: "method not allowed", RequestID: RequestID(request.Context())},
		})
	}
}
