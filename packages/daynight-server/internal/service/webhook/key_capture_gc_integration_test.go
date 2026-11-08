package webhook_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

type rewrapGCInterleave struct {
	store.WebhookKeyMaintenance
	before func(store.WebhookCiphertext)
}

func (s *rewrapGCInterleave) CompareAndSwapWebhookCiphertext(ctx context.Context, old, next store.WebhookCiphertext) (bool, error) {
	if s.before != nil {
		s.before(old)
	}
	return s.WebhookKeyMaintenance.CompareAndSwapWebhookCiphertext(ctx, old, next)
}

func TestRewrapRealCaptureAndGCInterleaving(t *testing.T) {
	f := newCaptureFixture(t, 1)
	at := time.Now().UTC().Add(-40 * 24 * time.Hour).Truncate(time.Microsecond)
	if _, err := taskservice.NewTasks(f.db, retentionDeadlineCapture{f.capture, at}).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "old controlled capture"}); err != nil {
		t.Fatal(err)
	}
	var oldDelivery string
	if err := f.db.Pool.QueryRow(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=$1 RETURNING id::text`, at).Scan(&oldDelivery); err != nil {
		t.Fatal(err)
	}
	raw := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"new","keys":{"primary":"` + raw + `","new":"` + raw + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	f.capture.Keys = keys
	if _, err = taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "new active capture"}); err != nil {
		t.Fatal(err)
	}
	var newDelivery, master string
	var body, hash []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT id::text,destination_master_key_id,body,body_sha256 FROM webhook_deliveries WHERE id<>$1`, oldDelivery).Scan(&newDelivery, &master, &body, &hash); err != nil {
		t.Fatal(err)
	}
	if master != "new" {
		t.Fatalf("frozen old endpoint was copied under %q", master)
	}
	interleaved := false
	db := &rewrapGCInterleave{WebhookKeyMaintenance: f.db}
	db.before = func(c store.WebhookCiphertext) {
		if c.Kind != "delivery-destination" || c.ID != oldDelivery {
			return
		}
		interleaved = true
		n, _, e := webhook.NewRetention(f.db).Pass(f.ctx)
		if e != nil || n < 1 {
			t.Fatalf("actual GC %d %v", n, e)
		}
	}
	result, err := (webhook.KeyMaintenance{DB: db, Keys: keys}).RewrapPass(f.ctx, "primary", 500)
	if err != nil || !interleaved || result.Conflicts != 1 {
		t.Fatalf("GC versus CAS %+v interleaved=%v %v", result, interleaved, err)
	}
	var oldCount int
	var currentBody, currentHash []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_deliveries WHERE id=$1`, oldDelivery).Scan(&oldCount); err != nil || oldCount != 0 {
		t.Fatalf("deleted delivery revived: %d %v", oldCount, err)
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT body,body_sha256 FROM webhook_deliveries WHERE id=$1`, newDelivery).Scan(&currentBody, &currentHash); err != nil || !bytes.Equal(body, currentBody) || !bytes.Equal(hash, currentHash) {
		t.Fatalf("new captured bytes changed: %v", err)
	}
}
