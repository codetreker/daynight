package webhook

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
	"github.com/google/uuid"
)

const maxConfigurationBytes = 256 << 10

type operationInput struct {
	ID             string
	IssuedAt       string
	ExpectedUserID string
	RequestSHA256  string
}

type destinationInput struct {
	Kind           string
	AdapterVersion string
	URL            string
}

type subscriptionInput struct {
	ID         *string
	ProjectID  string
	EventTypes []string
}

type createInput struct {
	Operation     operationInput
	Name          string
	Enabled       bool
	Destination   destinationInput
	Subscriptions []subscriptionInput
}

type patchInput struct {
	Operation         operationInput
	IfVersion         int64
	Name              *string
	Enabled           *bool
	Destination       *destinationInput
	Subscriptions     *[]subscriptionInput
	ConfirmProjectIDs *[]string
}

type deleteInput struct {
	Operation operationInput
	IfVersion int64
}

type rotationInput struct {
	Operation operationInput
	IfVersion int64
	Mode      string
}

func decodeConfiguration(request *http.Request, allowed ...string) (map[string]json.RawMessage, string, error) {
	if _, err := httpx.QueryValues(request); err != nil {
		return nil, "", err
	}
	types := request.Header.Values("Content-Type")
	if len(types) != 1 {
		return nil, "", httpx.InvalidInput("Content-Type must be application/json with UTF-8 encoding")
	}
	mediaType, parameters, err := mime.ParseMediaType(types[0])
	if err != nil || mediaType != "application/json" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") {
		return nil, "", httpx.InvalidInput("Content-Type must be application/json with UTF-8 encoding")
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxConfigurationBytes+1))
	if err != nil {
		return nil, "", &model.Fault{Code: "invalid_input", Message: "The configuration request could not be read.", Cause: err}
	}
	if len(body) > maxConfigurationBytes {
		return nil, "", &model.Fault{Code: "content_too_large", Message: "The configuration request exceeds 256 KiB."}
	}
	if !jsonunicode.Valid(body) {
		return nil, "", httpx.InvalidInput("The configuration request must contain valid Unicode JSON.")
	}
	fields, err := decodeFields(body, "configuration request", allowed...)
	if err != nil {
		return nil, "", err
	}
	hash := sha256.Sum256(body)
	return fields, hex.EncodeToString(hash[:]), nil
}

func decodeFields(raw []byte, path string, allowed ...string) (map[string]json.RawMessage, error) {
	fields, err := jsonobject.Decode(raw, path, allowed...)
	if err != nil {
		return nil, httpx.InvalidInput(err.Error())
	}
	return fields, nil
}

func requiredID(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := httpx.RequiredString(fields, key)
	if err != nil {
		return "", err
	}
	return canonicalID(value)
}

func canonicalID(value string) (string, error) {
	id, err := model.CanonicalID(value)
	if err != nil || id != value || id == uuid.Nil.String() {
		return "", httpx.InvalidInput("ID must be a canonical nonzero UUID.")
	}
	return id, nil
}

func versionInput(fields map[string]json.RawMessage, key string) (int64, error) {
	value, err := httpx.RequiredString(fields, key)
	if err != nil {
		return 0, err
	}
	version, err := strconv.ParseInt(value, 10, 64)
	if err != nil || version < 1 || strconv.FormatInt(version, 10) != value {
		return 0, httpx.InvalidInput(key + " must be a canonical positive int64 decimal string.")
	}
	return version, nil
}

func parseOperation(fields map[string]json.RawMessage, requestHash string) (operationInput, error) {
	id, err := requiredID(fields, "operationId")
	if err != nil {
		return operationInput{}, err
	}
	issuedAt, err := httpx.RequiredString(fields, "issuedAt")
	if err != nil {
		return operationInput{}, err
	}
	userID, err := requiredID(fields, "expectedUserId")
	if err != nil {
		return operationInput{}, err
	}
	return operationInput{ID: id, IssuedAt: issuedAt, ExpectedUserID: userID, RequestSHA256: requestHash}, nil
}

func parseDestination(raw json.RawMessage) (destinationInput, error) {
	fields, err := decodeFields(raw, "destination", "kind", "adapterVersion", "configuration")
	if err != nil {
		return destinationInput{}, err
	}
	kind, err := httpx.RequiredString(fields, "kind")
	if err != nil {
		return destinationInput{}, err
	}
	version, err := httpx.RequiredString(fields, "adapterVersion")
	if err != nil {
		return destinationInput{}, err
	}
	configuration, err := decodeFields(fields["configuration"], "destination configuration", "url")
	if err != nil {
		return destinationInput{}, err
	}
	url, err := httpx.RequiredString(configuration, "url")
	if err != nil {
		return destinationInput{}, err
	}
	return destinationInput{Kind: kind, AdapterVersion: version, URL: url}, nil
}

func parseSubscriptions(raw json.RawMessage) ([]subscriptionInput, error) {
	items, err := rawArray(raw, "subscriptions")
	if err != nil {
		return nil, err
	}
	result := make([]subscriptionInput, 0, len(items))
	for _, item := range items {
		fields, err := decodeFields(item, "subscription", "id", "projectId", "eventTypes")
		if err != nil {
			return nil, err
		}
		idRaw, present := fields["id"]
		if !present {
			return nil, httpx.InvalidInput("subscription id is required; use null for a new subscription.")
		}
		var id *string
		if !bytes.Equal(bytes.TrimSpace(idRaw), []byte("null")) {
			value, err := requiredID(fields, "id")
			if err != nil {
				return nil, err
			}
			id = &value
		}
		projectID, err := requiredID(fields, "projectId")
		if err != nil {
			return nil, err
		}
		events, err := stringArray(fields["eventTypes"], "eventTypes")
		if err != nil {
			return nil, err
		}
		result = append(result, subscriptionInput{ID: id, ProjectID: projectID, EventTypes: events})
	}
	return result, nil
}

func rawArray(raw json.RawMessage, field string) ([]json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, httpx.InvalidInput(field + " must be an array.")
	}
	var result []json.RawMessage
	if err := json.Unmarshal(trimmed, &result); err != nil {
		return nil, httpx.InvalidInput(field + " must be an array.")
	}
	return result, nil
}

func stringArray(raw json.RawMessage, field string) ([]string, error) {
	items, err := rawArray(raw, field)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		var value string
		if bytes.Equal(bytes.TrimSpace(item), []byte("null")) || json.Unmarshal(item, &value) != nil {
			return nil, httpx.InvalidInput(field + " must contain only strings.")
		}
		result = append(result, value)
	}
	return result, nil
}

func parseCreate(request *http.Request) (createInput, error) {
	fields, hash, err := decodeConfiguration(request, "operationId", "issuedAt", "expectedUserId", "name", "enabled", "destination", "subscriptions")
	if err != nil {
		return createInput{}, err
	}
	op, err := parseOperation(fields, hash)
	if err != nil {
		return createInput{}, err
	}
	name, err := httpx.RequiredString(fields, "name")
	if err != nil {
		return createInput{}, err
	}
	enabled, err := httpx.OptionalBool(fields, "enabled")
	if err != nil {
		return createInput{}, err
	}
	if enabled == nil {
		return createInput{}, httpx.InvalidInput("enabled is required and must be a boolean.")
	}
	destination, err := parseDestination(fields["destination"])
	if err != nil {
		return createInput{}, err
	}
	subscriptions, err := parseSubscriptions(fields["subscriptions"])
	if err != nil {
		return createInput{}, err
	}
	return createInput{Operation: op, Name: name, Enabled: *enabled, Destination: destination, Subscriptions: subscriptions}, nil
}

func parsePatch(request *http.Request) (patchInput, error) {
	fields, hash, err := decodeConfiguration(request, "operationId", "issuedAt", "expectedUserId", "ifVersion", "name", "enabled", "destination", "subscriptions", "confirmProjectIds")
	if err != nil {
		return patchInput{}, err
	}
	op, err := parseOperation(fields, hash)
	if err != nil {
		return patchInput{}, err
	}
	version, err := versionInput(fields, "ifVersion")
	if err != nil {
		return patchInput{}, err
	}
	name, err := httpx.OptionalString(fields, "name")
	if err != nil {
		return patchInput{}, err
	}
	enabled, err := httpx.OptionalBool(fields, "enabled")
	if err != nil {
		return patchInput{}, err
	}
	result := patchInput{Operation: op, IfVersion: version, Name: name, Enabled: enabled}
	if raw, present := fields["destination"]; present {
		value, err := parseDestination(raw)
		if err != nil {
			return patchInput{}, err
		}
		result.Destination = &value
	}
	if raw, present := fields["subscriptions"]; present {
		value, err := parseSubscriptions(raw)
		if err != nil {
			return patchInput{}, err
		}
		result.Subscriptions = &value
	}
	if raw, present := fields["confirmProjectIds"]; present {
		value, err := stringArray(raw, "confirmProjectIds")
		if err != nil {
			return patchInput{}, err
		}
		for _, id := range value {
			if _, err := canonicalID(id); err != nil {
				return patchInput{}, err
			}
		}
		result.ConfirmProjectIDs = &value
	}
	if result.Name == nil && result.Enabled == nil && result.Destination == nil && result.Subscriptions == nil && result.ConfirmProjectIDs == nil {
		return patchInput{}, httpx.InvalidInput("At least one configuration field is required.")
	}
	return result, nil
}

func parseDelete(request *http.Request) (deleteInput, error) {
	fields, hash, err := decodeConfiguration(request, "operationId", "issuedAt", "expectedUserId", "ifVersion")
	if err != nil {
		return deleteInput{}, err
	}
	op, err := parseOperation(fields, hash)
	if err != nil {
		return deleteInput{}, err
	}
	version, err := versionInput(fields, "ifVersion")
	return deleteInput{Operation: op, IfVersion: version}, err
}

func parseRotation(request *http.Request) (rotationInput, error) {
	fields, hash, err := decodeConfiguration(request, "operationId", "issuedAt", "expectedUserId", "ifVersion", "mode")
	if err != nil {
		return rotationInput{}, err
	}
	op, err := parseOperation(fields, hash)
	if err != nil {
		return rotationInput{}, err
	}
	version, err := versionInput(fields, "ifVersion")
	if err != nil {
		return rotationInput{}, err
	}
	mode, err := httpx.RequiredString(fields, "mode")
	return rotationInput{Operation: op, IfVersion: version, Mode: mode}, err
}
