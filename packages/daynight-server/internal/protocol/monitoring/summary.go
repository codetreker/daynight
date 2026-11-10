package monitoring

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
	"github.com/google/uuid"
)

// reasonCodes is the stable storage index and public ordering for admission reasons.
// Entries cannot be reordered or reused as the stored frame persists their index.
var reasonCodes = [...]string{
	"configuration-unavailable", "configuration-incomplete", "inventory-unavailable",
	"project-unavailable", "project-preparation-failed", "resource-observation-unavailable",
	"capacity-full", "cleanup-capacity-blocked", "no-projects-selected", "no-ready-tasks",
	"claim-unconfirmed", "retained-resource-conflict", "stopping",
}

type StoredReason struct {
	CodeIndex int
	Code      string
	ProjectID string
	TaskID    string
}

type StoredAdmission struct {
	ObservedAt string
	Coverage   string
	Reasons    []StoredReason
}

// StoredSummary is private Redis metadata. base excludes admission so that
// private references cannot be accidentally marshaled as a public summary.
type StoredSummary struct {
	Admission StoredAdmission
	base      map[string]any
}

type SummaryScheduler struct {
	Phase            string  `json:"phase"`
	Coverage         string  `json:"coverage"`
	LastSuccessfulAt *string `json:"lastSuccessfulAt"`
	NextPollAt       *string `json:"nextPollAt"`
}

type SummaryCapacity struct {
	ObservedAt string `json:"observedAt"`
	Quality    string `json:"quality"`
	Limit      int64  `json:"limit"`
	Occupied   int64  `json:"occupied"`
	Available  int64  `json:"available"`
}

type PublicAdmission struct {
	ObservedAt           string   `json:"observedAt"`
	Coverage             string   `json:"coverage"`
	ReasonCodes          []string `json:"reasonCodes"`
	PermissionProjection string   `json:"permissionProjection"`
}

// PublicSummary has no fields for private permission references.
type PublicSummary struct {
	CapturedAt     string           `json:"capturedAt"`
	Lifecycle      string           `json:"lifecycle"`
	Scheduler      SummaryScheduler `json:"scheduler"`
	Capacity       *SummaryCapacity `json:"capacity"`
	DetailCoverage string           `json:"detailCoverage"`
	Admission      PublicAdmission  `json:"admission"`
}

func summarySchema(admission parser) parser {
	return object(map[string]parser{
		"capturedAt":     timestamp,
		"lifecycle":      enum("starting", "running", "stopping", "stopped"),
		"scheduler":      object(map[string]parser{"phase": scheduler, "coverage": coverage, "lastSuccessfulAt": nullable(timestamp), "nextPollAt": nullable(timestamp)}),
		"capacity":       nullable(object(map[string]parser{"observedAt": timestamp, "quality": enum("current", "stale"), "limit": number(1, 64), "occupied": number(0, safeInt), "available": number(0, safeInt)})),
		"detailCoverage": detail,
		"admission":      admission,
	})
}

func summaryValue(raw json.RawMessage, admission parser) (map[string]any, error) {
	if !jsonunicode.Valid(raw) {
		return nil, bad()
	}
	v, err := summarySchema(admission)(raw)
	if err != nil {
		return nil, err
	}
	m := v.(map[string]any)
	if c, ok := m["capacity"].(map[string]any); ok && c["available"].(int64) != max(int64(0), c["limit"].(int64)-c["occupied"].(int64)) {
		return nil, bad()
	}
	return m, nil
}

func reasonIndex(code string) (int, bool) {
	for i, candidate := range reasonCodes {
		if candidate == code {
			return i, true
		}
	}
	return 0, false
}

func storedReason(raw json.RawMessage) (any, error) {
	var tuple []json.RawMessage
	if err := json.Unmarshal(raw, &tuple); err != nil || len(tuple) != 2 {
		return nil, bad()
	}
	// Stored indices are canonical integer literals, not rounded numbers.
	rawIndex := string(tuple[0])
	n, err := strconv.Atoi(rawIndex)
	if err != nil || strconv.Itoa(n) != rawIndex || n < 0 || n >= len(reasonCodes) {
		return nil, bad()
	}
	r := StoredReason{CodeIndex: n, Code: reasonCodes[n]}
	if bytes.Equal(bytes.TrimSpace(tuple[1]), []byte("null")) {
		if n == 3 || n == 4 {
			return nil, bad()
		}
		return r, nil
	}
	var token string
	if err := json.Unmarshal(tuple[1], &token); err != nil {
		return nil, bad()
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || (len(decoded) != 16 && len(decoded) != 32) || base64.RawURLEncoding.EncodeToString(decoded) != token {
		return nil, bad()
	}
	project, err := uuid.FromBytes(decoded[:16])
	if err != nil {
		return nil, bad()
	}
	r.ProjectID = project.String()
	if len(decoded) == 32 {
		task, err := uuid.FromBytes(decoded[16:])
		if err != nil {
			return nil, bad()
		}
		r.TaskID = task.String()
	}
	return r, nil
}

var storedAdmissionSchema = object(map[string]parser{
	"observedAt": timestamp, "coverage": coverage, "reasons": list(storedReason, 16, false),
})

// ParseStoredSummary validates the complete private summary and decodes each
// authorization reference. It never interprets a reference as active ownership.
func ParseStoredSummary(raw json.RawMessage) (StoredSummary, error) {
	m, err := summaryValue(raw, storedAdmissionSchema)
	if err != nil {
		return StoredSummary{}, err
	}
	a := m["admission"].(map[string]any)
	out := StoredSummary{base: m, Admission: StoredAdmission{ObservedAt: a["observedAt"].(string), Coverage: a["coverage"].(string), Reasons: make([]StoredReason, 0, len(a["reasons"].([]any)))}}
	globalCleanup := false
	for _, v := range a["reasons"].([]any) {
		r := v.(StoredReason)
		if r.Code == "no-ready-tasks" && out.Admission.Coverage != "complete" {
			return StoredSummary{}, bad()
		}
		if r.Code == "cleanup-capacity-blocked" && r.ProjectID == "" {
			if globalCleanup {
				return StoredSummary{}, bad()
			}
			globalCleanup = true
		}
		out.Admission.Reasons = append(out.Admission.Reasons, r)
	}
	delete(out.base, "admission")
	return out, nil
}

func encodeScopeToken(scope map[string]any) (any, error) {
	if scope["kind"] == "worker" {
		return nil, nil
	}
	project, err := uuid.Parse(scope["projectId"].(string))
	if err != nil {
		return nil, bad()
	}
	buf := append([]byte(nil), project[:]...)
	if scope["kind"] == "claim" {
		task, err := uuid.Parse(scope["taskId"].(string))
		if err != nil {
			return nil, bad()
		}
		buf = append(buf, task[:]...)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// Summary builds the private stored summary from an already validated observation.
func Summary(o Observation) (json.RawMessage, error) {
	s := o["scheduler"].(map[string]any)
	var c any
	if v, ok := o["capacity"].(map[string]any); ok {
		c = map[string]any{"observedAt": v["observedAt"], "quality": v["quality"], "limit": v["limit"], "occupied": v["occupied"], "available": v["available"]}
	}
	a := o["admission"].(map[string]any)
	reasons := make([]any, 0, len(a["reasons"].([]any)))
	for _, v := range a["reasons"].([]any) {
		r := v.(map[string]any)
		index, ok := reasonIndex(r["code"].(string))
		if !ok {
			return nil, bad()
		}
		token, err := encodeScopeToken(r["scope"].(map[string]any))
		if err != nil {
			return nil, err
		}
		reasons = append(reasons, []any{index, token})
	}
	b, err := json.Marshal(map[string]any{"capturedAt": o["capturedAt"], "lifecycle": o["lifecycle"], "scheduler": map[string]any{"phase": s["phase"], "coverage": s["coverage"], "lastSuccessfulAt": s["lastSuccessfulAt"], "nextPollAt": s["nextPollAt"]}, "capacity": c, "detailCoverage": o["detailCoverage"], "admission": map[string]any{"observedAt": a["observedAt"], "coverage": a["coverage"], "reasons": reasons}})
	if err != nil {
		return nil, fmt.Errorf("encode stored summary: %w", err)
	}
	if _, err := ParseStoredSummary(b); err != nil {
		return nil, err
	}
	return b, nil
}

var publicAdmissionSchema = object(map[string]parser{
	"observedAt": timestamp, "coverage": coverage,
	"reasonCodes": list(reason, 13, true), "permissionProjection": enum("current", "restricted"),
})

// ParsePublicSummary validates the public HTTP summary without accepting private refs.
func ParsePublicSummary(raw json.RawMessage) (PublicSummary, error) {
	m, err := summaryValue(raw, publicAdmissionSchema)
	if err != nil {
		return PublicSummary{}, err
	}
	a := m["admission"].(map[string]any)
	last := -1
	for _, code := range a["reasonCodes"].([]any) {
		index, ok := reasonIndex(code.(string))
		if !ok || index <= last || (code == "no-ready-tasks" && a["coverage"] != "complete") {
			return PublicSummary{}, bad()
		}
		last = index
	}
	b, err := json.Marshal(m)
	if err != nil {
		return PublicSummary{}, err
	}
	var result PublicSummary
	if err := json.Unmarshal(b, &result); err != nil {
		return PublicSummary{}, err
	}
	return result, nil
}

// ParseSummary returns canonical public JSON for HTTP transport.
func ParseSummary(raw json.RawMessage) (json.RawMessage, error) {
	summary, err := ParsePublicSummary(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(summary)
}

// EncodePublicSummary emits only public fields after the caller applies current
// permissions. Codes must be deduplicated and sorted in the stable index order.
func EncodePublicSummary(stored StoredSummary, codes []string, permissionProjection string) (json.RawMessage, error) {
	if stored.base == nil || codes == nil {
		return nil, bad()
	}
	observed := make(map[string]bool, len(stored.Admission.Reasons))
	for _, r := range stored.Admission.Reasons {
		observed[r.Code] = true
	}
	for _, code := range codes {
		if !observed[code] {
			return nil, bad()
		}
	}
	m := make(map[string]any, len(stored.base)+1)
	for k, v := range stored.base {
		m[k] = v
	}
	m["admission"] = map[string]any{"observedAt": stored.Admission.ObservedAt, "coverage": stored.Admission.Coverage, "reasonCodes": codes, "permissionProjection": permissionProjection}
	b, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	return ParseSummary(b)
}
