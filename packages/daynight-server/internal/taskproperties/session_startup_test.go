package taskproperties

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSessionStartupIsStrictAndReadOnly(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"source":"worker","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"1","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"1","observedAt":"2026-11-05T00:00:00Z","startup":{"state":"unknown","reasonCode":"native_timeout"},"recovery":{"state":"blocked","reasonCode":"native_identity_missing"}}`)
	if _, err := NormalizeValue("sessionStartup", raw, false); err != nil {
		t.Fatalf("valid startup evidence rejected: %v", err)
	}
	if _, err := NormalizeValue("sessionStartup", raw, true); err == nil {
		t.Fatal("ordinary property writes can forge startup evidence")
	}
}

func TestSessionStartupRejectsMalformedAndInconsistentReports(t *testing.T) {
	const valid = `{"schemaVersion":1,"source":"worker","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"1","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"1","observedAt":"2026-11-05T00:00:00Z","startup":{"state":"unknown","reasonCode":"native_timeout"},"recovery":{"state":"blocked","reasonCode":"native_identity_missing"}}`
	for _, change := range [][2]string{
		{`"schemaVersion":1`, `"schemaVersion":2`}, {`"source":"worker"`, `"source":"controller"`},
		{`"revision":"1"`, `"revision":"0"`}, {`"revision":"1"`, `"revision":"9223372036854775808"`},
		{`"executionGeneration":"1"`, `"executionGeneration":"01"`},
		{`"state":"unknown"`, `"state":"failed"`}, {`"state":"blocked"`, `"state":"none"`},
		{`"reasonCode":"native_identity_missing"`, `"reasonCode":null`},
		{`"native_timeout"`, `"private raw error"`},
		{`2026-11-05T00:00:00Z`, `2026-02-30T00:00:00Z`},
		{`2026-11-05T00:00:00Z`, `2026-11-05T00:00:00+00:00`},
		{`2026-11-05T00:00:00Z`, `2026-11-05T00:00:00,123Z`},
		{`2026-11-05T00:00:00Z`, `2026-11-05T00:00:00.1234567890Z`},
		{`"claimId":"22222222-2222-4222-8222-222222222222"`, `"testExecutionId":"22222222-2222-4222-8222-222222222222"`},
		{`"source":"worker"`, `"source":"worker","rawError":"private"`},
		{`"source":"worker"`, `"source":"worker","source":"worker"`},
	} {
		raw := strings.Replace(valid, change[0], change[1], 1)
		if _, err := NormalizeValue("sessionStartup", json.RawMessage(raw), false); err == nil {
			t.Errorf("accepted %s", change[1])
		}
	}
}

func TestSessionStartupVersionNumbersAndReasonCombinations(t *testing.T) {
	const base = `{"schemaVersion":1e0,"source":"worker","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"9223372036854775807","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"9223372036854775807","observedAt":"2026-11-05T00:00:00.123456789Z","startup":{"state":"unknown","reasonCode":"native_timeout"},"recovery":{"state":"none","reasonCode":null}}`
	for _, state := range []string{`"state":"starting","reasonCode":"initializing"`, `"state":"ready","reasonCode":"ready"`, `"state":"failed","reasonCode":"native_rejected"`, `"state":"failed","reasonCode":"controller_launch_failed"`, `"state":"unknown","reasonCode":"evidence_missing"`, `"state":"unknown","reasonCode":"native_transport_unknown"`, `"state":"unknown","reasonCode":"controller_start_unknown"`} {
		raw := strings.Replace(base, `"state":"unknown","reasonCode":"native_timeout"`, state, 1)
		if _, err := NormalizeValue("sessionStartup", json.RawMessage(raw), false); err != nil {
			t.Errorf("valid combination rejected: %s: %v", state, err)
		}
	}
}
