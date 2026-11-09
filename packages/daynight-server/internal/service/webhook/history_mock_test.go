package webhook

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

type historyTransactionsMock struct {
	t    *testing.T
	read func(context.Context, func(store.WebhookReadScope) error) error
}

func (m historyTransactionsMock) ReadWebhookSnapshot(c context.Context, f func(store.WebhookReadScope) error) error {
	return retentionRequire(m.t, "ReadWebhookSnapshot", m.read, m.read != nil)(c, f)
}
func (m historyTransactionsMock) WriteWebhook(context.Context, Owner, string, func(store.WebhookWriteScope) error) (store.Completion, error) {
	retentionRequire(m.t, "unexpected history write", func() {}, false)
	panic("unreachable")
}

type historyReadScopeMock struct {
	t           *testing.T
	credential  store.CredentialReader
	team        store.TeamReader
	reader      store.WebhookReader
	eligibility store.WebhookEligibilityDAO
	now         func(context.Context) (time.Time, error)
}

func (m historyReadScopeMock) CredentialDAO() store.CredentialReader       { return m.credential }
func (m historyReadScopeMock) TeamDAO() store.TeamReader                   { return m.team }
func (m historyReadScopeMock) WebhookDAO() store.WebhookReader             { return m.reader }
func (m historyReadScopeMock) EligibilityDAO() store.WebhookEligibilityDAO { return m.eligibility }
func (m historyReadScopeMock) ObservedAt(c context.Context) (time.Time, error) {
	return retentionRequire(m.t, "history.ObservedAt", m.now, m.now != nil)(c)
}

type historyCredentialMock struct {
	t    *testing.T
	read func(context.Context, model.Principal) (store.ThreadCredential, error)
}

func (m historyCredentialMock) Credential(c context.Context, p model.Principal) (store.ThreadCredential, error) {
	return retentionRequire(m.t, "Credential", m.read, m.read != nil)(c, p)
}

type historyTeamMock struct {
	store.TeamReader
	t    *testing.T
	read func(context.Context, string, string) (model.Team, error)
}

func (m historyTeamMock) Team(c context.Context, u, id string) (model.Team, error) {
	return retentionRequire(m.t, "Team", m.read, m.read != nil)(c, u, id)
}

type historyEligibilityMock struct {
	t    *testing.T
	read func(context.Context, Owner, string, string) (store.WebhookEligibility, error)
}

func (m historyEligibilityMock) ReadEligibility(c context.Context, o Owner, p, u string) (store.WebhookEligibility, error) {
	return retentionRequire(m.t, "ReadEligibility", m.read, m.read != nil)(c, o, p, u)
}
func (m historyEligibilityMock) LockAffected(context.Context, store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	retentionRequire(m.t, "history.LockAffected", func() {}, false)
	panic("unreachable")
}
func (m historyEligibilityMock) Revoke(context.Context, string, int64) error {
	retentionRequire(m.t, "history.Revoke", func() {}, false)
	panic("unreachable")
}

type historyReaderMock struct {
	batch         func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error)
	matches       func(context.Context, []string) ([]store.WebhookHistoryMatch, error)
	batchAttempts func(context.Context, []string) ([]store.WebhookAttempt, error)
	t             *testing.T
	endpoint      func(context.Context, Owner, string) (wm.Endpoint, error)
	policy        func(context.Context, int64) (wm.Policy, error)
	deliveries    func(context.Context, Owner, string, time.Time, string, int) ([]store.WebhookDelivery, error)
	delivery      func(context.Context, Owner, string, string) (store.WebhookDelivery, error)
	sources       func(context.Context, store.WebhookDelivery, string) (store.WebhookHistorySources, error)
	disclosure    func(context.Context, Owner, string, string, time.Time) (string, error)
	attempts      func(context.Context, string) ([]store.WebhookAttempt, error)
	latest        func(context.Context, string) (*store.WebhookAttempt, error)
}

func (m *historyReaderMock) Endpoint(c context.Context, o Owner, id string) (wm.Endpoint, error) {
	return retentionRequire(m.t, "Endpoint", m.endpoint, m.endpoint != nil)(c, o, id)
}
func (m *historyReaderMock) Policy(c context.Context, v int64) (wm.Policy, error) {
	return retentionRequire(m.t, "Policy", m.policy, m.policy != nil)(c, v)
}
func (m *historyReaderMock) Endpoints(context.Context, Owner) ([]wm.Endpoint, error) {
	retentionRequire(m.t, "history.Endpoints", func() {}, false)
	panic("unreachable")
}
func (m *historyReaderMock) SigningKeys(context.Context, string) ([]wm.SigningKey, error) {
	retentionRequire(m.t, "history.SigningKeys", func() {}, false)
	panic("unreachable")
}
func (m *historyReaderMock) Subscriptions(context.Context, string) ([]wm.Subscription, error) {
	retentionRequire(m.t, "history.Subscriptions", func() {}, false)
	panic("unreachable")
}
func (m *historyReaderMock) Bindings(context.Context, string) ([]wm.Binding, error) {
	retentionRequire(m.t, "history.Bindings", func() {}, false)
	panic("unreachable")
}
func (m *historyReaderMock) Operation(context.Context, Owner, string) (wm.Operation, error) {
	retentionRequire(m.t, "history.Operation", func() {}, false)
	panic("unreachable")
}
func (m *historyReaderMock) HistoryBatch(c context.Context, o Owner, e, actor string, at time.Time, id string, n int) (store.WebhookHistoryBatch, error) {
	return retentionRequire(m.t, "HistoryBatch", m.batch, m.batch != nil)(c, o, e, actor, at, id, n)
}
func (m *historyReaderMock) HistoryMatches(c context.Context, ids []string) ([]store.WebhookHistoryMatch, error) {
	return retentionRequire(m.t, "HistoryMatches", m.matches, m.matches != nil)(c, ids)
}
func (m *historyReaderMock) HistoryBatchAttempts(c context.Context, ids []string) ([]store.WebhookAttempt, error) {
	return retentionRequire(m.t, "HistoryBatchAttempts", m.batchAttempts, m.batchAttempts != nil)(c, ids)
}
func (m *historyReaderMock) HistoryDeliveries(c context.Context, o Owner, e string, a time.Time, id string, n int) ([]store.WebhookDelivery, error) {
	return retentionRequire(m.t, "HistoryDeliveries", m.deliveries, m.deliveries != nil)(c, o, e, a, id, n)
}
func (m *historyReaderMock) HistoryDelivery(c context.Context, o Owner, e, id string) (store.WebhookDelivery, error) {
	return retentionRequire(m.t, "HistoryDelivery", m.delivery, m.delivery != nil)(c, o, e, id)
}
func (m *historyReaderMock) HistorySources(c context.Context, d store.WebhookDelivery, u string) (store.WebhookHistorySources, error) {
	return retentionRequire(m.t, "HistorySources", m.sources, m.sources != nil)(c, d, u)
}
func (m *historyReaderMock) HistoryDisclosure(c context.Context, o Owner, e, u string, a time.Time) (string, error) {
	return retentionRequire(m.t, "HistoryDisclosure", m.disclosure, m.disclosure != nil)(c, o, e, u, a)
}
func (m *historyReaderMock) HistoryAttempts(c context.Context, id string) ([]store.WebhookAttempt, error) {
	return retentionRequire(m.t, "HistoryAttempts", m.attempts, m.attempts != nil)(c, id)
}
func (m *historyReaderMock) LatestAttempt(c context.Context, id string) (*store.WebhookAttempt, error) {
	return retentionRequire(m.t, "LatestAttempt", m.latest, m.latest != nil)(c, id)
}

type historyScenario struct {
	t         *testing.T
	principal model.Principal
	owner     Owner
	endpoint  wm.Endpoint
	d         store.WebhookDelivery
	src       store.WebhookHistorySources
	scope     historyReadScopeMock
	reader    *historyReaderMock
	service   *Service
}

func newHistoryScenario(t *testing.T) *historyScenario {
	t.Helper()
	f := &historyScenario{t: t, principal: model.Principal{Kind: model.SessionCredential, UserID: "55555555-5555-4555-8555-555555555555", CredentialID: "66666666-6666-4666-8666-666666666666"}}
	f.owner = Owner{Kind: "personal", ID: f.principal.UserID}
	f.d = retentionDeliveryFixture()
	f.d.Owner = f.owner
	f.d.State = "pending"
	f.d.EventType = protocol.Created
	f.d.OccurredAt = retentionTestNow.Add(-time.Hour)
	f.d.PayloadExpiresAt = retentionTestNow.Add(time.Hour)
	f.d.MetadataExpiresAt = retentionTestNow.Add(30 * 24 * time.Hour)
	f.d.ExpiresAt = retentionTestNow.Add(time.Hour)
	f.d.DestinationRevision = 1
	f.d.Generation = 1
	f.d.DestinationKind = "http"
	f.d.ConfigurationSchemaVersion = 1
	f.d.DestinationOrigin = "https://receiver.example"
	f.d.AdapterVersion = 1
	f.d.RequestMediaType = "application/cloudevents+json"
	body, bodyError := protocol.Render(f.d.EventID, protocol.Fact{Type: protocol.Created, ProjectID: f.d.ProjectID, TaskID: "77777777-7777-4777-8777-777777777777", TaskVersion: 7, Status: "todo", OccurredAt: f.d.OccurredAt})
	if bodyError != nil {
		t.Fatal(bodyError)
	}
	f.d.Body = body
	sum := sha256.Sum256(f.d.Body)
	f.d.BodySHA256 = append([]byte(nil), sum[:]...)
	f.d.OriginalBodyBytes = len(f.d.Body)
	config, err := encodeDestination(Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/private?token=secret"})
	if err != nil {
		t.Fatal(err)
	}
	f.d.DestinationConfiguration = config
	f.endpoint = wm.Endpoint{ID: f.d.EndpointID, Owner: f.owner, DestinationRevision: 1, Origin: f.d.DestinationOrigin}
	version := int64(7)
	title := "current task"
	f.src = store.WebhookHistorySources{Event: store.WebhookCapturedEvent{ID: f.d.EventID, ProjectID: f.d.ProjectID, TaskID: "77777777-7777-4777-8777-777777777777", EventType: f.d.EventType, OccurredAt: f.d.OccurredAt, FactBytes: append([]byte(nil), f.d.Body...), FactSHA256: append([]byte(nil), sum[:]...), TaskVersion: &version}, ProjectReadable: true, TaskPresent: true, TaskTitle: &title, OriginalFactBytes: len(f.d.Body), Matches: []store.WebhookAdmissionMatch{{WebhookCapturedMatch: store.WebhookCapturedMatch{SubscriptionID: "88888888-8888-4888-8888-888888888888", BindingID: "99999999-9999-4999-8999-999999999999", ProjectID: f.d.ProjectID, EventType: f.d.EventType, AuthorizationEpoch: 1}, Continuous: true}}}
	f.d.OriginalMatchCount = 1
	f.d.OriginalMatchSHA256, err = MatchDigest([]store.WebhookCapturedMatch{f.src.Matches[0].WebhookCapturedMatch})
	if err != nil {
		t.Fatal(err)
	}
	f.reader = &historyReaderMock{t: t}
	f.reader.matches = func(_ context.Context, ids []string) ([]store.WebhookHistoryMatch, error) {
		var matches []store.WebhookHistoryMatch
		for _, id := range ids {
			for _, match := range f.src.Matches {
				matches = append(matches, store.WebhookHistoryMatch{DeliveryID: id, WebhookAdmissionMatch: match})
			}
		}
		return matches, nil
	}
	f.reader.batchAttempts = func(context.Context, []string) ([]store.WebhookAttempt, error) { return nil, nil }

	f.reader.endpoint = func(_ context.Context, o Owner, id string) (wm.Endpoint, error) {
		if o != f.owner || id != f.d.EndpointID {
			t.Errorf("endpoint arguments %v %s", o, id)
		}
		return f.endpoint, nil
	}
	f.reader.policy = func(_ context.Context, v int64) (wm.Policy, error) {
		if v != 1 {
			t.Errorf("policy=%d", v)
		}
		return wm.Policy{PayloadRetentionSeconds: 604800, MetadataRetentionSeconds: 2592000}, nil
	}
	f.reader.delivery = func(_ context.Context, o Owner, e, id string) (store.WebhookDelivery, error) {
		if o != f.owner || e != f.d.EndpointID || id != f.d.ID {
			t.Errorf("delivery arguments %v %s %s", o, e, id)
		}
		return f.d, nil
	}
	f.reader.sources = func(_ context.Context, d store.WebhookDelivery, u string) (store.WebhookHistorySources, error) {
		if d.EventID != f.d.EventID || u != f.principal.UserID {
			t.Errorf("sources arguments %s %s", d.EventID, u)
		}
		return f.src, nil
	}
	f.reader.attempts = func(_ context.Context, id string) ([]store.WebhookAttempt, error) {
		if id != f.d.ID {
			t.Errorf("attempt id=%s", id)
		}
		return nil, nil
	}
	f.reader.disclosure = func(_ context.Context, o Owner, e, u string, _ time.Time) (string, error) {
		if o != f.owner || e != f.d.EndpointID || u != f.principal.UserID {
			t.Errorf("disclosure arguments %v %s %s", o, e, u)
		}
		return "stable", nil
	}
	f.scope = historyReadScopeMock{t: t, reader: f.reader, now: func(context.Context) (time.Time, error) { return retentionTestNow, nil }, credential: historyCredentialMock{t: t, read: func(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
		if p != f.principal {
			t.Errorf("credential=%v", p)
		}
		expiry := retentionTestNow.Add(time.Hour)
		return store.ThreadCredential{ExpiresAt: &expiry}, nil
	}}, eligibility: historyEligibilityMock{t: t, read: func(_ context.Context, o Owner, p, u string) (store.WebhookEligibility, error) {
		if o != f.owner || p != f.d.ProjectID || u != f.principal.UserID {
			t.Errorf("eligibility arguments %v %s %s", o, p, u)
		}
		return store.WebhookEligibility{Status: "eligible"}, nil
	}}}
	f.service = &Service{DB: historyTransactionsMock{t: t, read: func(_ context.Context, cb func(store.WebhookReadScope) error) error { return cb(f.scope) }}}
	return f
}
func (f *historyScenario) get(t *testing.T) map[string]any {
	t.Helper()
	v, e := f.service.GetDelivery(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID)
	if e != nil {
		t.Fatal(e)
	}
	return v.(map[string]any)
}
func historyFaultCode(t *testing.T, err error, want string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != want {
		t.Fatalf("fault=%v want=%s", err, want)
	}
}

func historyAssertNoProjection(t *testing.T, value any) {
	t.Helper()
	if value == nil {
		return
	}
	// GetDelivery can box the zero map returned by makeDeliveryView before
	// propagating its error. A non-nil empty map is still an unexpected result.
	projection, ok := value.(map[string]any)
	if !ok || projection != nil {
		t.Fatalf("failed history read returned a projection: %#v (%T)", value, value)
	}
}

func historyBatchRows(f *historyScenario, deliveries []store.WebhookDelivery) store.WebhookHistoryBatch {
	name, team := "project", "team"
	batch := store.WebhookHistoryBatch{ObservedAt: retentionTestNow, Items: []store.WebhookHistoryItem{}}
	for _, d := range deliveries {
		src := f.src
		src.Event.ID, src.Event.OccurredAt = d.EventID, d.OccurredAt
		src.Matches = nil
		revision := f.endpoint.DestinationRevision
		batch.Items = append(batch.Items, store.WebhookHistoryItem{Delivery: d, Sources: src, EventPresent: true,
			Eligibility:     wm.EligibilityFacts{ProjectLive: true, ProjectName: &name, TeamID: &team, TeamPresent: true, OwnerAccess: true, ActorAccess: true},
			EndpointPresent: true, EndpointRevision: &revision})
	}
	return batch
}
