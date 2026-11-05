package sessionprotocol

import (
	"bytes"
	"encoding/json"
	"regexp"
	"slices"
	"time"
)

type validator func(json.RawMessage) bool
type schema map[string]validator

func validateObject(data json.RawMessage, fields schema) bool {
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(data, &raw)
	if _, fenced := fields["claimId"]; fenced {
		if _, test := raw["testExecutionId"]; test && fields["sessionId"] != nil {
			fields = extend(fields, schema{"testExecutionId": identifier})
			delete(fields, "claimId")
		}
	}
	for _, name := range []string{"cleanupInteractionIds", "controls", "turnStartedAt"} {
		if _, supported := fields[name]; supported && raw[name] == nil {
			fields = extend(fields, schema{})
			delete(fields, name)
		}
	}

	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	decoded, err := object(data, keys...)
	if err != nil {
		return false
	}
	for key, validate := range fields {
		if !validate(decoded[key]) {
			return false
		}
	}
	return true
}
func nested(fields schema) validator {
	return func(data json.RawMessage) bool { return validateObject(data, fields) }
}
func extend(base schema, extra schema) schema {
	out := make(schema, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}
func null(data json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(data), []byte("null")) }
func optional(validate validator) validator {
	return func(data json.RawMessage) bool { return null(data) || validate(data) }
}
func boolean(data json.RawMessage) bool {
	v := string(bytes.TrimSpace(data))
	return v == "true" || v == "false"
}
func text(data json.RawMessage) bool      { return stringValue(data, false, maxTextBytes) }
func emptyText(data json.RawMessage) bool { return stringValue(data, true, maxTextBytes) }
func key(data json.RawMessage) bool       { return stringValue(data, false, 256) }

// Relay transport strings may contain whitespace, unlike user-visible labels.
func relayString(limit int) validator {
	return func(data json.RawMessage) bool { return stringValue(data, true, limit) && len(stringField(data)) > 0 }
}
func identifier(data json.RawMessage) bool   { return uuidPattern.MatchString(stringField(data)) }
func sequence(data json.RawMessage) bool     { return positiveSequence(stringField(data)) }
func zeroSequence(data json.RawMessage) bool { return stringField(data) == "0" || sequence(data) }
func enum(values ...string) validator {
	return func(data json.RawMessage) bool { return slices.Contains(values, stringField(data)) }
}
func number(data json.RawMessage) bool {
	var n float64
	return !null(data) && json.Unmarshal(data, &n) == nil
}
func version(data json.RawMessage) bool {
	var n float64
	return json.Unmarshal(data, &n) == nil && n == 1
}
func timestamp(data json.RawMessage) bool {
	_, err := time.Parse(time.RFC3339Nano, stringField(data))
	return relayString(256)(data) && err == nil
}
func pattern(expression string) validator {
	r := regexp.MustCompile(expression)
	return func(data json.RawMessage) bool { return r.MatchString(stringField(data)) }
}
func many(validate validator, min, max int, identity string) validator {
	return func(data json.RawMessage) bool {
		values, err := array(data)
		if err != nil || len(values) < min || len(values) > max {
			return false
		}
		seen := map[string]bool{}
		for _, value := range values {
			if !validate(value) {
				return false
			}
			if identity != "" {
				var unique string
				if identity == "$" {
					unique = stringField(value)
				} else {
					var fields map[string]json.RawMessage
					_ = json.Unmarshal(value, &fields)
					unique = stringField(fields[identity])
				}
				if seen[unique] {
					return false
				}
				seen[unique] = true
			}
		}
		return true
	}
}

var fenceSchema = schema{"sessionId": identifier, "claimId": identifier, "executionGeneration": sequence}
var capabilitiesSchema = schema{"send": boolean, "steer": boolean, "cancel": boolean, "respond": boolean}
var initialState = enum("not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "unknown", "not_required")
var activity = enum("initializing", "idle", "working", "waiting_input", "stopped", "unknown")
var errorSchema = schema{"code": key, "message": text}
var providerResult = optional(enum("started", "queued", "handled"))

func decode[T any](data []byte, validate validator) (T, error) {
	var value T
	if !validUnicode(data) || !validate(data) {
		return value, errInvalid
	}
	if json.Unmarshal(data, &value) != nil {
		return value, errInvalid
	}
	return value, nil
}

// Versions are JSON numbers, unlike decimal-string execution fences. Normalize
// equivalent numeric spellings after validation before decoding Go int fields.
func decodeVersioned[T any](data []byte, fields schema) (T, error) {
	var value T
	if !validUnicode(data) || !validateObject(data, fields) {
		return value, errInvalid
	}
	var normalized map[string]json.RawMessage
	_ = json.Unmarshal(data, &normalized)
	normalized["schemaVersion"] = json.RawMessage("1")
	normalized["projectionVersion"] = json.RawMessage("1")
	canonical, _ := json.Marshal(normalized)
	if json.Unmarshal(canonical, &value) != nil {
		return value, errInvalid
	}
	return value, nil
}
