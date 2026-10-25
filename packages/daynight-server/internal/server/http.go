package server

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
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

const maxJSONBody = 1 << 20

func invalidInput(message string) error {
	return &service.Fault{Code: "invalid_input", Message: message}
}

func decodeObject(w http.ResponseWriter, request *http.Request, allowed ...string) (map[string]json.RawMessage, error) {
	mediaType, parameters, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") {
		return nil, invalidInput("Content-Type must be application/json with UTF-8 encoding")
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, request.Body, maxJSONBody))
	if err != nil || !utf8.Valid(body) {
		return nil, invalidInput("request body must be valid JSON within the 1 MiB limit")
	}
	fields, err := jsonobject.Decode(body, "request body", allowed...)
	if err != nil {
		return nil, invalidInput(err.Error())
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

func versionInput(fields map[string]json.RawMessage) (int64, error) {
	var version int64
	if err := json.Unmarshal(fields["version"], &version); err != nil || version < 1 {
		return 0, invalidInput("version is required and must be a positive 64-bit integer")
	}
	return version, nil
}

func requiredString(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := optionalString(fields, key)
	if err != nil {
		return "", err
	}
	if value == nil {
		return "", invalidInput(key + " is required and must be a string")
	}
	return *value, nil
}

func optionalString(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, exists := fields[key]
	if !exists {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, invalidInput(key + " must be a string")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, invalidInput(key + " must be a string")
	}
	return &value, nil
}

func optionalBool(fields map[string]json.RawMessage, key string) (*bool, error) {
	raw, exists := fields[key]
	if !exists {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, invalidInput(key + " must be a boolean")
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, invalidInput(key + " must be a boolean")
	}
	return &value, nil
}

func optionalStrings(fields map[string]json.RawMessage, key string) (*[]string, error) {
	raw, exists := fields[key]
	if !exists {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, invalidInput(key + " must be an array of strings")
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, invalidInput(key + " must be an array of strings")
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		var value string
		if bytes.Equal(bytes.TrimSpace(item), []byte("null")) || json.Unmarshal(item, &value) != nil {
			return nil, invalidInput(key + " must be an array of strings")
		}
		values = append(values, value)
	}
	return &values, nil
}

func queryValues(request *http.Request, allowed ...string) (url.Values, error) {
	values, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return nil, invalidInput("query parameters must be valid URL encoding")
	}
	for key, entries := range values {
		if !containsField(allowed, key) {
			return nil, invalidInput("query contains an unknown parameter")
		}
		if len(entries) != 1 || entries[0] == "" {
			return nil, invalidInput("query parameters must occur once and must not be empty")
		}
	}
	return values, nil
}

func pageValues(values url.Values) (service.PageRequest, error) {
	page := service.PageRequest{Limit: 50}
	if value, exists := values["limit"]; exists {
		limit, err := strconv.Atoi(value[0])
		if err != nil || limit < 1 || limit > 100 {
			return service.PageRequest{}, invalidInput("limit must be an integer from 1 to 100")
		}
		page.Limit = limit
	}
	if value, exists := values["cursor"]; exists {
		page.Cursor = &value[0]
	}
	return page, nil
}

func pageRequest(request *http.Request) (service.PageRequest, error) {
	values, err := queryValues(request, "limit", "cursor")
	if err != nil {
		return service.PageRequest{}, err
	}
	return pageValues(values)
}

func writeJSON(w http.ResponseWriter, request *http.Request, logger *slog.Logger, status int, value any) {
	if request.Context().Err() != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		LogFailure(logger, request.Context(), "server", "response", err)
	}
}

func writeCreated(w http.ResponseWriter, request *http.Request, logger *slog.Logger, location string, value any) {
	if request.Context().Err() != nil {
		return
	}
	w.Header().Set("Location", location)
	writeJSON(w, request, logger, http.StatusCreated, value)
}

func writeError(w http.ResponseWriter, request *http.Request, logger *slog.Logger, component, phase string, err error) {
	LogFailure(logger, request.Context(), component, phase, err)
	if request.Context().Err() != nil {
		return
	}
	status := http.StatusInternalServerError
	response := api.Error{Code: "internal_error", Message: "internal server error", RequestID: RequestID(request.Context())}
	if fault, ok := knownFault(err); ok && ErrorKind(err) == fault.Code {
		switch fault.Code {
		case "unauthenticated":
			status = http.StatusUnauthorized
		case "forbidden":
			status = http.StatusForbidden
		case "invalid_input":
			status = http.StatusBadRequest
		case "rate_limited":
			status = http.StatusTooManyRequests
			w.Header().Set("Retry-After", "60")
		case "invitation_unavailable":
			status = http.StatusGone
		case "not_found":
			status = http.StatusNotFound
		case "path_conflict", "version_conflict", "invalid_transition", "claim_conflict", "last_admin", "dependency_cycle", "dependency_unsatisfied", "graph_limit_exceeded":
			status = http.StatusConflict
		}
		if status != http.StatusInternalServerError {
			response.Code, response.Message = fault.Code, fault.Message
			if len(fault.TaskIDs) > 0 {
				response.Details = &api.ErrorDetails{TaskIDs: fault.TaskIDs}
			}
			if fault.GraphLimit != nil {
				limits := fault.GraphLimit
				response.Details = &api.ErrorDetails{NodeCount: &limits.NodeCount, EdgeCount: &limits.EdgeCount,
					MaxNodes: &limits.MaxNodes, MaxEdges: &limits.MaxEdges}
			}
		}
	}
	var identityError *service.IdentityProviderError
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
	writeJSON(w, request, logger, status, api.ErrorResponse{Error: response})
}

func methodNotAllowed(logger *slog.Logger, allowed string) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if request.Context().Err() != nil {
			return
		}
		w.Header().Set("Allow", allowed)
		writeJSON(w, request, logger, http.StatusMethodNotAllowed, api.ErrorResponse{
			Error: api.Error{Code: "method_not_allowed", Message: "method not allowed", RequestID: RequestID(request.Context())},
		})
	}
}
