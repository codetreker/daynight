package session

import (
	"context"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type mediaOfferFenceDAO struct {
	*imageRuleDAO
	queried []sp.Fence
}

func (d *mediaOfferFenceDAO) PendingSessionMediaRequests(ctx context.Context, fence sp.Fence) ([]store.SessionMediaRequest, error) {
	d.queried = append(d.queried, fence)
	return d.imageRuleDAO.PendingSessionMediaRequests(ctx, fence)
}

func TestMediaOffersPassCurrentExecutionFenceAndRebindOnlyConnectionEpoch(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	f.r.Snapshot.ConnectionEpoch = "2"
	current := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: uuid.NewString(), Action: "prepare", Fence: f.r.Snapshot.ControllerFence, Body: []byte(`{}`)}
	current.Fence.ConnectionEpoch = "1"
	stale := current
	stale.RequestID, stale.Fence.ExecutionGeneration = uuid.NewString(), "0"
	f.d.media[current.RequestID], f.d.media[stale.RequestID] = current, stale
	d := &mediaOfferFenceDAO{imageRuleDAO: f.d}
	offers, err := f.s.mediaOffers(t.Context(), &operationTx{dao: d}, f.r)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.queried) != 1 || d.queried[0] != f.r.Snapshot.Fence {
		t.Fatal("pending offer query did not receive the exact current execution fence", d.queried)
	}
	if len(offers) != 1 || offers[0]["requestId"] != current.RequestID {
		t.Fatal("same-generation reconnect did not receive its original request", offers)
	}
	if rebound := f.d.media[current.RequestID]; rebound.Fence != f.r.Snapshot.ControllerFence || rebound.Complete || string(rebound.Body) != "{}" {
		t.Fatal("reconnect changed the original request instead of its connection epoch", rebound)
	}
	if retained := f.d.media[stale.RequestID]; retained.Fence != stale.Fence || retained.Complete || retained.Result != nil || retained.Error != nil {
		t.Fatal("current offer selection changed an older generation's unknown record", retained)
	}
}
