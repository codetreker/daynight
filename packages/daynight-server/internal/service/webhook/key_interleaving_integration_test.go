package webhook

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type rewrapInterleaving struct {
	store.WebhookKeyMaintenance
	before func()
}

func (s *rewrapInterleaving) CompareAndSwapWebhookCiphertext(ctx context.Context, old, next store.WebhookCiphertext) (bool, error) {
	if s.before != nil {
		f := s.before
		s.before = nil
		f()
	}
	return s.WebhookKeyMaintenance.CompareAndSwapWebhookCiphertext(ctx, old, next)
}

func TestRewrapConflictsWithActualConfigurationChange(t *testing.T) {
	f := newFixture(t, false)
	p := f.principal(t)
	owner := Owner{Kind: "personal", ID: p.UserID}
	created, err := f.svc.Mutate(f.ctx, p, owner, createMutation(p, "initial", "https://receiver.example/old"))
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	id := ep["id"].(string)
	f.svc.Keys = keyring(t, "new")
	db := &rewrapInterleaving{WebhookKeyMaintenance: f.db}
	db.before = func() {
		change := mutation(p, "endpoint.update", id, 1)
		change.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/new"}
		if _, e := f.svc.Mutate(f.ctx, p, owner, change); e != nil {
			t.Fatal(e)
		}
	}
	result, err := (KeyMaintenance{DB: db, Keys: f.svc.Keys}).RewrapPass(f.ctx, "old", 500)
	if err != nil || result.Conflicts == 0 {
		t.Fatalf("configuration race %+v %v", result, err)
	}
	got, err := f.svc.Get(f.ctx, p, owner, id)
	if err != nil {
		t.Fatal(err)
	}
	view := got.(map[string]any)
	if view["configVersion"] != "2" || view["destinationRevision"] != "2" || view["destination"].(map[string]any)["url"] != "https://receiver.example/new" {
		t.Fatalf("configuration overwritten: %#v", view)
	}
	ids, err := f.db.WebhookMasterKeyIDs(f.ctx)
	if err != nil || len(ids) != 1 || ids[0] != "new" {
		t.Fatalf("new writes %v %v", ids, err)
	}
}
