package monitoring

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

const valid = `{"runId":"eaaa5ee8-828b-4980-a089-2e8cc5be8420","sequence":"1","capturedAt":"2026-01-02T03:04:05+01:00","lifecycle":"running","scheduler":{"phase":"waiting-poll","coverage":"complete","cycleId":null,"lastCompletedAt":null,"lastSuccessfulAt":null,"lastOutcome":null,"nextPollAt":null},"capacity":{"observedAt":"2026-01-02T00:00:00Z","quality":"current","limit":2,"occupied":3,"available":0,"detailCoverage":"complete"},"admission":{"observedAt":"2026-01-02T00:00:00Z","coverage":"complete","reasons":[]},"reservations":[],"activities":[],"currentFailures":[],"lastRecovery":null,"detailCoverage":"complete","delivery":{"lastSucceededAt":null,"lastFailure":null}}`

func TestCapacityBreakdownContract(t *testing.T) {
	for _, breakdown := range []string{"", `,"breakdown":{"active":1,"retained":2}`} {
		raw := strings.Replace(valid, `"occupied":3`, `"occupied":3`+breakdown, 1)
		o, err := ParseObservation([]byte(raw))
		if err != nil {
			t.Fatalf("parse %s: %v", breakdown, err)
		}
		summary, err := Summary(o)
		if err != nil {
			t.Fatal(err)
		}
		stored, err := ParseStoredSummary(summary)
		if err != nil {
			t.Fatal(err)
		}
		public, err := EncodePublicSummary(stored, []string{}, "current")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(public), `"breakdown"`) != (breakdown != "") {
			t.Fatalf("presence changed: %s", public)
		}
	}
	for _, breakdown := range []string{`null`, `{}`, `{"active":1}`, `{"active":1,"retained":1}`, `{"active":-1,"retained":4}`, `{"active":1.5,"retained":1.5}`, `{"active":1,"retained":2,"extra":0}`, `{"active":9007199254740991,"retained":9007199254740991}`} {
		raw := strings.Replace(valid, `"occupied":3`, `"occupied":3,"breakdown":`+breakdown, 1)
		if _, err := ParseObservation([]byte(raw)); err == nil {
			t.Errorf("accepted %s", breakdown)
		}
	}
}

func TestParseObservationClosedAndCanonical(t *testing.T) {
	o, err := ParseObservation([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	if o["capturedAt"] != "2026-01-02T02:04:05Z" {
		t.Fatalf("timestamp: %v", o["capturedAt"])
	}
	summary, err := Summary(o)
	if err != nil || !json.Valid(summary) {
		t.Fatalf("summary: %s %v", summary, err)
	}
	for _, tc := range []struct{ name, from, to string }{
		{"unknown", "\"lifecycle\":\"running\"", "\"extra\":true,\"lifecycle\":\"running\""},
		{"duplicate", "\"lifecycle\":\"running\"", "\"lifecycle\":\"running\",\"lifecycle\":\"running\""},
		{"required", "\"lastOutcome\":null,", ""},
		{"null integer", "\"limit\":2", "\"limit\":null"},
		{"capacity arithmetic", "\"available\":0", "\"available\":1"},
		{"sequence zero", "\"sequence\":\"1\"", "\"sequence\":\"0\""},
		{"sequence leading zero", "\"sequence\":\"1\"", "\"sequence\":\"01\""},
		{"sequence overflow", "\"sequence\":\"1\"", "\"sequence\":\"9223372036854775808\""},
		{"uuid uppercase", "eaaa5ee8-828b-4980-a089-2e8cc5be8420", "EAAA5EE8-828b-4980-a089-2e8cc5be8420"},
		{"enum", "\"phase\":\"waiting-poll\"", "\"phase\":\"arbitrary\""},
		{"null array", "\"activities\":[]", "\"activities\":null"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseObservation([]byte(strings.Replace(valid, tc.from, tc.to, 1))); err == nil {
				t.Fatal("accepted invalid observation")
			}
		})
	}
}

func TestFailureWorktreeContract(t *testing.T) {
	const scope = `{"kind":"claim","projectId":"10000000-0000-4000-8000-000000000001","taskId":"10000000-0000-4000-8000-000000000002","claimId":"10000000-0000-4000-8000-000000000003"}`
	const failure = `{"operationId":"10000000-0000-4000-8000-000000000003","component":"cleanup","phase":"archive","scope":` + scope + `,"error":{"type":"operation","code":"unknown","cause":"The operation failed; inspect local Worker diagnostics for details.","causeTruncated":false},"firstObservedAt":"2026-01-01T00:00:00Z","lastObservedAt":"2026-01-01T00:00:00Z","occurrencesInRun":1,"retryState":"none","nextAttemptAt":null%s}`
	parse := func(fields string) (Observation, error) {
		raw := strings.Replace(valid, `"currentFailures":[]`, `"currentFailures":[`+fmt.Sprintf(failure, fields)+`]`, 1)
		return ParseObservation([]byte(raw))
	}
	for _, value := range []any{
		nil,
		map[string]any{"kind": "project-relative", "path": "."},
		map[string]any{"kind": "project-relative", "path": "../../other/工作 tree/<>&"},
		map[string]any{"kind": "project-relative", "path": strings.Repeat("é", 2048)},
		map[string]any{"kind": "unavailable", "reason": "different-volume"},
		map[string]any{"kind": "unavailable", "reason": "invalid-path"},
		map[string]any{"kind": "unavailable", "reason": "limit-exceeded"},
	} {
		fields := ""
		if value != nil {
			b, _ := json.Marshal(value)
			fields = `,"worktree":` + string(b)
		}
		got, err := parse(fields)
		if err != nil {
			t.Fatalf("valid %s: %v", fields, err)
		}
		f := got["currentFailures"].([]any)[0].(map[string]any)
		if _, present := f["worktree"]; present != (value != nil) {
			t.Fatalf("presence changed: %v", f)
		}
	}
	for _, fields := range []string{
		`,"worktree":null`, `,"worktree":{}`, `,"worktree":{"kind":"other"}`,
		`,"worktree":{"kind":"unavailable","reason":"other"}`,
		`,"worktree":{"kind":"unavailable","reason":"invalid-path","extra":1}`,
		`,"worktree":{"kind":"project-relative","path":"x","path":"y"}`,
		`,"worktree":{"kind":"project-relative","path":"\ud800"}`,
	} {
		if _, err := parse(fields); err == nil {
			t.Errorf("accepted %s", fields)
		}
	}
	for _, path := range []string{"", "/a", "//host/share", `C:relative`, `c:/absolute`, `a\b`, "a//b", "a/", "./a", "a/./b", "a/../b", "..//x", "a\x00b", "a\u007fb", "a\u0085b", strings.Repeat("é", 2048) + "x"} {
		b, _ := json.Marshal(map[string]string{"kind": "project-relative", "path": path})
		if _, err := parse(`,"worktree":` + string(b)); err == nil {
			t.Errorf("accepted invalid path %q", path)
		}
	}
	for _, replacement := range []string{`{"kind":"worker"}`, `{"kind":"project","projectId":"10000000-0000-4000-8000-000000000001"}`} {
		raw := strings.Replace(valid, `"currentFailures":[]`, `"currentFailures":[`+fmt.Sprintf(failure, `,"worktree":{"kind":"unavailable","reason":"invalid-path"}`)+`]`, 1)
		if _, err := ParseObservation([]byte(strings.Replace(raw, scope, replacement, 1))); err == nil {
			t.Errorf("accepted worktree with scope %s", replacement)
		}
	}
}

func TestSummaryRejectsPrivateOrMalformedData(t *testing.T) {
	o, err := ParseObservation([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	summary, err := Summary(o)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := ParseStoredSummary(summary)
	if err != nil {
		t.Fatal(err)
	}
	public, err := EncodePublicSummary(stored, []string{}, "current")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ParseSummary(public); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{strings.Replace(string(public), `"lifecycle":`, `"projectId":"private","lifecycle":`, 1), strings.Replace(string(public), `"limit":2`, `"limit":null`, 1), string(summary)} {
		if _, err := ParseSummary([]byte(raw)); err == nil {
			t.Fatalf("accepted corrupt summary %s", raw)
		}
	}
}

func TestDirectObservationContract(t *testing.T) {
	legacy := detailed(t)
	delete(legacy, "runId")
	delete(legacy, "sequence")
	encode := func() []byte {
		t.Helper()
		raw, err := json.Marshal(legacy)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	for _, phase := range []string{"write", "shutdown"} {
		legacy["delivery"].(map[string]any)["lastFailure"].(map[string]any)["phase"] = phase
		o, err := ParseDirectObservation(encode())
		if err != nil {
			t.Fatalf("phase %s: %v", phase, err)
		}
		wrapped := LegacyObservationForDirect(o, "10000000-0000-4000-8000-000000000001")
		if wrapped["runId"] != "10000000-0000-4000-8000-000000000001" || wrapped["sequence"] != "1" || o["runId"] != nil || wrapped["capturedAt"] != o["capturedAt"] {
			t.Fatalf("invalid envelope: %#v", wrapped)
		}
		b, _ := json.Marshal(wrapped)
		if _, err := ParseStoredObservation(b); err != nil {
			t.Fatal(err)
		}
	}
	for _, phase := range []string{"read", "reconcile"} {
		legacy["delivery"].(map[string]any)["lastFailure"].(map[string]any)["phase"] = phase
		if _, err := ParseDirectObservation(encode()); err == nil {
			t.Fatalf("direct accepted phase %s", phase)
		}
		wrapped := LegacyObservationForDirect(DirectObservation(legacy), "10000000-0000-4000-8000-000000000001")
		b, _ := json.Marshal(wrapped)
		if _, err := ParseObservation(b); err != nil {
			t.Fatalf("legacy phase %s: %v", phase, err)
		}
	}
	legacy["delivery"].(map[string]any)["lastFailure"].(map[string]any)["phase"] = "write"
	failure := legacy["currentFailures"].([]any)[0].(map[string]any)
	failure["component"], failure["phase"] = "monitoring", "read"
	if _, err := ParseDirectObservation(encode()); err == nil {
		t.Fatal("direct accepted monitoring read failure")
	}
	failure["phase"] = "shutdown"
	if _, err := ParseDirectObservation(encode()); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		strings.Replace(string(encode()), `"lifecycle":`, `"runId":"10000000-0000-4000-8000-000000000001","lifecycle":`, 1),
		strings.Replace(string(encode()), `"lifecycle":`, `"sequence":"1","lifecycle":`, 1),
		strings.Replace(string(encode()), `"lifecycle":`, `"expectedRevision":null,"lifecycle":`, 1),
		strings.Replace(string(encode()), `"lifecycle":`, `"lifecycle":"running","lifecycle":`, 1),
	} {
		if _, err := ParseDirectObservation([]byte(raw)); err == nil {
			t.Fatal("accepted unknown or duplicate field")
		}
	}
}

func TestDirectStoredEnvelopeBudget(t *testing.T) {
	o := detailed(t)
	o["capturedAt"] = "2026-01-02T02:04:05Z"
	delete(o, "runId")
	delete(o, "sequence")
	base := o["currentFailures"].([]any)[0].(map[string]any)
	failures := make([]any, 32)
	for i := range failures {
		f := make(map[string]any, len(base)+1)
		for k, v := range base {
			f[k] = v
		}
		f["worktree"] = map[string]any{"kind": "project-relative", "path": strings.Repeat("x", 4000)}
		failures[i] = f
	}
	o["currentFailures"] = failures
	raw, _ := json.Marshal(o)
	remaining := MaxBody - len(raw)
	if remaining < 0 {
		t.Fatal("fixture too large")
	}
	for _, item := range failures {
		path := item.(map[string]any)["worktree"].(map[string]any)
		n := min(4000, remaining/5)
		remaining -= n * 5
		path["path"] = strings.Repeat("<", n) + strings.Repeat("x", 4000-n)
	}
	if remaining > 96 {
		t.Fatalf("fixture cannot reach limit, remaining %d", remaining)
	}
	path := failures[0].(map[string]any)["worktree"].(map[string]any)
	path["path"] = path["path"].(string) + strings.Repeat("x", remaining)
	raw, _ = json.Marshal(o)
	if len(raw) != MaxBody {
		t.Fatalf("size %d", len(raw))
	}
	direct, err := ParseDirectObservation(raw)
	if err != nil {
		t.Fatal(err)
	}
	wrapped := LegacyObservationForDirect(direct, "10000000-0000-4000-8000-000000000001")
	stored, _ := json.Marshal(wrapped)
	if len(stored) != MaxStoredBody {
		t.Fatalf("stored size %d", len(stored))
	}
	if _, err := ParseStoredObservation(stored); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseObservation(stored); err == nil {
		t.Fatal("legacy HTTP accepted private allowance")
	}
	expanded := strings.Replace(string(raw), `\u003c`, `<<`, 1)
	if len(expanded) >= MaxBody {
		t.Fatal("fixture must fit raw limit")
	}
	if _, err := ParseDirectObservation([]byte(expanded)); err == nil {
		t.Fatal("direct accepted oversized canonical encoding")
	}
	if _, err := ParseDirectObservation(append(raw, ' ')); err == nil {
		t.Fatal("direct accepted oversized input")
	}
	if _, err := ParseStoredObservation(append(stored, ' ')); err == nil {
		t.Fatal("stored accepted oversized body")
	}
}
