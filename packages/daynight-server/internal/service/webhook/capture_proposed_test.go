package webhook

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func TestCaptureAcceptsProposedFactsBeforeAudienceSelection(t *testing.T) {
	for _, kind := range []string{protocol.Created, protocol.StatusChanged} {
		for _, subscribed := range []bool{false, true} {
			t.Run(kind+"/"+map[bool]string{false: "unsubscribed", true: "subscribed"}[subscribed], func(t *testing.T) {
				fact := captureFact(kind)
				fact.Status = "proposed"
				var dao *captureDAOMock
				if subscribed {
					dao = captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, kind)}, 1)
				} else {
					dao = newCaptureDAOMock(t, "freeze")
					dao.freeze = func(context.Context, string, []string) ([]store.WebhookAudience, error) { return nil, nil }
				}
				if err := (&Capturer{Random: &captureEntropy{}}).CaptureBatch(t.Context(), dao, []protocol.Fact{fact}); err != nil {
					t.Fatal(err)
				}
				if !subscribed {
					if len(dao.writes) != 0 {
						t.Fatal("unsubscribed proposed fact was persisted")
					}
					return
				}
				if len(dao.writes) != 1 || len(dao.writes[0].deliveries) != 1 {
					t.Fatalf("subscribed proposed fact was not captured: %+v", dao.writes)
				}
				_, persisted, err := protocol.Decode(dao.writes[0].event.FactBytes)
				if err != nil || persisted.Status != "proposed" || persisted.PreviousStatus != fact.PreviousStatus {
					t.Fatalf("captured proposed status changed: %+v %v", persisted, err)
				}
			})
		}
	}
}
