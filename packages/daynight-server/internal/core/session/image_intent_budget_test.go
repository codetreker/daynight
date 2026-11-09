package session

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestPersistentIntentBudgetUsesCanonicalBytesBeforeWriting(t *testing.T) {
	command := sp.Command{SessionID: "session", OperationID: "operation", Kind: "send_message", Payload: encode(map[string]string{"text": ""})}
	base, err := canonicalIntent(command)
	if err != nil {
		t.Fatal(err)
	}
	for _, extra := range []int{0, 1} {
		command.Payload = encode(map[string]string{"text": strings.Repeat("x", maxSessionIntentBytes-len(base)+extra)})
		dao := &imageIntentDAO{}
		err := persistIntent(t.Context(), &operationTx{dao: dao}, command)
		if extra == 0 {
			if err != nil || len(dao.raw) != maxSessionIntentBytes {
				t.Fatalf("exact canonical budget rejected: %d %v", len(dao.raw), err)
			}
		} else {
			var refusal *model.Fault
			if !errors.As(err, &refusal) || refusal.Code != "quota_exceeded" || dao.raw != nil {
				t.Fatalf("oversized intent reached storage: %d %v", len(dao.raw), err)
			}
		}
	}
	dao := &imageIntentDAO{session: command.SessionID, id: command.OperationID, raw: []byte(strings.Repeat("x", maxSessionIntentBytes+1))}
	if _, _, err := persistedIntent(t.Context(), &operationTx{dao: dao}, command.SessionID, command.OperationID); err == nil {
		t.Fatal("oversized persisted intent accepted")
	}
}
