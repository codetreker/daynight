package webhook_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

func drainRetentionEvents(r *webhook.Retention, output *bytes.Buffer) {
	logger := slog.New(slog.NewJSONHandler(output, nil))
	for {
		select {
		case event := <-r.Events():
			event.Log(context.Background(), logger)
		default:
			return
		}
	}
}

func TestRetentionObservationAndSafeLog(t *testing.T) {
	f, id := retentionCapture(t)
	var body, configuration []byte
	var event, endpoint, owner, project string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT body,destination_configuration,event_id::text,endpoint_id::text,owner_id::text,project_id::text FROM webhook_deliveries WHERE id=$1`, id).Scan(&body, &configuration, &event, &endpoint, &owner, &project); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	r := webhook.NewRetention(f.db)
	if r.Observation().Available {
		t.Fatal("unrun retention observation was available")
	}
	n, more, err := r.Pass(f.ctx)
	if err != nil || n != 0 || more {
		t.Fatalf("fresh pass: %d %v %v", n, more, err)
	}
	before := r.Observation()
	if !before.Available || before.LagKnown || before.ConfirmedRows != 0 || before.Failed || before.Unknown {
		t.Fatalf("fresh observation: %+v", before)
	}
	ageRetention(t, f, id, 8*24*time.Hour)
	n, more, err = r.Pass(f.ctx)
	if err != nil || n != 2 {
		t.Fatalf("expired pass: %d %v %v", n, more, err)
	}
	obs := r.Observation()
	if !obs.Available || !obs.LagKnown || obs.OldestObservedLag < 23*time.Hour || obs.OldestObservedLag > 25*time.Hour || obs.LagObservedAt.IsZero() || obs.ConfirmedRows != n || obs.HistoryRows != n || obs.ConfigRows != 0 || obs.ReceiptRows != 0 || obs.ContinueSoon != more || obs.Unknown || obs.Failed {
		t.Fatalf("expired observation: %+v", obs)
	}
	drainRetentionEvents(r, &output)
	log := output.String()
	for _, expected := range []string{`"component":"webhook"`, `"phase":"payload"`, `"event_id":"` + event + `"`, `"delivery_id":"` + id + `"`, `"endpoint_id":"` + endpoint + `"`, `"owner_id":"` + owner + `"`, `"project_id":"` + project + `"`, `"history_rows":2`, `"lag_known":true`} {
		if !strings.Contains(log, expected) {
			t.Fatalf("missing %q in %s", expected, log)
		}
	}
	for _, secret := range []string{string(body), string(configuration), hex.EncodeToString(configuration), base64.StdEncoding.EncodeToString(configuration), "receiver.example"} {
		if secret != "" && strings.Contains(log, secret) {
			t.Fatalf("retention log disclosed payload or configuration")
		}
	}
}

type failedRetentionTelemetry struct{ *postgres.Store }

func (f failedRetentionTelemetry) WriteWebhookRetention(context.Context, func(store.WebhookRetentionScope) error) (store.Completion, error) {
	return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("private-payload-and-secret-marker")
}
func TestRetentionObservationRedactsErrorsAndUnknown(t *testing.T) {
	f, id := retentionCapture(t)
	ageRetention(t, f, id, 8*24*time.Hour)
	var output bytes.Buffer
	r := webhook.NewRetention(failedRetentionTelemetry{f.db})
	_, _, err := r.Pass(f.ctx)
	if err == nil || !strings.Contains(err.Error(), "private-payload-and-secret-marker") {
		t.Fatalf("error chain missing: %v", err)
	}
	obs := r.Observation()
	if !obs.Available || !obs.Failed || obs.Unknown || obs.LagKnown || obs.ConfirmedRows != 0 {
		t.Fatalf("failure observation: %+v", obs)
	}
	drainRetentionEvents(r, &output)
	if strings.Contains(output.String(), "private-payload-and-secret-marker") || !strings.Contains(output.String(), `"error_code":"maintenance_error"`) {
		t.Fatalf("unsafe failure log: %s", output.String())
	}
	output.Reset()
	unknownDB := &retentionUnknownDB{Store: f.db}
	unknown := webhook.NewRetention(unknownDB)
	n, _, err := unknown.Pass(f.ctx)
	if err == nil || n != 0 {
		t.Fatalf("unknown result: %d %v", n, err)
	}
	obs = unknown.Observation()
	drainRetentionEvents(unknown, &output)
	if !obs.Unknown || !obs.Failed || obs.ConfirmedRows != 0 || obs.LagKnown || !strings.Contains(output.String(), `"error_code":"transaction_unknown"`) {
		t.Fatalf("unknown observation: %+v log=%s", obs, output.String())
	}
	if _, _, err = unknown.Pass(f.ctx); err != nil || !unknownDB.observed {
		t.Fatalf("unknown not observed: %v", err)
	}
}

func TestRetentionBackgroundObservationConcurrentReaders(t *testing.T) {
	f, id := retentionCapture(t)
	ageRetention(t, f, id, 8*24*time.Hour)
	r := webhook.NewRetention(f.db)
	if err := r.Start(f.ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = r.Stop(ctx)
	})
	errs := make(chan string, 4)
	for i := 0; i < 4; i++ {
		go func() {
			for n := 0; n < 100; n++ {
				obs := r.Observation()
				if obs.Available && obs.ConfirmedRows != obs.HistoryRows+obs.ConfigRows+obs.ReceiptRows {
					errs <- "inconsistent counters"
					return
				}
				time.Sleep(time.Millisecond)
			}
			errs <- ""
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for !r.Observation().Available && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	for i := 0; i < 4; i++ {
		if problem := <-errs; problem != "" {
			t.Fatal(problem)
		}
	}
	obs := r.Observation()
	if !obs.Available || obs.ConfirmedRows < 1 || !obs.LagKnown || obs.Unknown || obs.Failed {
		t.Fatalf("background observation: %+v", obs)
	}
}

func TestRetentionObservationUsesLaterMetadataDeadline(t *testing.T) {
	f, id := retentionCapture(t)
	ageRetention(t, f, id, 40*24*time.Hour)
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET metadata_expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	r := webhook.NewRetention(f.db)
	n, _, err := r.Pass(f.ctx)
	if err != nil || n < 1 {
		t.Fatalf("history pass: %d %v", n, err)
	}
	obs := r.Observation()
	if !obs.LagKnown || obs.OldestObservedLag < 59*time.Minute || obs.OldestObservedLag > 61*time.Minute {
		t.Fatalf("later deadline not respected: %+v", obs)
	}
}

type failedRetentionReconciliation struct {
	*retentionUnknownDB
	fail bool
}

func (f *failedRetentionReconciliation) ObserveWebhookRetention(ctx context.Context, kind, id string) error {
	if f.fail {
		return errors.New("observation unavailable")
	}
	return f.retentionUnknownDB.ObserveWebhookRetention(ctx, kind, id)
}
func TestRetentionObservationKeepsUnknownUntilReadback(t *testing.T) {
	f, id := retentionCapture(t)
	ageRetention(t, f, id, 8*24*time.Hour)
	db := &failedRetentionReconciliation{retentionUnknownDB: &retentionUnknownDB{Store: f.db}, fail: true}
	r := webhook.NewRetention(db)
	if _, _, err := r.Pass(f.ctx); err == nil || !r.Observation().Unknown {
		t.Fatalf("unknown not recorded: %v %+v", err, r.Observation())
	}
	if _, _, err := r.Pass(f.ctx); err == nil || !r.Observation().Unknown || db.observed {
		t.Fatalf("unreadable result lost: %v %+v", err, r.Observation())
	}
	db.fail = false
	if _, _, err := r.Pass(f.ctx); err != nil || r.Observation().Unknown || !db.observed {
		t.Fatalf("readback not resolved: %v %+v", err, r.Observation())
	}
}

func TestRetentionBlockedEventConsumerDoesNotBlockPassOrStop(t *testing.T) {
	f, _ := retentionCapture(t)
	r := webhook.NewRetention(f.db)
	consumed, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() { defer close(done); <-r.Events(); close(consumed); <-release }()
	defer func() { close(release); <-done }()
	if err := r.Start(f.ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = r.Stop(ctx)
	})
	select {
	case <-consumed:
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
	for i := 0; i < 350 && r.Observation().DroppedEvents == 0; i++ {
		started := time.Now()
		if _, _, err := r.Pass(f.ctx); err != nil {
			t.Fatal(err)
		}
		if time.Since(started) > 3*time.Second {
			t.Fatal("blocked consumer delayed maintenance pass")
		}
	}
	if r.Observation().DroppedEvents == 0 {
		t.Fatal("full event buffer did not report dropped events")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := r.Stop(ctx); err != nil {
		t.Fatalf("blocked consumer delayed stop: %v", err)
	}
}
