package webhook

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type unavailableHistoryScope struct {
	store.WebhookReadScope
	reader store.WebhookReader
}

func (s unavailableHistoryScope) WebhookDAO() store.WebhookReader { return s.reader }

type failingPolicyReader struct {
	store.WebhookReader
	err error
}

func (r failingPolicyReader) Policy(context.Context, int64) (wm.Policy, error) {
	return wm.Policy{}, r.err
}

type failedCursorEntropy struct{ err error }

func (r failedCursorEntropy) Read([]byte) (int, error) { return 0, r.err }

func TestHistoryUnavailableDependenciesAreNotEmpty(t *testing.T) {
	failure := errors.New("policy lookup failed")
	scope := unavailableHistoryScope{reader: failingPolicyReader{err: failure}}
	if _, err := historyReader(scope); err == nil {
		t.Fatal("missing required history reader treated as empty")
	}
	if value, err := retention(context.Background(), scope); !errors.Is(err, failure) || value != nil {
		t.Fatalf("policy error not propagated: value=%v error=%v", value, err)
	}
}
func TestHistoryCursorEncodingFailuresAreVisible(t *testing.T) {
	entropy := errors.New("entropy unavailable")
	s := &Service{Keys: keyring(t, "old"), Random: failedCursorEntropy{entropy}}
	c := historyCursor{Version: 1, Kind: "deliveries", User: "user", OwnerKind: "personal", OwnerID: "owner", Endpoint: "endpoint", ID: "delivery", Time: time.Now().UTC()}
	if value, err := s.encodeHistoryCursor(c); !errors.Is(err, entropy) || value != "" {
		t.Fatalf("encryption failure not propagated: cursor=%q error=%v", value, err)
	}
	c.Time = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	if value, err := s.encodeHistoryCursor(c); err == nil || value != "" {
		t.Fatalf("invalid timestamp encoded: cursor=%q error=%v", value, err)
	}
}
