package redis

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
)

// The body and summary satisfy T1's v1 codec; its closed parser and framing
// are pinned by commit d8ac297cbf8fd520b1a1499e90136e73fed76cd1.
func legacyV1Fixture(t *testing.T) (string, store.MonitoringCandidate) {
	t.Helper()
	const input = `{"runId":"10000000-0000-4000-8000-000000000001","sequence":"1","capturedAt":"2026-01-01T00:00:00Z","lifecycle":"running","scheduler":{"phase":"initializing","coverage":"unknown","cycleId":null,"lastCompletedAt":null,"lastSuccessfulAt":null,"lastOutcome":null,"nextPollAt":null},"capacity":null,"admission":{"observedAt":"2026-01-01T00:00:00Z","coverage":"unknown","reasons":[]},"reservations":[],"activities":[],"currentFailures":[],"lastRecovery":null,"detailCoverage":"complete","delivery":{"lastSucceededAt":null,"lastFailure":null}}`
	const summary = `{"capacity":null,"capturedAt":"2026-01-01T00:00:00Z","detailCoverage":"complete","lifecycle":"running","scheduler":{"coverage":"unknown","lastSuccessfulAt":null,"nextPollAt":null,"phase":"initializing"}}`
	o, err := monitoring.ParseObservation([]byte(input))
	if err != nil {
		t.Fatalf("legacy observation: %v", err)
	}
	body, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	legacyHeader := fmt.Sprintf(`{"formatVersion":1,"revision":"20000000-0000-4000-8000-000000000002","runId":"10000000-0000-4000-8000-000000000001","sequence":"1","bodyDigest":"%s","receivedAtMs":1767225600000,"expiresAtMs":1767229200000,"summary":%s}`, hex.EncodeToString(digest[:]), summary)
	return legacyHeader + "\n" + string(body), store.MonitoringCandidate{RunID: o["runId"].(string), Sequence: o["sequence"].(string), Body: body}
}
