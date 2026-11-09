package monitoring

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
	"github.com/google/uuid"
)

const MaxBody = 256 * 1024
const MaxDetail = 512 * 1024
const MaxQuery = 256 * 1024

type Observation map[string]any
type Receipt = store.MonitoringReceipt

type DetailResponse struct {
	ObservedAt           time.Time   `json:"observedAt"`
	State                string      `json:"state"`
	Revision             *string     `json:"revision"`
	RunID                *string     `json:"runId"`
	Sequence             *string     `json:"sequence"`
	ReceivedAt           *time.Time  `json:"receivedAt"`
	ExpiresAt            *time.Time  `json:"expiresAt"`
	Data                 Observation `json:"data"`
	DetailCoverage       string      `json:"detailCoverage"`
	PermissionProjection string      `json:"permissionProjection"`
}
type QueryItem struct {
	WorkerID   string          `json:"workerId"`
	State      string          `json:"state"`
	Revision   *string         `json:"revision"`
	ReceivedAt *time.Time      `json:"receivedAt"`
	ExpiresAt  *time.Time      `json:"expiresAt"`
	Summary    json.RawMessage `json:"summary"`
}
type QueryResponse struct {
	ObservedAt time.Time   `json:"observedAt"`
	Items      []QueryItem `json:"items"`
}

type parser func(json.RawMessage) (any, error)

func bad() error {
	return &model.Fault{Code: "invalid_input", Message: "Invalid worker monitoring observation."}
}
func object(fields map[string]parser) parser {
	return func(raw json.RawMessage) (any, error) {
		keys := make([]string, 0, len(fields))
		for k := range fields {
			keys = append(keys, k)
		}
		values, err := jsonobject.Decode(raw, "observation", keys...)
		if err != nil || len(values) != len(fields) {
			return nil, bad()
		}
		out := make(map[string]any, len(fields))
		for k, p := range fields {
			v, e := p(values[k])
			if e != nil {
				return nil, e
			}
			out[k] = v
		}
		return out, nil
	}
}
func nullable(p parser) parser {
	return func(raw json.RawMessage) (any, error) {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil, nil
		}
		return p(raw)
	}
}
func list(p parser, max int, unique bool) parser {
	return func(raw json.RawMessage) (any, error) {
		var a []json.RawMessage
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &a) != nil || len(a) > max {
			return nil, bad()
		}
		out := make([]any, 0, len(a))
		seen := map[string]bool{}
		for _, v := range a {
			x, e := p(v)
			if e != nil {
				return nil, e
			}
			if unique {
				s, ok := x.(string)
				if !ok || seen[s] {
					return nil, bad()
				}
				seen[s] = true
			}
			out = append(out, x)
		}
		return out, nil
	}
}
func enum(values ...string) parser {
	return func(raw json.RawMessage) (any, error) {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return nil, bad()
		}
		for _, v := range values {
			if s == v {
				return s, nil
			}
		}
		return nil, bad()
	}
}
func text(max int) parser {
	return func(raw json.RawMessage) (any, error) {
		var s string
		if json.Unmarshal(raw, &s) != nil || len(s) == 0 || len(s) > max {
			return nil, bad()
		}
		return s, nil
	}
}
func id(raw json.RawMessage) (any, error) {
	s, e := text(36)(raw)
	if e != nil {
		return nil, e
	}
	v := s.(string)
	parsed, e := uuid.Parse(v)
	if e != nil || parsed.String() != v {
		return nil, bad()
	}
	return v, nil
}

var timestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$`)

func timestamp(raw json.RawMessage) (any, error) {
	s, e := text(MaxBody)(raw)
	if e != nil {
		return nil, e
	}
	if !timestampPattern.MatchString(s.(string)) {
		return nil, bad()
	}
	v, e := time.Parse(time.RFC3339Nano, strings.ToUpper(s.(string)))
	if e != nil {
		return nil, bad()
	}
	v = v.UTC()
	if v.Year() < 0 || v.Year() > 9999 {
		return nil, bad()
	}
	return v.Format(time.RFC3339Nano), nil
}

// JSON numbers are admitted by exact integer value, including decimal and exponent forms.
// Compare decimal digits before conversion to avoid rounding values near 2^53.
var numberPattern = regexp.MustCompile(`^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$`)

func number(min, max int64) parser {
	return func(raw json.RawMessage) (any, error) {
		parts := numberPattern.FindStringSubmatch(strings.TrimSpace(string(raw)))
		if parts == nil {
			return nil, bad()
		}
		digits := strings.TrimLeft(parts[2]+parts[3], "0")
		if digits == "" {
			if min > 0 {
				return nil, bad()
			}
			return int64(0), nil
		}
		if parts[1] == "-" {
			return nil, bad()
		}
		var exponent int64
		if parts[4] != "" {
			var err error
			exponent, err = strconv.ParseInt(parts[4], 10, 64)
			if err != nil {
				return nil, bad()
			}
		}
		// More than the input limit's digits cannot change a nonzero value into a
		// safe integer, and the bound keeps the following arithmetic finite.
		if exponent > MaxBody || exponent < -MaxBody {
			return nil, bad()
		}
		scale := exponent - int64(len(parts[3]))
		trimmed := strings.TrimRight(digits, "0")
		scale += int64(len(digits) - len(trimmed))
		digits = trimmed
		if scale < 0 || scale > 16 || int64(len(digits))+scale > 16 {
			return nil, bad()
		}
		n, err := strconv.ParseInt(digits+strings.Repeat("0", int(scale)), 10, 64)
		if err != nil || n < min || n > max {
			return nil, bad()
		}
		return n, nil
	}
}
func boolean(raw json.RawMessage) (any, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("true")) {
		return true, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("false")) {
		return false, nil
	}
	return nil, bad()
}
func sequence(raw json.RawMessage) (any, error) {
	s, e := text(19)(raw)
	if e != nil {
		return nil, e
	}
	v := s.(string)
	n, e := strconv.ParseInt(v, 10, 64)
	if e != nil || n <= 0 || strconv.FormatInt(n, 10) != v {
		return nil, bad()
	}
	return v, nil
}

var coverage = enum("unknown", "complete", "partial")
var detail = enum("complete", "partial")
var scheduler = enum("initializing", "configuration", "inventory", "project-preparation", "resource-observation", "reconciliation", "claim-search", "claim-request", "archive-backfill", "waiting-poll", "stopping", "stopped")
var execution = enum("observation", "worktree-preparation", "agent-start", "agent-observation", "input-submission", "preparing", "executing", "verifying", "completing", "waiting", "paused")
var cleanup = enum("observation", "agent-stop", "backend-close", "archive", "worktree-removal")
var reason = enum("configuration-unavailable", "configuration-incomplete", "inventory-unavailable", "project-unavailable", "project-preparation-failed", "resource-observation-unavailable", "capacity-full", "cleanup-capacity-blocked", "no-projects-selected", "no-ready-tasks", "claim-unconfirmed", "retained-resource-conflict", "stopping")
var wait = enum("native-input", "retry-backoff", "task-paused", "resource-stop", "operation-lock", "recovery-blocked", "initializing", "unknown")
var phaseDelivery = enum("read", "write", "reconcile", "shutdown")

const safeInt int64 = 9007199254740991

func scope(raw json.RawMessage) (any, error) {
	var f map[string]json.RawMessage
	if json.Unmarshal(raw, &f) != nil {
		return nil, bad()
	}
	var kind string
	_ = json.Unmarshal(f["kind"], &kind)
	switch kind {
	case "worker":
		return object(map[string]parser{"kind": enum("worker")})(raw)
	case "project":
		return object(map[string]parser{"kind": enum("project"), "projectId": id})(raw)
	case "claim":
		return object(map[string]parser{"kind": enum("claim"), "projectId": id, "taskId": id, "claimId": id})(raw)
	}
	return nil, bad()
}

// Diagnostic text is a fixed protocol vocabulary, not an exception message.
var diagnosticCauses = map[string]string{
	"cancelled":                  "The operation was cancelled.",
	"timeout":                    "The operation timed out.",
	"authentication-required":    "Authentication is required.",
	"limit-exceeded":             "An operation limit was exceeded.",
	"rate-limited":               "The operation was rate limited.",
	"permission-denied":          "Permission was denied.",
	"not-found-or-inaccessible":  "A required resource was not found or is inaccessible.",
	"not-found":                  "A required resource was not found.",
	"conflict":                   "The operation encountered a conflict.",
	"unavailable":                "A required service or resource is unavailable.",
	"invalid-response":           "The response was invalid.",
	"resource-exhausted":         "A required resource was exhausted.",
	"configuration-missing":      "Required configuration is missing.",
	"configuration-invalid":      "The configuration is invalid.",
	"command-failed":             "A required command failed.",
	"io-error":                   "A required I/O operation failed.",
	"invalid-output":             "A required operation produced invalid output.",
	"recovery-limit":             "The recovery limit was reached.",
	"native-identity-missing":    "The original native execution identity is missing.",
	"worktree-validation-failed": "The worktree failed ownership validation.",
	"branch-mismatch":            "The worktree branch does not match the recorded owner.",
	"recovery-blocked":           "Recovery is blocked and needs attention.",
	"outcome-unknown":            "The operation outcome is unknown.",
	"unknown":                    "The operation failed; inspect local Worker diagnostics for details.",
}

func structured(raw json.RawMessage) (any, error) {
	value, err := object(map[string]parser{"type": enum("operation"), "code": text(64), "cause": text(2048), "causeTruncated": boolean})(raw)
	if err != nil {
		return nil, err
	}
	fields := value.(map[string]any)
	expected, ok := diagnosticCauses[fields["code"].(string)]
	if !ok || fields["cause"] != expected || fields["causeTruncated"] != false {
		return nil, bad()
	}
	return value, nil
}

func admissionReason(raw json.RawMessage) (any, error) {
	v, e := object(map[string]parser{"code": reason, "scope": scope, "observedAt": timestamp, "nextAttemptAt": nullable(timestamp)})(raw)
	if e != nil {
		return nil, e
	}
	m := v.(map[string]any)
	if (m["code"] == "project-unavailable" || m["code"] == "project-preparation-failed") && m["scope"].(map[string]any)["kind"] == "worker" {
		return nil, bad()
	}
	return v, nil
}

func reservationID(raw json.RawMessage) (any, error) {
	value, err := id(raw)
	if err != nil {
		return nil, err
	}
	parsed, err := uuid.Parse(value.(string))
	if err != nil || parsed.Version() != 4 || parsed.Variant() != uuid.RFC4122 {
		return nil, bad()
	}
	return value, nil
}

var reservation = object(map[string]parser{"reservationId": reservationID, "scope": scope, "roles": list(enum("active-task", "resource-owner", "unresolved", "cleanup", "pending-stop"), 5, true), "occupied": boolean, "observedAt": timestamp})

func activity(raw json.RawMessage) (any, error) {
	var f map[string]json.RawMessage
	if json.Unmarshal(raw, &f) != nil {
		return nil, bad()
	}
	var kind string
	_ = json.Unmarshal(f["kind"], &kind)
	var phase parser
	switch kind {
	case "execution":
		phase = execution
	case "cleanup":
		phase = cleanup
	case "maintenance":
		phase = scheduler
	default:
		return nil, bad()
	}
	return object(map[string]parser{"kind": enum(kind), "phase": phase, "operationId": id, "status": enum("queued", "running", "waiting", "paused"), "scope": scope, "startedAt": timestamp, "lastProgressAt": nullable(timestamp), "elapsedMs": number(0, safeInt), "deadlineAt": nullable(timestamp), "waitReason": nullable(wait), "nextAttemptAt": nullable(timestamp)})(raw)
}
func failure(raw json.RawMessage) (any, error) {
	var f map[string]json.RawMessage
	if json.Unmarshal(raw, &f) != nil {
		return nil, bad()
	}
	var component string
	_ = json.Unmarshal(f["component"], &component)
	var phase parser
	switch component {
	case "runtime", "scheduler", "inventory", "project", "resources", "configuration", "archive":
		phase = scheduler
	case "execution":
		phase = execution
	case "cleanup":
		phase = cleanup
	case "monitoring":
		phase = phaseDelivery
	default:
		return nil, bad()
	}
	v, e := object(map[string]parser{"operationId": id, "component": enum(component), "phase": phase, "scope": scope, "error": structured, "firstObservedAt": timestamp, "lastObservedAt": timestamp, "occurrencesInRun": number(0, safeInt), "retryState": enum("none", "scheduled", "running", "manual"), "nextAttemptAt": nullable(timestamp)})(raw)
	if e != nil {
		return nil, e
	}
	m := v.(map[string]any)
	if component == "project" && m["scope"].(map[string]any)["kind"] == "worker" {
		return nil, bad()
	}
	if (m["retryState"] == "scheduled") != (m["nextAttemptAt"] != nil) {
		return nil, bad()
	}
	return v, nil
}

func recovery(raw json.RawMessage) (any, error) {
	value, err := object(map[string]parser{"operationId": id, "component": enum("runtime", "scheduler", "configuration", "inventory", "project", "resources", "execution", "cleanup", "archive", "monitoring"), "scope": scope, "observedAt": timestamp, "explanation": enum("The operation recovered."), "explanationTruncated": boolean})(raw)
	if err != nil {
		return nil, err
	}
	fields := value.(map[string]any)
	if fields["explanationTruncated"] != false || fields["component"] == "project" && fields["scope"].(map[string]any)["kind"] == "worker" {
		return nil, bad()
	}
	return value, nil
}

var deliveryFailure = object(map[string]parser{"observedAt": timestamp, "phase": phaseDelivery, "error": structured, "requestId": nullable(id)})
var schedulerObject = object(map[string]parser{"phase": scheduler, "coverage": coverage, "cycleId": nullable(id), "lastCompletedAt": nullable(timestamp), "lastSuccessfulAt": nullable(timestamp), "lastOutcome": nullable(enum("completed", "failed", "cancelled")), "nextPollAt": nullable(timestamp)})
var capacity = object(map[string]parser{"observedAt": timestamp, "quality": enum("current", "stale"), "limit": number(1, 64), "occupied": number(0, safeInt), "available": number(0, safeInt), "detailCoverage": detail})
var observation = object(map[string]parser{"runId": id, "sequence": sequence, "capturedAt": timestamp, "lifecycle": enum("starting", "running", "stopping", "stopped"), "scheduler": schedulerObject, "capacity": nullable(capacity), "admission": object(map[string]parser{"observedAt": timestamp, "coverage": coverage, "reasons": list(admissionReason, 16, false)}), "reservations": list(reservation, 128, false), "activities": list(activity, 128, false), "currentFailures": list(failure, 32, false), "lastRecovery": nullable(recovery), "detailCoverage": detail, "delivery": object(map[string]parser{"lastSucceededAt": nullable(timestamp), "lastFailure": nullable(deliveryFailure)})})

func ParseObservation(raw json.RawMessage) (Observation, error) {
	if len(raw) > MaxBody {
		return nil, &model.Fault{Code: "payload_too_large", Message: "Monitoring observation exceeds its input limit."}
	}
	if !jsonunicode.Valid(raw) {
		return nil, bad()
	}
	v, e := observation(raw)
	if e != nil {
		return nil, e
	}
	o := Observation(v.(map[string]any))
	if c, ok := o["capacity"].(map[string]any); ok {
		limit, occupied, available := c["limit"].(int64), c["occupied"].(int64), c["available"].(int64)
		want := max(int64(0), limit-occupied)
		if available != want {
			return nil, bad()
		}
	}
	admission := o["admission"].(map[string]any)
	globalCleanup := false
	for _, r := range admission["reasons"].([]any) {
		reason := r.(map[string]any)
		if reason["code"] == "no-ready-tasks" && admission["coverage"] != "complete" {
			return nil, bad()
		}
		if reason["code"] == "cleanup-capacity-blocked" && reason["scope"].(map[string]any)["kind"] == "worker" {
			if globalCleanup || reason["observedAt"] != admission["observedAt"] || reason["nextAttemptAt"] != nil {
				return nil, bad()
			}
			globalCleanup = true
		}
	}
	reservations := map[string]bool{}
	for _, r := range o["reservations"].([]any) {
		m := r.(map[string]any)
		reservationID := m["reservationId"].(string)
		if len(m["roles"].([]any)) == 0 || reservations[reservationID] {
			return nil, bad()
		}
		reservations[reservationID] = true
	}
	b, e := json.Marshal(o)
	if e != nil {
		return nil, bad()
	}
	if len(b) > MaxBody {
		return nil, &model.Fault{Code: "payload_too_large", Message: "Monitoring observation exceeds its encoded limit."}
	}
	return o, nil
}
func Summary(o Observation) (json.RawMessage, error) {
	s := o["scheduler"].(map[string]any)
	var c any
	if v, ok := o["capacity"].(map[string]any); ok {
		c = map[string]any{"observedAt": v["observedAt"], "quality": v["quality"], "limit": v["limit"], "occupied": v["occupied"], "available": v["available"]}
	}
	b, e := json.Marshal(map[string]any{"capturedAt": o["capturedAt"], "lifecycle": o["lifecycle"], "scheduler": map[string]any{"phase": s["phase"], "coverage": s["coverage"], "lastSuccessfulAt": s["lastSuccessfulAt"], "nextPollAt": s["nextPollAt"]}, "capacity": c, "detailCoverage": o["detailCoverage"]})
	if e != nil {
		return nil, fmt.Errorf("encode summary: %w", e)
	}
	return b, nil
}

// ParseSummary rejects corrupt or private fields before a stored summary is exposed.
func ParseSummary(raw json.RawMessage) (json.RawMessage, error) {
	if !jsonunicode.Valid(raw) {
		return nil, bad()
	}
	schema := object(map[string]parser{
		"capturedAt":     timestamp,
		"lifecycle":      enum("starting", "running", "stopping", "stopped"),
		"scheduler":      object(map[string]parser{"phase": scheduler, "coverage": coverage, "lastSuccessfulAt": nullable(timestamp), "nextPollAt": nullable(timestamp)}),
		"capacity":       nullable(object(map[string]parser{"observedAt": timestamp, "quality": enum("current", "stale"), "limit": number(1, 64), "occupied": number(0, safeInt), "available": number(0, safeInt)})),
		"detailCoverage": detail,
	})
	value, err := schema(raw)
	if err != nil {
		return nil, err
	}
	m := value.(map[string]any)
	if c, ok := m["capacity"].(map[string]any); ok && c["available"].(int64) != max(int64(0), c["limit"].(int64)-c["occupied"].(int64)) {
		return nil, bad()
	}
	return json.Marshal(value)
}
