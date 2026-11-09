package webhook

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

type mgmtEffects struct {
	endpoints     []wm.Endpoint
	keys          []wm.SigningKey
	deletedKeys   []string
	subscriptions []wm.Subscription
	bindings      []wm.Binding
	operations    []wm.Operation
	deliveries    []store.WebhookDelivery
	attempts      []store.WebhookAttempt
}

func (e mgmtEffects) count() int {
	return len(e.endpoints) + len(e.keys) + len(e.deletedKeys) + len(e.subscriptions) + len(e.bindings) + len(e.operations) + len(e.deliveries) + len(e.attempts)
}

type mgmtFixture struct {
	t                                              *testing.T
	ctx                                            context.Context
	now                                            time.Time
	principal                                      model.Principal
	owner                                          wm.Owner
	endpoint                                       wm.Endpoint
	key                                            wm.SigningKey
	policy                                         wm.Policy
	trace                                          *mgmtTrace
	db                                             *mgmtTransactions
	pre, write, post                               *mgmtScope
	preDAO, writer, postDAO                        *mgmtWebhookDAO
	preCredential, writeCredential, postCredential *mgmtCredentialDAO
	preTeam, writeTeam, postTeam                   *mgmtTeamDAO
	eligibility                                    *mgmtEligibilityDAO
	redelivery                                     *mgmtRedeliveryDAO
	service                                        *Service
	effects                                        mgmtEffects
	reads                                          int
	writeActive                                    atomic.Bool
}

func mgmtPolicy() wm.Policy {
	return wm.Policy{Version: 1, MaxAutomaticAttempts: 10, MaxManualOperations: 3, AutomaticWindowSeconds: 259200, AutomaticOffsetsSeconds: []int32{0, 60, 300, 1800, 7200, 21600, 43200, 86400, 172800, 255600}, PayloadRetentionSeconds: 604800, MetadataRetentionSeconds: 2592000, OperationRetentionSeconds: 2592000, OperationMaxAgeSeconds: 300, OperationFutureSkewSeconds: 60, HTTPTimeoutSeconds: 15, LeaseSeconds: 45, MinimumFailureWaitSeconds: 5, JitterBasisPoints: 1000, JitterMaxSeconds: 1800, KeyOverlapDefaultSeconds: 86400, KeyOverlapMaxSeconds: 604800}
}
func mgmtPtr[T any](value T) *T { return &value }
func mgmtEntropy() io.Reader {
	data := make([]byte, 8192)
	for i := range data {
		data[i] = byte(i % 251)
	}
	return bytes.NewReader(data)
}
func mgmtRandomID(offset int) string {
	data := make([]byte, 16)
	for i := range data {
		data[i] = byte((i + offset) % 251)
	}
	data[6] = (data[6] & 15) | 64
	data[8] = (data[8] & 63) | 128
	id, err := uuid.FromBytes(data)
	if err != nil {
		panic(err)
	}
	return id.String()
}
func newMgmtFixture(t *testing.T) *mgmtFixture {
	t.Helper()
	f := &mgmtFixture{t: t, ctx: t.Context(), now: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), trace: &mgmtTrace{}, policy: mgmtPolicy()}
	f.principal = model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	f.owner = wm.Owner{Kind: "personal", ID: f.principal.UserID}
	destination, err := encodeDestination(Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/Original?token=private"})
	if err != nil {
		t.Fatal(err)
	}
	f.endpoint = wm.Endpoint{ID: "33333333-3333-4333-8333-333333333333", Owner: f.owner, Name: "Original", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://receiver.example", DestinationConfiguration: destination, ActiveKeyID: "44444444-4444-4444-8444-444444444444", CreatedAt: f.now.Add(-time.Hour), UpdatedAt: f.now.Add(-time.Hour)}
	f.key = wm.SigningKey{ID: f.endpoint.ActiveKeyID, EndpointID: f.endpoint.ID, Slot: "current", Secret: bytes.Repeat([]byte{71}, 32), CreatedAt: f.endpoint.CreatedAt}
	base := func(label string) mgmtMockBase { return mgmtMockBase{t: t, trace: f.trace, label: label} }
	f.preDAO = &mgmtWebhookDAO{mgmtMockBase: base("pre.dao")}
	f.writer = &mgmtWebhookDAO{mgmtMockBase: base("write.dao")}
	f.postDAO = &mgmtWebhookDAO{mgmtMockBase: base("post.dao")}
	f.preCredential = &mgmtCredentialDAO{mgmtMockBase: base("pre.credential")}
	f.writeCredential = &mgmtCredentialDAO{mgmtMockBase: base("write.credential")}
	f.postCredential = &mgmtCredentialDAO{mgmtMockBase: base("post.credential")}
	expiry := f.now.Add(time.Hour)
	for _, c := range []*mgmtCredentialDAO{f.preCredential, f.writeCredential, f.postCredential} {
		c.CredentialFn = func(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
			if p.UserID != f.principal.UserID {
				t.Errorf("credential user=%s", p.UserID)
			}
			return store.ThreadCredential{ExpiresAt: &expiry}, nil
		}
	}
	f.preTeam = &mgmtTeamDAO{mgmtMockBase: base("pre.team")}
	f.writeTeam = &mgmtTeamDAO{mgmtMockBase: base("write.team")}
	f.postTeam = &mgmtTeamDAO{mgmtMockBase: base("post.team")}
	f.eligibility = &mgmtEligibilityDAO{mgmtMockBase: base("eligibility")}
	f.redelivery = &mgmtRedeliveryDAO{mgmtMockBase: base("redelivery")}
	f.pre = &mgmtScope{mgmtMockBase: base("pre"), credential: f.preCredential, team: f.preTeam, reader: f.preDAO, eligibility: f.eligibility, ObservedAtFn: func(context.Context) (time.Time, error) { return f.now, nil }}
	f.write = &mgmtScope{mgmtMockBase: base("write"), credential: f.writeCredential, team: f.writeTeam, reader: f.writer, writer: f.writer, eligibility: f.eligibility, redelivery: f.redelivery, ObservedAtFn: func(context.Context) (time.Time, error) { return f.now, nil }}
	f.post = &mgmtScope{mgmtMockBase: base("post"), credential: f.postCredential, team: f.postTeam, reader: f.postDAO, eligibility: f.eligibility, ObservedAtFn: func(context.Context) (time.Time, error) { return f.now, nil }}
	for _, d := range []*mgmtWebhookDAO{f.preDAO, f.writer, f.postDAO} {
		d.EndpointFn = func(_ context.Context, o wm.Owner, id string) (wm.Endpoint, error) {
			if o != f.owner || id != f.endpoint.ID {
				return wm.Endpoint{}, model.ErrNotFound
			}
			ep := f.endpoint
			ep.DestinationConfiguration = bytes.Clone(ep.DestinationConfiguration)
			return ep, nil
		}
		d.SigningKeysFn = func(_ context.Context, id string) ([]wm.SigningKey, error) {
			if id != f.endpoint.ID {
				t.Errorf("signing endpoint=%s", id)
			}
			k := f.key
			k.Secret = bytes.Clone(k.Secret)
			return []wm.SigningKey{k}, nil
		}
		d.SubscriptionsFn = func(_ context.Context, id string) ([]wm.Subscription, error) {
			if id != f.endpoint.ID {
				t.Errorf("subscriptions endpoint=%s", id)
			}
			return nil, nil
		}
	}
	f.writer.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) {
		return wm.Operation{}, model.ErrNotFound
	}
	f.writer.PolicyFn = func(_ context.Context, version int64) (wm.Policy, error) {
		if version != 1 {
			t.Errorf("policy=%d", version)
		}
		return f.policy, nil
	}
	f.writer.LockEndpointFn = f.writer.EndpointFn
	f.writer.LockSubscriptionsFn = f.writer.SubscriptionsFn
	f.write.LockConfigurationSourcesFn = func(_ context.Context, o wm.Owner, actor string, _ []string) error {
		if o != f.owner || actor != f.principal.UserID {
			t.Errorf("configuration authority=%v %s", o, actor)
		}
		return nil
	}
	f.write.LockCredentialFn = func(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
		if p != f.principal {
			t.Errorf("locked principal=%v", p)
		}
		return store.ThreadCredential{ExpiresAt: &expiry}, nil
	}
	f.db = &mgmtTransactions{mgmtMockBase: base("tx")}
	f.db.ReadFn = func(ctx context.Context, fn func(store.WebhookReadScope) error) error {
		if f.writeActive.Load() {
			f.db.need("nested read during write", false)
		}
		f.reads++
		if f.reads == 1 {
			return fn(f.pre)
		}
		if f.reads == 2 {
			return fn(f.post)
		}
		f.db.need("extra snapshot", false)
		return ctx.Err()
	}
	f.db.WriteFn = func(_ context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
		if o != f.owner || core.CanonicalUUID(id) != nil {
			t.Errorf("write identity=%v %s", o, id)
		}
		f.writeActive.Store(true)
		defer f.writeActive.Store(false)
		if err := fn(f.write); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	f.service = &Service{DB: f.db, Random: mgmtEntropy(), ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	return f
}
func (f *mgmtFixture) mutation(kind string) Mutation {
	return Mutation{Kind: kind, EndpointID: f.endpoint.ID, OperationID: "55555555-5555-4555-8555-555555555555", IssuedAt: f.now.Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: f.endpoint.ConfigVersion, RequestSHA256: strings.Repeat("a", 64)}
}
func (f *mgmtFixture) recordWrites() {
	f.writer.PutEndpointFn = func(_ context.Context, e wm.Endpoint) error {
		e.DestinationConfiguration = bytes.Clone(e.DestinationConfiguration)
		f.effects.endpoints = append(f.effects.endpoints, e)
		return nil
	}
	f.writer.DeleteSigningKeysFn = func(_ context.Context, id string) error {
		f.effects.deletedKeys = append(f.effects.deletedKeys, id)
		return nil
	}
	f.writer.PutSigningKeyFn = func(_ context.Context, k wm.SigningKey) error {
		k.Secret = bytes.Clone(k.Secret)
		f.effects.keys = append(f.effects.keys, k)
		return nil
	}
	f.writer.PutSubscriptionFn = func(_ context.Context, s wm.Subscription) error {
		f.effects.subscriptions = append(f.effects.subscriptions, s)
		return nil
	}
	f.writer.PutBindingFn = func(_ context.Context, b wm.Binding) error {
		f.effects.bindings = append(f.effects.bindings, b)
		return nil
	}
	f.writer.PutOperationFn = func(_ context.Context, o wm.Operation) error {
		f.effects.operations = append(f.effects.operations, o)
		return nil
	}
	f.redelivery.UpdateDeliveryFn = func(_ context.Context, d store.WebhookDelivery) error {
		d.Body = bytes.Clone(d.Body)
		f.effects.deliveries = append(f.effects.deliveries, d)
		return nil
	}
	f.redelivery.UpdateAttemptFn = func(_ context.Context, a store.WebhookAttempt) error {
		f.effects.attempts = append(f.effects.attempts, a)
		return nil
	}
}
func (f *mgmtFixture) respondMutation(m Mutation, ep wm.Endpoint, effect string, keys []wm.SigningKey) wm.Operation {
	f.t.Helper()
	if m.Name != nil {
		v, err := core.NormalizeName(*m.Name)
		if err != nil {
			f.t.Fatal(err)
		}
		m.Name = &v
	}
	fp, err := fingerprint(f.principal, f.owner, m)
	if err != nil {
		f.t.Fatal(err)
	}
	op := wm.Operation{Owner: f.owner, ID: m.OperationID, ActorID: f.principal.UserID, Kind: m.Kind, TargetID: ep.ID, IssuedAt: m.IssuedAt, RequestSHA256: m.RequestSHA256, Fingerprint: fp, Effect: effect, ConfigVersion: ep.ConfigVersion, DestinationRevisionAfter: ep.DestinationRevision, RecordedAt: f.now, ExpiresAt: f.now.Add(30 * 24 * time.Hour)}
	if m.Kind == "signing.rotate" {
		op.ActiveKeyID = ep.ActiveKeyID
		op.SigningMode = m.Mode
		for _, k := range keys {
			if k.Slot == "overlap" {
				op.OverlapUntil = k.OverlapUntil
			}
		}
	}
	f.postDAO.OperationFn = func(_ context.Context, o wm.Owner, id string) (wm.Operation, error) {
		if o != op.Owner || id != op.ID {
			f.t.Errorf("receipt identity=%v %s", o, id)
		}
		return op, nil
	}
	f.postDAO.EndpointFn = func(_ context.Context, o wm.Owner, id string) (wm.Endpoint, error) {
		if o != ep.Owner || id != ep.ID {
			f.t.Errorf("projection identity=%v %s", o, id)
		}
		return ep, nil
	}
	f.postDAO.SigningKeysFn = func(_ context.Context, id string) ([]wm.SigningKey, error) {
		if id != ep.ID {
			f.t.Errorf("projection signing endpoint=%s", id)
		}
		return keys, nil
	}
	f.postDAO.SubscriptionsFn = func(context.Context, string) ([]wm.Subscription, error) { return nil, nil }
	return op
}
func mgmtWantFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("fault=%v want=%s", err, code)
	}
}
func mgmtWantEqual[T any](t *testing.T, actual, expected T) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("got=%#v want=%#v", actual, expected)
	}
}
func (f *mgmtFixture) noEffects() {
	f.t.Helper()
	if f.effects.count() != 0 {
		f.t.Fatalf("refusal requested effects: %#v", f.effects)
	}
}
func (f *mgmtFixture) order(names ...string) {
	f.t.Helper()
	calls := f.trace.snapshot()
	at := 0
	for _, n := range names {
		found := false
		for at < len(calls) {
			v := calls[at]
			at++
			if v == n {
				found = true
				break
			}
		}
		if !found {
			f.t.Fatalf("missing order %v in %v", names, calls)
		}
	}
}
func (f *mgmtFixture) team(kind string, role model.ProjectRole) {
	f.owner = wm.Owner{Kind: "team", ID: "66666666-6666-4666-8666-666666666666"}
	f.endpoint.Owner = f.owner
	for _, d := range []*mgmtTeamDAO{f.preTeam, f.writeTeam, f.postTeam} {
		d.TeamFn = func(_ context.Context, user, id string) (model.Team, error) {
			if user != f.principal.UserID || id != f.owner.ID {
				f.t.Errorf("team query=%s %s", user, id)
			}
			return model.Team{TeamRef: model.TeamRef{ID: id, Kind: kind}, Membership: model.TeamMember{Role: role, UserID: user, TeamID: id}}, nil
		}
	}
}
func mgmtInvalidRead(t *testing.T, method string) {
	t.Helper()
	t.Errorf("unexpected read %s", method)
	panic(fmt.Sprintf("unexpected read %s", method))
}
