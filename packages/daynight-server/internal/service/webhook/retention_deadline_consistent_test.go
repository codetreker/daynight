package webhook_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

// The source and recording clocks are controlled together. Real capture still
// renders and persists each complete Event and Delivery atomically. The Task
// creation itself uses the actual test clock, so this is not elapsed wall time.
type retentionDeadlineCapture struct {
	inner *webhook.Capturer
	at    time.Time
}
type retentionDeadlineDAO struct {
	store.WebhookCaptureDAO
	at time.Time
}

func (d retentionDeadlineDAO) RecordedAt(context.Context) (time.Time, error) { return d.at, nil }
func (c retentionDeadlineCapture) CaptureBatch(ctx context.Context, d store.WebhookCaptureDAO, f []protocol.Fact) error {
	for i := range f {
		f[i].OccurredAt = c.at
	}
	return c.inner.CaptureBatch(ctx, retentionDeadlineDAO{d, c.at}, f)
}

func TestRetentionConsistentOriginalDeadlineBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name    string
		age     time.Duration
		mode    string
		expired bool
	}{
		{"automatic-before", 72*time.Hour - time.Minute, "automatic", false},
		{"automatic-after", 72*time.Hour + time.Minute, "automatic", true},
		{"payload-before", 7*24*time.Hour - time.Minute, "payload", false},
		{"payload-after", 7*24*time.Hour + time.Minute, "payload", true},
		{"metadata-before", 30*24*time.Hour - time.Minute, "metadata", false},
		{"metadata-after", 30*24*time.Hour + time.Minute, "metadata", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCaptureFixture(t, 1)
			at := time.Now().UTC().Add(-tc.age).Truncate(time.Microsecond)
			if _, err := taskservice.NewTasks(f.db, retentionDeadlineCapture{f.capture, at}).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "controlled historical source"}); err != nil {
				t.Fatal(err)
			}
			var id string
			var eventAt, recordedAt, deliveryAt, automatic, payload, metadata, activity time.Time
			var body, fact, hash []byte
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.id::text,e.occurred_at,e.recorded_at,d.occurred_at,d.automatic_expires_at,d.payload_expires_at,d.metadata_expires_at,d.last_activity_at,d.body,e.fact_bytes,d.body_sha256 FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id`).Scan(&id, &eventAt, &recordedAt, &deliveryAt, &automatic, &payload, &metadata, &activity, &body, &fact, &hash); err != nil {
				t.Fatal(err)
			}
			var wire struct {
				Time string `json:"time"`
			}
			if err := json.Unmarshal(body, &wire); err != nil {
				t.Fatal(err)
			}
			wireAt, err := time.Parse(time.RFC3339Nano, wire.Time)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(body)
			if !eventAt.Equal(at) || !recordedAt.Equal(at) || !deliveryAt.Equal(at) || !wireAt.Equal(at) || !activity.Equal(at) || !automatic.Equal(at.Add(72*time.Hour)) || !payload.Equal(at.Add(7*24*time.Hour)) || !metadata.Equal(at.Add(30*24*time.Hour)) || !bytes.Equal(body, fact) || !bytes.Equal(hash, digest[:]) {
				t.Fatal("controlled capture times, bytes, or original deadlines disagree")
			}
			gc := webhook.NewRetention(f.db)
			if tc.mode == "automatic" || tc.mode == "payload" {
				svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys}
				runner := webhook.NewRunner(f.db, svc, false)
				if err = runner.Start(context.Background()); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					if e := runner.Stop(ctx); e != nil {
						t.Error(e)
					}
				})
				want := "failed"
				if tc.mode == "automatic" && !tc.expired {
					want = "pending"
				}
				deadline := time.Now().Add(5 * time.Second)
				for {
					var state string
					if err = f.db.Pool.QueryRow(f.ctx, `SELECT state FROM webhook_deliveries WHERE id=$1`, id).Scan(&state); err != nil {
						t.Fatal(err)
					}
					if state == want {
						break
					}
					if time.Now().After(deadline) {
						t.Fatalf("actual delivery recovery state %q, want %q", state, want)
					}
					time.Sleep(20 * time.Millisecond)
				}
			} else {
				// A terminal historical state is a controlled fixture. Its recorded
				// activity and immutable source times remain those captured above.
				if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=$2 WHERE id=$1`, id, at); err != nil {
					t.Fatal(err)
				}
			}
			if _, _, err = gc.Pass(f.ctx); err != nil {
				t.Fatal(err)
			}
			var count int
			if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_deliveries WHERE id=$1`, id).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if tc.mode == "metadata" && tc.expired {
				if count != 0 {
					t.Fatal("expired metadata retained")
				}
				return
			}
			if count != 1 {
				t.Fatalf("history removed early: %d", count)
			}
			var afterBody, afterHash, target []byte
			var removed *time.Time
			var reason *string
			var afterAutomatic, afterPayload time.Time
			if err = f.db.Pool.QueryRow(f.ctx, `SELECT body,body_sha256,destination_ciphertext,payload_removed_at,payload_removed_reason,automatic_expires_at,payload_expires_at FROM webhook_deliveries WHERE id=$1`, id).Scan(&afterBody, &afterHash, &target, &removed, &reason, &afterAutomatic, &afterPayload); err != nil {
				t.Fatal(err)
			}
			shouldRemove := tc.mode == "metadata" || tc.mode == "payload" && tc.expired
			if len(target) == 0 || !bytes.Equal(afterHash, hash) || !afterAutomatic.Equal(automatic) || !afterPayload.Equal(payload) {
				t.Fatal("retention changed target, original hash, or deadlines")
			}
			if shouldRemove {
				if afterBody != nil || removed == nil || reason == nil || *reason != "expired" {
					t.Fatal("expired payload not marked")
				}
			} else if !bytes.Equal(afterBody, body) || removed != nil || reason != nil {
				t.Fatal("payload removed early")
			}
		})
	}
}
