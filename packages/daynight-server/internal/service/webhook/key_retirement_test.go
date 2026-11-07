package webhook

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type retirementDB struct {
	ids      []string
	err      error
	identity store.WebhookRecoveryIdentity
}

func (d *retirementDB) WebhookMasterKeyIDs(context.Context) ([]string, error) { return d.ids, d.err }
func (d *retirementDB) WebhookCiphertexts(context.Context, string, *store.WebhookCiphertext, int) ([]store.WebhookCiphertext, error) {
	return nil, d.err
}
func (d *retirementDB) CompareAndSwapWebhookCiphertext(context.Context, store.WebhookCiphertext, store.WebhookCiphertext) (bool, error) {
	return false, d.err
}
func (d *retirementDB) WebhookCiphertextByID(context.Context, string, string) (*store.WebhookCiphertext, error) {
	return nil, d.err
}

func (d *retirementDB) OpenWebhookRecoverySnapshot(context.Context) (store.WebhookRecoverySnapshot, error) {
	return d, d.err
}
func (d *retirementDB) RecoveryIdentity(context.Context) (store.WebhookRecoveryIdentity, error) {
	return d.identity, d.err
}
func (d *retirementDB) Close(context.Context) error { return nil }

type retirementInventoryTest struct {
	producers                  []ProducerObservation
	backups                    []RecoverySnapshot
	producerError, backupError error
	changed                    bool
	producerReads, backupReads int
}

func (i *retirementInventoryTest) Producers(context.Context) ([]ProducerObservation, error) {
	i.producerReads++
	if i.changed && i.producerReads > 1 {
		return nil, nil
	}
	return i.producers, i.producerError
}
func (i *retirementInventoryTest) Backups(context.Context) ([]RecoverySnapshot, error) {
	i.backupReads++
	return i.backups, i.backupError
}

func TestRetirementNeedsAuthoritativeEvidence(t *testing.T) {
	ctx := context.Background()
	done := make(chan struct{})
	close(done)
	running := make(chan struct{})
	keys := maintenanceRing(t, "new", true)
	live := &retirementDB{identity: store.WebhookRecoveryIdentity{ClusterID: "unit", DatabaseOID: 3}}
	source := &retirementDB{identity: store.WebhookRecoveryIdentity{ClusterID: "unit", DatabaseOID: 1}}
	restored := &retirementDB{identity: store.WebhookRecoveryIdentity{ClusterID: "unit", DatabaseOID: 2}}
	valid := func() *retirementInventoryTest {
		return &retirementInventoryTest{producers: []ProducerObservation{{ID: "one", ActiveMasterID: "old", Done: done}}, backups: []RecoverySnapshot{{ID: "backup", Source: source, Restored: restored, SourceKeys: keys, RestoredKeys: keys}}}
	}
	if result, err := AssessKeyRetirement(ctx, "old", live, valid()); err != nil || !result.Safe {
		t.Fatalf("valid %+v %v", result, err)
	}
	tests := []struct {
		name      string
		setup     func(*retirementInventoryTest)
		wantError bool
	}{
		{"no producers", func(i *retirementInventoryTest) { i.producers = nil }, false},
		{"no backups", func(i *retirementInventoryTest) { i.backups = nil }, false},
		{"still running", func(i *retirementInventoryTest) { i.producers[0].Done = running }, false},
		{"invalid observation", func(i *retirementInventoryTest) { i.producers[0].Done = nil }, true},
		{"duplicate producer", func(i *retirementInventoryTest) { i.producers = append(i.producers, i.producers[0]) }, true},
		{"invalid backup", func(i *retirementInventoryTest) { i.backups[0].ID = "" }, true},
		{"duplicate backup", func(i *retirementInventoryTest) { i.backups = append(i.backups, i.backups[0]) }, true},
		{"same copy", func(i *retirementInventoryTest) { i.backups[0].Restored = i.backups[0].Source }, true},
		{"inventory changed", func(i *retirementInventoryTest) { i.changed = true }, false},
		{"producer failure", func(i *retirementInventoryTest) { i.producerError = errors.New("producer unavailable") }, true},
		{"backup failure", func(i *retirementInventoryTest) { i.backupError = errors.New("backup unavailable") }, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			i := valid()
			tc.setup(i)
			got, err := AssessKeyRetirement(ctx, "old", live, i)
			if got.Safe || (err != nil) != tc.wantError {
				t.Fatalf("result %+v %v", got, err)
			}
		})
	}
	live.identity = source.identity
	if result, err := AssessKeyRetirement(ctx, "old", live, valid()); result.Safe || err == nil {
		t.Fatalf("online database reused as backup: %+v %v", result, err)
	}
	live.identity = store.WebhookRecoveryIdentity{ClusterID: "unit", DatabaseOID: 3}
	live.ids = []string{"old"}
	got, err := AssessKeyRetirement(ctx, "old", live, valid())
	if err != nil || got.Safe {
		t.Fatalf("online reference %+v %v", got, err)
	}
	live.ids = nil
	source.ids = []string{"old"}
	got, err = AssessKeyRetirement(ctx, "old", live, valid())
	if err != nil || got.Safe {
		t.Fatalf("retained reference %+v %v", got, err)
	}
	source.ids = nil
	if _, err = AssessKeyRetirement(ctx, "", live, valid()); err == nil {
		t.Fatal("missing key accepted")
	}
}

func TestRecoveryReaderIdentity(t *testing.T) {
	if sameRecoveryReader(nil, nil) {
		t.Fatal("missing readers are not a stable identity")
	}
	a, b := &retirementDB{}, &retirementDB{}
	if !sameRecoveryReader(a, a) || sameRecoveryReader(a, b) {
		t.Fatal("reader identity mismatch")
	}
}
