package api

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBotRecoveryReceiptKeepsExactVersionsAndExplicitNulls(t *testing.T) {
	raw, err := json.Marshal(BotRecoveryResult{Receipt: BotRecoveryReceipt{BotRecoveryVersion: 1, HostingGeneration: 9007199254740993, BotVersion: 9223372036854775807}})
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"hostingGeneration":"9007199254740993"`, `"botVersion":"9223372036854775807"`, `"nativeSessionId":null`, `"grantExpiresAt":null`, `"controllerTokenHash":null`, `"current":false`} {
		if !strings.Contains(string(raw), field) {
			t.Fatalf("missing %s in %s", field, raw)
		}
	}
	var out map[string]json.RawMessage
	if err = json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	var receipt map[string]json.RawMessage
	if err = json.Unmarshal(out["receipt"], &receipt); err != nil {
		t.Fatal(err)
	}
	if len(receipt) != 14 || receipt["recoveryIdentity"] != nil || receipt["controllerToken"] != nil {
		t.Fatalf("unexpected receipt fields: %s", raw)
	}
}
