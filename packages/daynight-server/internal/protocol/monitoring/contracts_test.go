package monitoring

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const testID = "eaaa5ee8-828b-4980-a089-2e8cc5be8420"
const testTime = "2026-01-02T00:00:00Z"

func detailed(t *testing.T) map[string]any {
	t.Helper()
	var o map[string]any
	if err := json.Unmarshal([]byte(valid), &o); err != nil {
		t.Fatal(err)
	}
	scope := map[string]any{"kind": "claim", "projectId": testID, "taskId": testID, "claimId": testID}
	failure := map[string]any{"operationId": testID, "component": "cleanup", "phase": "archive", "scope": scope, "error": map[string]any{"type": "operation", "code": "timeout", "cause": "The operation timed out.", "causeTruncated": false}, "firstObservedAt": testTime, "lastObservedAt": testTime, "occurrencesInRun": 1, "retryState": "scheduled", "nextAttemptAt": testTime}
	o["currentFailures"] = []any{failure}
	o["lastRecovery"] = map[string]any{"operationId": testID, "component": "cleanup", "scope": scope, "observedAt": testTime, "explanation": "The operation recovered.", "explanationTruncated": false}
	o["delivery"].(map[string]any)["lastFailure"] = map[string]any{"observedAt": testTime, "phase": "write", "error": map[string]any{"type": "operation", "code": "timeout", "cause": "The operation timed out.", "causeTruncated": false}, "requestId": testID}
	o["reservations"] = []any{map[string]any{"reservationId": testID, "scope": scope, "roles": []any{"resource-owner", "cleanup"}, "occupied": true, "observedAt": testTime}}
	o["activities"] = []any{map[string]any{"operationId": testID, "kind": "cleanup", "phase": "archive", "status": "running", "scope": scope, "startedAt": testTime, "lastProgressAt": nil, "elapsedMs": 0, "deadlineAt": nil, "waitReason": nil, "nextAttemptAt": nil}}
	return o
}
func parseValue(t *testing.T, o map[string]any) error {
	t.Helper()
	raw, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	_, err = ParseObservation(raw)
	return err
}
func failureData(o map[string]any) map[string]any {
	return o["currentFailures"].([]any)[0].(map[string]any)
}
func diagnostic(o map[string]any) map[string]any { return failureData(o)["error"].(map[string]any) }
func checkInvalid(t *testing.T, o map[string]any) {
	t.Helper()
	if err := parseValue(t, o); err == nil {
		t.Fatal("accepted invalid observation")
	}
}

func TestFixedDiagnosticContract(t *testing.T) {
	// This table is an independent wire oracle shared by failure and delivery fields.
	cases := []struct{ code, cause string }{
		{"cancelled", "The operation was cancelled."}, {"timeout", "The operation timed out."},
		{"authentication-required", "Authentication is required."}, {"limit-exceeded", "An operation limit was exceeded."},
		{"rate-limited", "The operation was rate limited."}, {"permission-denied", "Permission was denied."},
		{"not-found-or-inaccessible", "A required resource was not found or is inaccessible."}, {"not-found", "A required resource was not found."},
		{"conflict", "The operation encountered a conflict."}, {"unavailable", "A required service or resource is unavailable."},
		{"invalid-response", "The response was invalid."}, {"resource-exhausted", "A required resource was exhausted."},
		{"configuration-missing", "Required configuration is missing."}, {"configuration-invalid", "The configuration is invalid."},
		{"command-failed", "A required command failed."}, {"io-error", "A required I/O operation failed."},
		{"invalid-output", "A required operation produced invalid output."}, {"recovery-limit", "The recovery limit was reached."},
		{"native-identity-missing", "The original native execution identity is missing."}, {"worktree-validation-failed", "The worktree failed ownership validation."},
		{"branch-mismatch", "The worktree branch does not match the recorded owner."}, {"recovery-blocked", "Recovery is blocked and needs attention."},
		{"outcome-unknown", "The operation outcome is unknown."}, {"unknown", "The operation failed; inspect local Worker diagnostics for details."},
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			o := detailed(t)
			d := diagnostic(o)
			d["code"] = tc.code
			d["cause"] = tc.cause
			delivery := o["delivery"].(map[string]any)["lastFailure"].(map[string]any)["error"].(map[string]any)
			delivery["code"] = tc.code
			delivery["cause"] = tc.cause
			if err := parseValue(t, o); err != nil {
				t.Fatal(err)
			}
			d["cause"] = tc.cause + " secret"
			checkInvalid(t, o)
		})
	}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"unknown code", func(o map[string]any) { diagnostic(o)["code"] = "private" }},
		{"wrong type", func(o map[string]any) { diagnostic(o)["type"] = "network" }},
		{"truncated", func(o map[string]any) { diagnostic(o)["causeTruncated"] = true }},
		{"unknown field", func(o map[string]any) { diagnostic(o)["details"] = "secret" }},
		{"missing flag", func(o map[string]any) { delete(diagnostic(o), "causeTruncated") }},
		{"delivery wrong cause", func(o map[string]any) {
			o["delivery"].(map[string]any)["lastFailure"].(map[string]any)["error"].(map[string]any)["cause"] = "secret"
		}},
		{"recovery text", func(o map[string]any) { o["lastRecovery"].(map[string]any)["explanation"] = "secret" }},
		{"recovery truncated", func(o map[string]any) { o["lastRecovery"].(map[string]any)["explanationTruncated"] = true }},
		{"request arbitrary", func(o map[string]any) {
			o["delivery"].(map[string]any)["lastFailure"].(map[string]any)["requestId"] = "token"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) { o := detailed(t); tc.change(o); checkInvalid(t, o) })
	}
}

func TestScopeAndAdmissionRules(t *testing.T) {
	if err := parseValue(t, detailed(t)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"project failure worker scope", func(o map[string]any) {
			f := failureData(o)
			f["component"] = "project"
			f["phase"] = "project-preparation"
			f["scope"] = map[string]any{"kind": "worker"}
		}},
		{"project recovery worker scope", func(o map[string]any) {
			r := o["lastRecovery"].(map[string]any)
			r["component"] = "project"
			r["scope"] = map[string]any{"kind": "worker"}
		}},
		{"project reason worker scope", func(o map[string]any) {
			o["admission"].(map[string]any)["reasons"] = []any{map[string]any{"code": "project-unavailable", "scope": map[string]any{"kind": "worker"}, "observedAt": testTime, "nextAttemptAt": nil}}
		}},
		{"no-ready with partial", func(o map[string]any) {
			a := o["admission"].(map[string]any)
			a["coverage"] = "partial"
			a["reasons"] = []any{map[string]any{"code": "no-ready-tasks", "scope": map[string]any{"kind": "worker"}, "observedAt": testTime, "nextAttemptAt": nil}}
		}},
		{"wrong phase", func(o map[string]any) { failureData(o)["phase"] = "executing" }},
		{"scheduled without time", func(o map[string]any) { failureData(o)["nextAttemptAt"] = nil }},
		{"unscheduled with time", func(o map[string]any) { failureData(o)["retryState"] = "manual" }},
		{"unknown scope field", func(o map[string]any) {
			o["activities"].([]any)[0].(map[string]any)["scope"].(map[string]any)["private"] = "secret"
		}},
		{"invalid activity phase", func(o map[string]any) { o["activities"].([]any)[0].(map[string]any)["phase"] = "executing" }},
		{"missing scope id", func(o map[string]any) {
			delete(o["activities"].([]any)[0].(map[string]any)["scope"].(map[string]any), "claimId")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) { o := detailed(t); tc.change(o); checkInvalid(t, o) })
	}
	global := func() map[string]any {
		return map[string]any{"code": "cleanup-capacity-blocked", "scope": map[string]any{"kind": "worker"}, "observedAt": testTime, "nextAttemptAt": nil}
	}
	t.Run("global cleanup", func(t *testing.T) {
		o := detailed(t)
		a := o["admission"].(map[string]any)
		a["reasons"] = []any{global()}
		if err := parseValue(t, o); err != nil {
			t.Fatal(err)
		}
		a["reasons"] = []any{global(), global()}
		checkInvalid(t, o)
	})
	t.Run("global cleanup time", func(t *testing.T) {
		o := detailed(t)
		a := o["admission"].(map[string]any)
		r := global()
		r["observedAt"] = "2026-01-03T00:00:00Z"
		a["reasons"] = []any{r}
		checkInvalid(t, o)
	})
	t.Run("global cleanup retry", func(t *testing.T) {
		o := detailed(t)
		a := o["admission"].(map[string]any)
		r := global()
		r["nextAttemptAt"] = testTime
		a["reasons"] = []any{r}
		checkInvalid(t, o)
	})
}

func TestReservationIdentityAndCollectionLimits(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"not uuid", func(o map[string]any) {
			o["reservations"].([]any)[0].(map[string]any)["reservationId"] = "/home/private"
		}},
		{"uuid version", func(o map[string]any) {
			o["reservations"].([]any)[0].(map[string]any)["reservationId"] = "eaaa5ee8-828b-1980-a089-2e8cc5be8420"
		}},
		{"uuid variant", func(o map[string]any) {
			o["reservations"].([]any)[0].(map[string]any)["reservationId"] = "eaaa5ee8-828b-4980-0089-2e8cc5be8420"
		}},
		{"duplicate id", func(o map[string]any) { r := o["reservations"].([]any); o["reservations"] = append(r, r[0]) }},
		{"empty roles", func(o map[string]any) { o["reservations"].([]any)[0].(map[string]any)["roles"] = []any{} }},
		{"duplicate roles", func(o map[string]any) {
			o["reservations"].([]any)[0].(map[string]any)["roles"] = []any{"cleanup", "cleanup"}
		}},
		{"unknown role", func(o map[string]any) { o["reservations"].([]any)[0].(map[string]any)["roles"] = []any{"other"} }},
		{"too many activities", func(o map[string]any) {
			a := o["activities"].([]any)[0]
			all := make([]any, 129)
			for i := range all {
				all[i] = a
			}
			o["activities"] = all
		}},
		{"too many failures", func(o map[string]any) {
			f := o["currentFailures"].([]any)[0]
			all := make([]any, 33)
			for i := range all {
				all[i] = f
			}
			o["currentFailures"] = all
		}},
	} {
		t.Run(tc.name, func(t *testing.T) { o := detailed(t); tc.change(o); checkInvalid(t, o) })
	}
}

func TestNumericAndEncodingBoundaries(t *testing.T) {
	for _, tc := range []struct {
		value string
		good  bool
	}{{"0", true}, {"-0", true}, {"1.0", true}, {"1e2", true}, {"100e-2", true}, {"9007199254740991", true}, {"9007199254740992", false}, {"9007199254740991.1", false}, {"-1", false}, {"1e9999999999999999", false}, {"1e-1", false}, {"null", false}, {"01", false}} {
		t.Run(tc.value, func(t *testing.T) {
			_, err := number(0, safeInt)(json.RawMessage(tc.value))
			if (err == nil) != tc.good {
				t.Fatalf("number %s: %v", tc.value, err)
			}
		})
	}
	for _, v := range []string{"2026-01-02T03:04:05+24:00", "2026-01-02T03:04:05+00:60", "2026-01-02T03:04:05,1Z", "2026-02-30T00:00:00Z"} {
		t.Run(v, func(t *testing.T) {
			if _, err := ParseObservation([]byte(strings.Replace(valid, "2026-01-02T03:04:05+01:00", v, 1))); err == nil {
				t.Fatal("invalid timestamp accepted")
			}
		})
	}
	raw := []byte(valid + strings.Repeat(" ", MaxBody-len(valid)+1))
	_, err := ParseObservation(raw)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "payload_too_large" {
		t.Fatalf("oversize: %v", err)
	}
	for _, text := range []string{fmt.Sprintf(`{"extra":%q}`, strings.Repeat("x", 50)), `"\ud800"`} {
		if _, err := ParseObservation([]byte(text)); err == nil {
			t.Fatalf("accepted invalid input %s", text)
		}
	}
}

func TestComponentsAndActivityPhases(t *testing.T) {
	for _, tc := range []struct{ component, phase string }{
		{"runtime", "initializing"}, {"scheduler", "waiting-poll"}, {"inventory", "inventory"}, {"project", "project-preparation"},
		{"resources", "resource-observation"}, {"configuration", "configuration"}, {"archive", "archive-backfill"},
		{"execution", "executing"}, {"cleanup", "worktree-removal"}, {"monitoring", "reconcile"},
	} {
		t.Run(tc.component, func(t *testing.T) {
			o := detailed(t)
			f := failureData(o)
			f["component"], f["phase"] = tc.component, tc.phase
			if err := parseValue(t, o); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, tc := range []struct{ kind, phase string }{{"execution", "executing"}, {"cleanup", "worktree-removal"}, {"maintenance", "reconciliation"}} {
		t.Run(tc.kind, func(t *testing.T) {
			o := detailed(t)
			a := o["activities"].([]any)[0].(map[string]any)
			a["kind"], a["phase"] = tc.kind, tc.phase
			if err := parseValue(t, o); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"unknown component", func(o map[string]any) { failureData(o)["component"] = "other" }},
		{"bad component type", func(o map[string]any) { failureData(o)["component"] = 17 }},
		{"unknown activity kind", func(o map[string]any) { o["activities"].([]any)[0].(map[string]any)["kind"] = "other" }},
		{"unknown scope kind", func(o map[string]any) {
			o["activities"].([]any)[0].(map[string]any)["scope"] = map[string]any{"kind": "other"}
		}},
		{"non-object activity", func(o map[string]any) { o["activities"] = []any{true} }},
		{"non-object failure", func(o map[string]any) { o["currentFailures"] = []any{17} }},
		{"non-object scope", func(o map[string]any) { o["activities"].([]any)[0].(map[string]any)["scope"] = []any{} }},
		{"bool null", func(o map[string]any) { o["reservations"].([]any)[0].(map[string]any)["occupied"] = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) { o := detailed(t); tc.change(o); checkInvalid(t, o) })
	}
	t.Run("project scope", func(t *testing.T) {
		o := detailed(t)
		failureData(o)["scope"] = map[string]any{"kind": "project", "projectId": testID}
		if err := parseValue(t, o); err != nil {
			t.Fatal(err)
		}
	})
}

func TestCollectionMaximums(t *testing.T) {
	t.Run("reasons", func(t *testing.T) {
		o := detailed(t)
		a := o["admission"].(map[string]any)
		r := map[string]any{"code": "no-projects-selected", "scope": map[string]any{"kind": "worker"}, "observedAt": testTime, "nextAttemptAt": nil}
		items := make([]any, 16)
		for i := range items {
			items[i] = r
		}
		a["reasons"] = items
		if err := parseValue(t, o); err != nil {
			t.Fatal(err)
		}
		a["reasons"] = append(items, r)
		checkInvalid(t, o)
	})
	t.Run("reservations", func(t *testing.T) {
		o := detailed(t)
		r := o["reservations"].([]any)[0].(map[string]any)
		items := make([]any, 128)
		for i := range items {
			item := make(map[string]any, len(r))
			for k, v := range r {
				item[k] = v
			}
			item["reservationId"] = fmt.Sprintf("%08x-828b-4980-a089-2e8cc5be8420", i)
			items[i] = item
		}
		o["reservations"] = items
		if err := parseValue(t, o); err != nil {
			t.Fatal(err)
		}
		o["reservations"] = append(items, items[0])
		checkInvalid(t, o)
	})
	t.Run("activities", func(t *testing.T) {
		o := detailed(t)
		a := o["activities"].([]any)[0]
		items := make([]any, 128)
		for i := range items {
			items[i] = a
		}
		o["activities"] = items
		if err := parseValue(t, o); err != nil {
			t.Fatal(err)
		}
		o["activities"] = append(items, a)
		checkInvalid(t, o)
	})
	t.Run("failures", func(t *testing.T) {
		o := detailed(t)
		f := o["currentFailures"].([]any)[0]
		items := make([]any, 32)
		for i := range items {
			items[i] = f
		}
		o["currentFailures"] = items
		if err := parseValue(t, o); err != nil {
			t.Fatal(err)
		}
		o["currentFailures"] = append(items, f)
		checkInvalid(t, o)
	})
}

func TestTimestampNormalizationKeepsRFC3339(t *testing.T) {
	value := "2026-01-02T03:04:05." + strings.Repeat("1", 140) + "Z"
	raw := strings.Replace(valid, "2026-01-02T03:04:05+01:00", value, 1)
	observation, err := ParseObservation([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if observation["capturedAt"] != "2026-01-02T03:04:05.111111111Z" {
		t.Fatalf("timestamp %v", observation["capturedAt"])
	}
	for _, value := range []string{"0000-01-01T00:00:00+23:00", "9999-12-31T23:59:59-23:00"} {
		raw := strings.Replace(valid, "2026-01-02T03:04:05+01:00", value, 1)
		if _, err := ParseObservation([]byte(raw)); err == nil {
			t.Fatalf("UTC timestamp outside RFC3339 years accepted: %s", value)
		}
	}
}
