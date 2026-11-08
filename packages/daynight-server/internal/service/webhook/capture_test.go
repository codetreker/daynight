package webhook

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
)

type captureFixture struct {
	audience   []store.WebhookAudience
	events     []store.WebhookCapturedEvent
	deliveries [][]store.WebhookCapturedDelivery
	err        error
	freezes    int
}

func (f *captureFixture) FreezeAudience(_ context.Context, _ string, _ []string) ([]store.WebhookAudience, error) {
	f.freezes++
	return f.audience, f.err
}
func (f *captureFixture) Policy(context.Context, int64) (wm.Policy, error) {
	return wm.Policy{Version: 1, MaxAutomaticAttempts: 10, AutomaticOffsetsSeconds: []int32{0, 60, 300, 1800, 7200, 21600, 43200, 86400, 172800, 255600}, AutomaticWindowSeconds: 259200, PayloadRetentionSeconds: 604800, MetadataRetentionSeconds: 2592000, JitterBasisPoints: 1000, JitterMaxSeconds: 1800}, nil
}
func (f *captureFixture) RecordedAt(context.Context) (time.Time, error) {
	return time.Date(2026, 1, 1, 0, 1, 0, 0, time.UTC), nil
}
func (f *captureFixture) SaveCapture(_ context.Context, e store.WebhookCapturedEvent, d []store.WebhookCapturedDelivery) error {
	f.events = append(f.events, e)
	f.deliveries = append(f.deliveries, d)
	return f.err
}

func TestCapturePreservesFrozenMatchesAndRewraps(t *testing.T) {
	keys := keyring(t, "old")
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	ep := wm.Endpoint{ID: "11111111-1111-4111-8111-111111111111", Owner: wm.Owner{Kind: "personal", ID: "22222222-2222-4222-8222-222222222222"}, DestinationKind: "http", AdapterVersion: "1", DestinationRevision: 1, Origin: "https://example.test"}
	plain, err := encodeDestination(Destination{Kind: "http", AdapterVersion: "1", URL: "https://example.test/path"})
	if err != nil {
		t.Fatal(err)
	}
	box, err := keys.Seal(plain, binding(ep, "endpoint-current", "1"), nil)
	if err != nil {
		t.Fatal(err)
	}
	ep.DestinationCiphertext, err = box.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	project := "33333333-3333-4333-8333-333333333333"
	task := "44444444-4444-4444-8444-444444444444"
	a := store.WebhookAudience{EventType: protocol.Paused, ProjectID: project, Endpoint: ep, ConfigurationSchemaVersion: 1, SubscriptionID: "55555555-5555-4555-8555-555555555555", BindingID: "66666666-6666-4666-8666-666666666666", AuthorizationEpoch: 2}
	b := a
	b.BindingID = "77777777-7777-4777-8777-777777777777"
	b.SubscriptionID = "88888888-8888-4888-8888-888888888888"
	dao := &captureFixture{audience: []store.WebhookAudience{a, b}}
	c := &Capturer{Keys: keys}
	fact := protocol.Fact{Type: protocol.Paused, ProjectID: project, TaskID: task, TaskVersion: 2, OccurredAt: now, Paused: true}
	if err = c.CaptureBatch(context.Background(), dao, []protocol.Fact{fact}); err != nil {
		t.Fatal(err)
	}
	if dao.freezes != 1 || len(dao.events) != 1 || len(dao.deliveries) != 1 || len(dao.deliveries[0]) != 1 {
		t.Fatalf("capture counts: %#v", dao)
	}
	event, d := dao.events[0], dao.deliveries[0][0]
	if len(d.Matches) != 2 || !bytes.Equal(event.FactBytes, d.Body) {
		t.Fatal("incomplete proof or changed body")
	}
	hash, err := MatchDigest(d.Matches)
	if err != nil || !bytes.Equal(hash, d.OriginalMatchSHA256) {
		t.Fatalf("match digest: %v", err)
	}
	dest, err := secretbox.ParseEnvelope(d.DestinationCiphertext)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := keys.Open(dest, binding(ep, "delivery-destination", d.ID))
	if err != nil || !bytes.Equal(opened, plain) {
		t.Fatalf("delivery destination: %v", err)
	}
	if _, err = keys.Open(dest, binding(ep, "endpoint-current", "1")); !errors.Is(err, secretbox.ErrAuthentication) {
		t.Fatalf("incorrect AAD accepted: %v", err)
	}
	if len(d.AutomaticScheduleAt) != 10 || !d.AutomaticScheduleAt[0].Equal(now) || !d.AutomaticScheduleAt[9].Before(now.Add(72*time.Hour)) {
		t.Fatal("invalid schedule")
	}
	for i := 1; i < 10; i++ {
		if !d.AutomaticScheduleAt[i].After(d.AutomaticScheduleAt[i-1]) {
			t.Fatal("non-monotone schedule")
		}
	}
}

func TestCaptureEmptyAudienceAndErrors(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	fact := protocol.Fact{Type: protocol.Paused, ProjectID: "33333333-3333-4333-8333-333333333333", TaskID: "44444444-4444-4444-8444-444444444444", TaskVersion: 2, OccurredAt: now, Paused: true}
	d := &captureFixture{}
	c := &Capturer{}
	if err := c.CaptureBatch(context.Background(), d, []protocol.Fact{fact}); err != nil || len(d.events) != 0 {
		t.Fatalf("empty audience: %v", err)
	}
	d.audience = []store.WebhookAudience{{EventType: protocol.Paused}}
	if err := c.CaptureBatch(context.Background(), d, []protocol.Fact{fact}); !errors.Is(err, secretbox.ErrMissingKey) {
		t.Fatalf("missing key: %v", err)
	}
	if err := c.CaptureBatch(context.Background(), d, []protocol.Fact{fact, fact, fact}); err == nil {
		t.Fatal("oversized batch accepted")
	}
	expected := errors.New("freeze failed")
	d.err = expected
	if err := c.CaptureBatch(context.Background(), d, []protocol.Fact{fact}); !errors.Is(err, expected) {
		t.Fatalf("lost cause: %v", err)
	}
}
