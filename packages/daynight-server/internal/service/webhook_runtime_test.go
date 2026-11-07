package service

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

type rewrapFailureStore struct{ scanErr, pageErr error }

func (s rewrapFailureStore) WebhookMasterKeyIDs(context.Context) ([]string, error) {
	return []string{"old"}, s.scanErr
}
func (s rewrapFailureStore) WebhookCiphertexts(context.Context, string, *store.WebhookCiphertext, int) ([]store.WebhookCiphertext, error) {
	return nil, s.pageErr
}
func (s rewrapFailureStore) CompareAndSwapWebhookCiphertext(context.Context, store.WebhookCiphertext, store.WebhookCiphertext) (bool, error) {
	panic("unexpected CAS")
}

func TestWebhookRewrapBoundedTimeoutAndPermanentFailure(t *testing.T) {
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"new","keys":{"new":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","old":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}`))
	if err != nil {
		t.Fatal(err)
	}
	permanent := errors.New("permanent database error")
	for _, tc := range []struct {
		name string
		db   rewrapFailureStore
		want error
	}{
		{"scan deadline", rewrapFailureStore{scanErr: fmt.Errorf("scan: %w", context.DeadlineExceeded)}, nil},
		{"batch deadline", rewrapFailureStore{pageErr: fmt.Errorf("batch: %w", context.DeadlineExceeded)}, nil},
		{"scan failure", rewrapFailureStore{scanErr: permanent}, permanent},
		{"batch failure", rewrapFailureStore{pageErr: permanent}, permanent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := webhookRuntime{keys: webhook.KeyMaintenance{DB: tc.db, Keys: keys}}
			if err := w.rewrap(context.Background()); !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}
