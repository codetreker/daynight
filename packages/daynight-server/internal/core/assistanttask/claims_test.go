package assistanttask

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"testing"
)

func TestClaimFingerprintVector(t *testing.T) {
	bot := "44444444-4444-4444-8444-444444444444"
	version := int64(7)
	actor := Actor{Principal: model.Principal{UserID: "11111111-1111-4111-8111-111111111111"}, BotID: &bot}
	input := ClaimInput{Kind: "claim", TaskID: "22222222-2222-4222-8222-222222222222", OperationID: "33333333-3333-4333-8333-333333333333", IfVersion: &version, ExpectedGeneration: 0, ClaimToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}
	fingerprint, hash, err := ClaimFingerprint(actor, input)
	if err != nil {
		t.Fatal(err)
	}
	if fingerprint != "5844a794f76443253acfeef7df9dd7b04929a37c3494def4f557dd8b33141048" || hash != "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd" {
		t.Fatalf("unexpected fingerprint %s or hash %s", fingerprint, hash)
	}
}
