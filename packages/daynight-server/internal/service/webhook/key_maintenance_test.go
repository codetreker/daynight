package webhook

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

type maintenanceStore struct {
	items            []store.WebhookCiphertext
	scanErr, swapErr error
	conflict         bool
	saved            []store.WebhookCiphertext
}

func (s *maintenanceStore) WebhookMasterKeyIDs(context.Context) ([]string, error) { return nil, nil }
func (s *maintenanceStore) WebhookCiphertexts(_ context.Context, _ string, _ *store.WebhookCiphertext, limit int) ([]store.WebhookCiphertext, error) {
	if s.scanErr != nil {
		return nil, s.scanErr
	}
	if len(s.items) > limit {
		return s.items[:limit], nil
	}
	return s.items, nil
}
func (s *maintenanceStore) CompareAndSwapWebhookCiphertext(_ context.Context, _ store.WebhookCiphertext, next store.WebhookCiphertext) (bool, error) {
	if s.swapErr != nil {
		return false, s.swapErr
	}
	if s.conflict {
		return false, nil
	}
	s.saved = append(s.saved, next)
	return true, nil
}

func maintenanceRing(t *testing.T, active string, includeOld bool) *secretbox.Keyring {
	t.Helper()
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	old := ""
	if includeOld {
		old = fmt.Sprintf(`,"old":"%s"`, key)
	}
	ring, err := secretbox.Parse([]byte(fmt.Sprintf(`{"activeKeyId":"%s","keys":{"new":"%s"%s}}`, active, key, old)))
	if err != nil {
		t.Fatal(err)
	}
	return ring
}
func TestKeyRewrapPass(t *testing.T) {
	oldKeys := maintenanceRing(t, "old", true)
	keys := maintenanceRing(t, "new", true)
	old := store.WebhookCiphertext{Kind: "endpoint-current", ID: "endpoint", EndpointID: "endpoint", OwnerKind: "personal", OwnerID: "owner", RecordID: "9"}
	binding := []string{old.OwnerKind, old.OwnerID, old.EndpointID, old.Kind, old.RecordID}
	env, err := oldKeys.Seal([]byte("secret-url"), binding, nil)
	if err != nil {
		t.Fatal(err)
	}
	old.Version, old.MasterKeyID, old.Nonce, old.Ciphertext = env.Version, env.MasterKeyID, env.Nonce, env.Ciphertext
	db := &maintenanceStore{items: []store.WebhookCiphertext{old}}
	result, err := (KeyMaintenance{DB: db, Keys: keys}).RewrapPass(context.Background(), "old", 1)
	if err != nil || result.Rewrapped != 1 || result.Examined != 1 || result.Conflicts != 0 {
		t.Fatalf("result %+v %v", result, err)
	}
	c := db.saved[0]
	p, err := keys.Open(secretbox.Envelope{Version: c.Version, MasterKeyID: c.MasterKeyID, Nonce: c.Nonce, Ciphertext: c.Ciphertext}, binding)
	if err != nil || string(p) != "secret-url" || c.MasterKeyID != "new" {
		t.Fatalf("rewrap mismatch: %v", err)
	}
	db.conflict = true
	result, err = (KeyMaintenance{DB: db, Keys: keys}).RewrapPass(context.Background(), "old", 1)
	if err != nil || result.Conflicts != 1 || result.Rewrapped != 0 {
		t.Fatalf("conflict %+v %v", result, err)
	}
	db.conflict = false
	for _, tc := range []struct {
		name    string
		manager KeyMaintenance
		master  string
		limit   int
		target  error
	}{
		{"nil", KeyMaintenance{}, "old", 1, secretbox.ErrMissingKey},
		{"same active", KeyMaintenance{DB: db, Keys: keys}, "new", 1, nil},
		{"zero limit", KeyMaintenance{DB: db, Keys: keys}, "old", 0, nil},
		{"missing key", KeyMaintenance{DB: db, Keys: maintenanceRing(t, "new", false)}, "old", 1, secretbox.ErrMissingKey},
		{"random failure", KeyMaintenance{DB: db, Keys: keys, Random: bytes.NewReader(nil)}, "old", 1, io.EOF},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.manager.RewrapPass(context.Background(), tc.master, tc.limit)
			if err == nil || tc.target != nil && !errors.Is(err, tc.target) {
				t.Fatalf("error %v", err)
			}
		})
	}
	bad := old
	bad.Ciphertext = append([]byte(nil), old.Ciphertext...)
	bad.Ciphertext[0] ^= 1
	db.items = []store.WebhookCiphertext{bad}
	_, err = (KeyMaintenance{DB: db, Keys: keys}).RewrapPass(context.Background(), "old", 1)
	if !errors.Is(err, secretbox.ErrAuthentication) {
		t.Fatalf("authentication %v", err)
	}
	db.items = []store.WebhookCiphertext{old}
	cause := errors.New("failure")
	db.scanErr = cause
	_, err = (KeyMaintenance{DB: db, Keys: keys}).RewrapPass(context.Background(), "old", 1)
	if !errors.Is(err, cause) {
		t.Fatalf("scan %v", err)
	}
	db.scanErr = nil
	db.swapErr = cause
	_, err = (KeyMaintenance{DB: db, Keys: keys}).RewrapPass(context.Background(), "old", 1)
	if !errors.Is(err, cause) {
		t.Fatalf("swap %v", err)
	}
}
