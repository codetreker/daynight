package webhook

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

// KeyMaintenance replaces envelope bytes without changing business versions or
// plaintext. A runtime keyring has a fixed active key for its entire life.
type KeyMaintenance struct {
	DB     store.WebhookKeyMaintenance
	Keys   *secretbox.Keyring
	Random io.Reader
}

type KeyRewrapResult struct{ Examined, Rewrapped, Conflicts int }

// RewrapPass visits at most limit candidates for one old master. Conflicts are
// deliberately left for a later scan; a concurrent deletion is never recreated.
func (m KeyMaintenance) RewrapPass(ctx context.Context, oldMaster string, limit int) (KeyRewrapResult, error) {
	var result KeyRewrapResult
	if m.DB == nil || m.Keys == nil {
		return result, secretbox.ErrMissingKey
	}
	if oldMaster == "" || oldMaster == m.Keys.ActiveKeyID() || limit < 1 || limit > 500 {
		return result, fmt.Errorf("invalid webhook rewrap request")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	candidates, err := m.DB.WebhookCiphertexts(ctx, oldMaster, nil, limit)
	if err != nil {
		return result, fmt.Errorf("scan webhook rewrap candidates: %w", err)
	}
	for _, old := range candidates {
		if err := ctx.Err(); err != nil {
			return result, fmt.Errorf("webhook rewrap deadline: %w", err)
		}
		result.Examined++
		if old.MasterKeyID != oldMaster {
			return result, fmt.Errorf("invalid webhook rewrap candidate")
		}
		binding := []string{old.OwnerKind, old.OwnerID, old.EndpointID, old.Kind, old.RecordID}
		plain, err := m.Keys.Open(secretbox.Envelope{Version: old.Version, MasterKeyID: old.MasterKeyID, Nonce: old.Nonce, Ciphertext: old.Ciphertext}, binding)
		if err != nil {
			return result, fmt.Errorf("open webhook rewrap candidate: %w", err)
		}
		wrapped, err := m.Keys.Seal(plain, binding, m.Random)
		clear(plain)
		if err != nil {
			return result, fmt.Errorf("seal webhook rewrap candidate: %w", err)
		}
		next := old
		next.Version, next.MasterKeyID, next.Nonce, next.Ciphertext = wrapped.Version, wrapped.MasterKeyID, wrapped.Nonce, wrapped.Ciphertext
		changed, err := m.DB.CompareAndSwapWebhookCiphertext(ctx, old, next)
		if err != nil {
			return result, fmt.Errorf("replace webhook rewrap candidate: %w", err)
		}
		if changed {
			result.Rewrapped++
		} else {
			result.Conflicts++
		}
	}
	return result, nil
}
