package webhook

import (
	"context"
	"encoding/binary"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

const (
	captureProjectID      = "22222222-2222-4222-8222-222222222222"
	captureTaskID         = "33333333-3333-4333-8333-333333333333"
	captureEndpointID     = "44444444-4444-4444-8444-444444444444"
	captureOwnerID        = "55555555-5555-4555-8555-555555555555"
	captureSubscriptionID = "66666666-6666-4666-8666-666666666666"
	captureBindingID      = "77777777-7777-4777-8777-777777777777"
)

var captureOccurredAt = time.Date(2026, 11, 6, 8, 0, 0, 123000, time.UTC)

type captureWrite struct {
	context    context.Context
	event      store.WebhookCapturedEvent
	deliveries []store.WebhookCapturedDelivery
}

type captureDAOMock struct {
	t           *testing.T
	want, calls []string
	project     string
	types       []string
	writes      []captureWrite
	freeze      func(context.Context, string, []string) ([]store.WebhookAudience, error)
	policy      func(context.Context, int64) (wm.Policy, error)
	recorded    func(context.Context) (time.Time, error)
	save        func(context.Context, store.WebhookCapturedEvent, []store.WebhookCapturedDelivery) error
}

func newCaptureDAOMock(t *testing.T, want ...string) *captureDAOMock {
	t.Helper()
	dao := &captureDAOMock{t: t, want: slices.Clone(want)}
	t.Cleanup(func() {
		if !slices.Equal(dao.calls, dao.want) {
			t.Errorf("capture calls = %v, want %v", dao.calls, dao.want)
		}
	})
	return dao
}

func (d *captureDAOMock) call(name string, configured bool) error {
	d.t.Helper()
	d.calls = append(d.calls, name)
	index := len(d.calls) - 1
	if !configured || index >= len(d.want) || d.want[index] != name {
		err := fmt.Errorf("unexpected capture DAO call %s at %d (want %v)", name, index, d.want)
		d.t.Error(err)
		return err
	}
	return nil
}

func (d *captureDAOMock) FreezeAudience(ctx context.Context, project string, types []string) ([]store.WebhookAudience, error) {
	if err := d.call("freeze", d.freeze != nil); err != nil {
		return nil, err
	}
	d.project, d.types = project, slices.Clone(types)
	return d.freeze(ctx, project, types)
}
func (d *captureDAOMock) Policy(ctx context.Context, version int64) (wm.Policy, error) {
	if err := d.call("policy", d.policy != nil); err != nil {
		return wm.Policy{}, err
	}
	return d.policy(ctx, version)
}
func (d *captureDAOMock) RecordedAt(ctx context.Context) (time.Time, error) {
	if err := d.call("recorded", d.recorded != nil); err != nil {
		return time.Time{}, err
	}
	return d.recorded(ctx)
}
func (d *captureDAOMock) SaveCapture(ctx context.Context, event store.WebhookCapturedEvent, deliveries []store.WebhookCapturedDelivery) error {
	if err := d.call("save", d.save != nil); err != nil {
		return err
	}
	// Supplied buffers are retained so alias regressions remain observable.
	// Calls record attempted writes without implementing durable storage.
	d.writes = append(d.writes, captureWrite{ctx, event, slices.Clone(deliveries)})
	return d.save(ctx, event, deliveries)
}

func captureTestPolicy() wm.Policy {
	return wm.Policy{Version: 1, MaxAutomaticAttempts: 10, AutomaticOffsetsSeconds: []int32{0, 60, 300, 1800, 7200, 21600, 43200, 86400, 172800, 255600}, AutomaticWindowSeconds: 259200, PayloadRetentionSeconds: 604800, MetadataRetentionSeconds: 2592000, JitterBasisPoints: 1000, JitterMaxSeconds: 1800}
}

func captureFact(kind string) protocol.Fact {
	f := protocol.Fact{Type: kind, ProjectID: captureProjectID, TaskID: captureTaskID, TaskVersion: 42, OccurredAt: captureOccurredAt}
	switch kind {
	case protocol.Created:
		f.Status, f.Paused = "todo", true
	case protocol.StatusChanged:
		f.PreviousStatus, f.Status = "todo", "in_progress"
	case protocol.Paused:
		f.Paused = true
	case protocol.Deleted:
		at := f.OccurredAt
		f.DeletedAt = &at
	case protocol.StepUpdated:
		f.StepID, f.Action = "abcdef01", "created"
	case protocol.ThreadPosted:
		at, reply := f.OccurredAt, "99999999-9999-4999-8999-999999999999"
		f.TaskVersion, f.MessageID, f.CreatedAt, f.ReplyTo = 0, "88888888-8888-4888-8888-888888888888", &at, &reply
	}
	return f
}

func captureAudience(t *testing.T, kind string) store.WebhookAudience {
	t.Helper()
	configuration := []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/hook?token=private"}}`)
	return store.WebhookAudience{EventType: kind, ProjectID: captureProjectID, SubscriptionID: captureSubscriptionID, BindingID: captureBindingID, AuthorizationEpoch: 2, ConfigurationSchemaVersion: 1,
		Endpoint: wm.Endpoint{ID: captureEndpointID, Owner: wm.Owner{Kind: "personal", ID: captureOwnerID}, Name: "receiver", Enabled: true, ConfigVersion: 1, DestinationRevision: 7, DestinationKind: "http", AdapterVersion: "1", Origin: "https://receiver.example", DestinationConfiguration: configuration}}
}

func captureSuccessfulDAO(t *testing.T, audience []store.WebhookAudience, saves int) *captureDAOMock {
	t.Helper()
	want := []string{"freeze", "policy", "recorded"}
	for range saves {
		want = append(want, "save")
	}
	d := newCaptureDAOMock(t, want...)
	d.freeze = func(context.Context, string, []string) ([]store.WebhookAudience, error) { return audience, nil }
	d.policy = func(_ context.Context, version int64) (wm.Policy, error) {
		if version != 1 {
			t.Errorf("policy version = %d", version)
		}
		return captureTestPolicy(), nil
	}
	d.recorded = func(context.Context) (time.Time, error) { return captureOccurredAt.Add(time.Minute), nil }
	d.save = func(context.Context, store.WebhookCapturedEvent, []store.WebhookCapturedDelivery) error { return nil }
	return d
}

// UUID entropy is separated from variable-width jitter draws so additional
// responsibilities retain independent identities and deterministic schedules.
type captureEntropy struct{ ids uint64 }

func (r *captureEntropy) Read(p []byte) (int, error) {
	clear(p)
	if len(p) == 16 {
		r.ids++
		binary.BigEndian.PutUint64(p[8:], r.ids)
	}
	return len(p), nil
}

var _ store.WebhookCaptureDAO = (*captureDAOMock)(nil)
