package monitoring

import (
	"encoding/json"
	"strings"
	"testing"
)

const valid = `{"runId":"eaaa5ee8-828b-4980-a089-2e8cc5be8420","sequence":"1","capturedAt":"2026-01-02T03:04:05+01:00","lifecycle":"running","scheduler":{"phase":"waiting-poll","coverage":"complete","cycleId":null,"lastCompletedAt":null,"lastSuccessfulAt":null,"lastOutcome":null,"nextPollAt":null},"capacity":{"observedAt":"2026-01-02T00:00:00Z","quality":"current","limit":2,"occupied":3,"available":0,"detailCoverage":"complete"},"admission":{"observedAt":"2026-01-02T00:00:00Z","coverage":"complete","reasons":[]},"reservations":[],"activities":[],"currentFailures":[],"lastRecovery":null,"detailCoverage":"complete","delivery":{"lastSucceededAt":null,"lastFailure":null}}`

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

func TestSummaryRejectsPrivateOrMalformedData(t *testing.T) {
	o, err := ParseObservation([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	summary, err := Summary(o)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ParseSummary(summary); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{strings.Replace(string(summary), `"lifecycle":`, `"projectId":"private","lifecycle":`, 1), strings.Replace(string(summary), `"limit":2`, `"limit":null`, 1)} {
		if _, err := ParseSummary([]byte(raw)); err == nil {
			t.Fatalf("accepted corrupt summary %s", raw)
		}
	}
}
