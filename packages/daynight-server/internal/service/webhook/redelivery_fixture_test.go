package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

type mgmtRedeliveryFixture struct {
	*mgmtFixture
	delivery store.WebhookDelivery
	sources  store.WebhookAdmissionSources
	history  store.WebhookHistorySources
	attempts []store.WebhookAttempt
}

func newMgmtRedeliveryFixture(t *testing.T) *mgmtRedeliveryFixture {
	return newMgmtRedeliveryFixtureType(t, protocol.Created)
}
func newMgmtRedeliveryFixtureType(t *testing.T, eventType string) *mgmtRedeliveryFixture {
	t.Helper()
	f := newMgmtFixture(t)
	r := &mgmtRedeliveryFixture{mgmtFixture: f}
	project := "77777777-7777-4777-8777-777777777777"
	task := "88888888-8888-4888-8888-888888888888"
	eventID := "99999999-9999-4999-8999-999999999999"
	fact := protocol.Fact{Type: eventType, ProjectID: project, TaskID: task, TaskVersion: 1, OccurredAt: f.now}
	if eventType == protocol.Deleted {
		fact.DeletedAt = mgmtPtr(f.now)
	} else {
		fact.Status = "todo"
	}
	body, err := protocol.Render(eventID, fact)
	if err != nil {
		t.Fatal(err)
	}
	bodyHash := sha256.Sum256(body)
	match := store.WebhookCapturedMatch{SubscriptionID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", BindingID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ProjectID: project, EventType: eventType, AuthorizationEpoch: 1}
	digest, err := MatchDigest([]store.WebhookCapturedMatch{match})
	if err != nil {
		t.Fatal(err)
	}
	schedule := []time.Time{f.now, f.now.Add(time.Minute), f.now.Add(5 * time.Minute), f.now.Add(30 * time.Minute), f.now.Add(2 * time.Hour), f.now.Add(6 * time.Hour), f.now.Add(12 * time.Hour), f.now.Add(24 * time.Hour), f.now.Add(48 * time.Hour), f.now.Add(71 * time.Hour)}
	r.delivery = store.WebhookDelivery{ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", EventID: eventID, EndpointID: f.endpoint.ID, Owner: f.owner, ProjectID: project, EventType: eventType, OccurredAt: f.now, OriginalMatchCount: 1, OriginalMatchSHA256: digest, PolicyVersion: 1, DestinationRevision: 1, AdapterVersion: 1, DestinationKind: "http", DestinationOrigin: f.endpoint.Origin, RenderVersion: 1, ConfigurationSchemaVersion: 1, DestinationConfiguration: bytes.Clone(f.endpoint.DestinationConfiguration), RequestMethod: "POST", RequestMediaType: protocol.MediaType, DeterministicHeadersJSON: []byte("[]"), Body: body, BodySHA256: bodyHash[:], OriginalBodyBytes: len(body), AutomaticScheduleAt: schedule, AutomaticExpiresAt: f.now.Add(72 * time.Hour), PayloadExpiresAt: f.now.Add(168 * time.Hour), AutomaticPlanCursor: 1, AutomaticAttemptCount: 1, AutomaticOpen: false, Generation: 1, AttemptSequence: 1, State: "delivered", Trigger: "automatic", ExpiresAt: f.now.Add(72 * time.Hour), LastActivityAt: f.now.Add(-time.Hour), MetadataExpiresAt: f.now.Add(24 * time.Hour), QueueOrder: 11}
	event := store.WebhookCapturedEvent{ID: eventID, EventType: eventType, ProjectID: project, TaskID: task, WireVersion: 1, SchemaVersion: 1, FactCodecVersion: 1, TaskVersion: mgmtPtr(int64(1)), OccurredAt: f.now, RecordedAt: f.now, FactBytes: bytes.Clone(body), FactSHA256: bodyHash[:]}
	matches := []store.WebhookAdmissionMatch{{WebhookCapturedMatch: match, Continuous: true}}
	r.sources = store.WebhookAdmissionSources{Event: event, Endpoint: f.endpoint, SigningKeys: []wm.SigningKey{f.key}, Matches: matches, TaskPresent: true, ProjectEligible: true, EndpointPresent: true}
	r.history = store.WebhookHistorySources{Event: event, Matches: matches, TaskPresent: true, ProjectReadable: true, OriginalFactBytes: len(body), TaskTitle: mgmtPtr("Task")}
	f.redelivery.AdmissionSourcesForActorFn = func(_ context.Context, d, e string, o wm.Owner, actor string, _ time.Time) (store.WebhookAdmissionSources, error) {
		if d != r.delivery.ID || e != f.endpoint.ID || o != f.owner || actor != f.principal.UserID {
			t.Errorf("admission identity=%s %s %v %s", d, e, o, actor)
		}
		return r.sources, nil
	}
	f.redelivery.LockDeliveryFn = func(_ context.Context, id string) (store.WebhookDelivery, error) {
		if id != r.delivery.ID {
			t.Errorf("delivery lock=%s", id)
		}
		d := r.delivery
		d.Body = bytes.Clone(d.Body)
		return d, nil
	}
	f.redelivery.LockAttemptsFn = func(_ context.Context, id string) ([]store.WebhookAttempt, error) {
		if id != r.delivery.ID {
			t.Errorf("attempt lock=%s", id)
		}
		return append([]store.WebhookAttempt(nil), r.attempts...), nil
	}
	f.redelivery.NextQueueOrderFn = func(context.Context) (int64, error) { return 88, nil }
	f.eligibility.ReadEligibilityFn = func(_ context.Context, o wm.Owner, projectID, actor string) (store.WebhookEligibility, error) {
		if o != f.owner || projectID != r.delivery.ProjectID || actor != f.principal.UserID {
			t.Errorf("eligibility=%v %s %s", o, projectID, actor)
		}
		return store.WebhookEligibility{Status: "eligible", ProjectName: mgmtPtr("Project")}, nil
	}
	f.writer.HistorySourcesFn = func(_ context.Context, d store.WebhookDelivery, actor string) (store.WebhookHistorySources, error) {
		if d.ID != r.delivery.ID || actor != f.principal.UserID {
			t.Errorf("history sources=%s %s", d.ID, actor)
		}
		return r.history, nil
	}
	f.postDAO.HistorySourcesFn = f.writer.HistorySourcesFn
	f.postDAO.HistoryAttemptsFn = func(_ context.Context, id string) ([]store.WebhookAttempt, error) {
		if id != r.delivery.ID {
			t.Errorf("history attempts=%s", id)
		}
		return append([]store.WebhookAttempt(nil), r.attempts...), nil
	}
	return r
}
func (r *mgmtRedeliveryFixture) intent() Redelivery {
	return Redelivery{OperationID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", IssuedAt: r.now.Format(time.RFC3339Nano), ExpectedUserID: r.principal.UserID, IfVersion: r.sources.Endpoint.ConfigVersion, IfGeneration: r.delivery.Generation, RequestSHA256: strings.Repeat("b", 64)}
}
func (r *mgmtRedeliveryFixture) expectedDelivery(m Redelivery) store.WebhookDelivery {
	d := r.delivery
	d.Generation++
	d.ManualOperationCount++
	d.State = "pending"
	d.Trigger = "manual"
	d.ManualOperationID = mgmtPtr(m.OperationID)
	d.NextAttemptAt = mgmtPtr(r.now)
	d.ExpiresAt = d.PayloadExpiresAt
	d.QueueOrder = 88
	d.TerminalAt = nil
	d.PreparationErrorCode = nil
	d.LeaseToken = nil
	d.LeaseClaimedAt = nil
	d.LeaseUntil = nil
	d.LeaseGeneration = nil
	d.LeasePlanSlot = nil
	d.CurrentAttemptID = nil
	d.LastActivityAt = r.now
	d.MetadataExpiresAt = r.now.Add(30 * 24 * time.Hour)
	return d
}
func (r *mgmtRedeliveryFixture) respond(m Redelivery, d store.WebhookDelivery) wm.Operation {
	r.t.Helper()
	fp, err := redeliveryFingerprint(r.principal, r.owner, r.endpoint.ID, r.delivery.ID, m)
	if err != nil {
		r.t.Fatal(err)
	}
	op := wm.Operation{Owner: r.owner, ID: m.OperationID, ActorID: r.principal.UserID, Kind: "delivery.redeliver", TargetID: r.endpoint.ID, DeliveryID: r.delivery.ID, GenerationAfter: mgmtPtr(d.Generation), IssuedAt: m.IssuedAt, RequestSHA256: m.RequestSHA256, Fingerprint: fp, Effect: "applied", ConfigVersion: r.sources.Endpoint.ConfigVersion, DestinationRevisionAfter: r.sources.Endpoint.DestinationRevision, RecordedAt: r.now, ExpiresAt: r.now.Add(30 * 24 * time.Hour)}
	r.postDAO.OperationFn = func(_ context.Context, o wm.Owner, id string) (wm.Operation, error) {
		if o != op.Owner || id != op.ID {
			r.t.Errorf("redelivery projection receipt=%v %s", o, id)
		}
		return op, nil
	}
	r.postDAO.HistoryDeliveryFn = func(_ context.Context, o wm.Owner, e, id string) (store.WebhookDelivery, error) {
		if o != d.Owner || e != d.EndpointID || id != d.ID {
			r.t.Errorf("redelivery projection delivery=%v %s %s", o, e, id)
		}
		return d, nil
	}
	return op
}

type mgmtBasicReader struct{ store.WebhookReader }

func (r *mgmtRedeliveryFixture) call(m Redelivery) (Result, error) {
	return r.service.Redeliver(r.ctx, r.principal, r.owner, r.endpoint.ID, r.delivery.ID, m)
}
func mgmtCallNameCount(calls []string, name string) int {
	n := 0
	for _, c := range calls {
		if c == name {
			n++
		}
	}
	return n
}
