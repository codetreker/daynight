package webhook

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type scopedWriteFixture struct {
	store.WebhookWriteScope
	auth      model.CredentialAuthorization
	afterLock *model.CredentialAuthorization
}

func (s *scopedWriteFixture) LockCredential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	credential, err := s.WebhookWriteScope.LockCredential(ctx, p)
	if s.afterLock != nil {
		s.auth = *s.afterLock
	}
	return credential, err
}

func (s scopedWriteFixture) CurrentWebhookAuthorization(_ context.Context, p model.Principal, profile model.CredentialPolicyProfile) (model.CredentialAuthorization, error) {
	return s.auth, nil
}
func scopedMutationFixture(t *testing.T, scopes ...scopepolicy.ScopeID) (*mgmtFixture, model.CredentialAuthorization, *scopedWriteFixture) {
	f := newMgmtFixture(t)
	f.principal.Kind = model.PATCredential
	auth := webhookReadAuth(t, f.principal, scopes...)
	write := &scopedWriteFixture{WebhookWriteScope: f.write, auth: auth}
	f.db.WriteFn = func(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
		err := fn(write)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	f.recordWrites()
	return f, auth, write
}

func TestScopedWebhookMutationsRequireIndependentPermissions(t *testing.T) {
	for _, tc := range []struct {
		name   string
		scopes []scopepolicy.ScopeID
		kind   string
		full   bool
		change func(*mgmtFixture, *Mutation)
		want   string
	}{
		{"rename receipt", []scopepolicy.ScopeID{"webhook:write"}, "endpoint.update", false, func(f *mgmtFixture, m *Mutation) {
			m.Name = mgmtPtr("Renamed")
			f.service.ConfigurationExpansionAvailable = false
		}, ""},
		{"rename full needs read", []scopepolicy.ScopeID{"webhook:write"}, "endpoint.update", true, func(f *mgmtFixture, m *Mutation) { m.Name = mgmtPtr("Renamed") }, "insufficient_scope"},
		{"redirect needs deliver", []scopepolicy.ScopeID{"webhook:write"}, "endpoint.update", false, func(f *mgmtFixture, m *Mutation) {
			m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://other.example/path"}
		}, "insufficient_scope"},
		{"delete not write", []scopepolicy.ScopeID{"webhook:write"}, "endpoint.delete", false, nil, "insufficient_scope"},
		{"delete alone", []scopepolicy.ScopeID{"webhook:delete"}, "endpoint.delete", false, nil, ""},
		{"rotate not write", []scopepolicy.ScopeID{"webhook:write"}, "signing.rotate", false, func(f *mgmtFixture, m *Mutation) { m.Mode = "immediate" }, "insufficient_scope"},
		{"rotate alone", []scopepolicy.ScopeID{"webhook:secret"}, "signing.rotate", false, func(f *mgmtFixture, m *Mutation) { m.Mode = "immediate" }, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, auth, _ := scopedMutationFixture(t, tc.scopes...)
			m := f.mutation(tc.kind)
			m.ReturnReceipt = !tc.full
			if tc.change != nil {
				tc.change(f, &m)
			}
			result, err := f.service.MutateAuthorized(f.ctx, auth, f.owner, m)
			if tc.want != "" {
				mgmtWantFault(t, err, tc.want)
				f.noEffects()
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]any{"operationId": m.OperationID, "resourceId": f.endpoint.ID}
			if !reflect.DeepEqual(result.Body, want) {
				t.Fatalf("receipt=%#v", result.Body)
			}
			if len(f.effects.operations) != 1 || f.reads != 1 {
				t.Fatalf("effects=%+v reads=%d", f.effects, f.reads)
			}
		})
	}
}

func TestScopedWebhookCurrentPolicyAndSubscriptionExpansion(t *testing.T) {
	for _, tc := range []struct {
		name     string
		current  []scopepolicy.ScopeID
		events   []string
		disabled bool
		want     string
	}{
		{"narrow while dispatch disabled", []scopepolicy.ScopeID{"webhook:write"}, []string{"task.created"}, true, ""},
		{"expand requires delivery", []scopepolicy.ScopeID{"webhook:write"}, []string{"task.created", "task.paused", "task.status_changed"}, false, "insufficient_scope"},
		{"revoked write", []scopepolicy.ScopeID{"webhook:deliver"}, []string{"task.created"}, false, "insufficient_scope"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, auth, current := scopedMutationFixture(t, "webhook:deliver", "webhook:write")
			narrowed := webhookReadAuth(t, f.principal, tc.current...)
			current.afterLock = &narrowed
			sub, bindings := mgmtSubscription(f)
			mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: bindings})
			m := f.mutation("endpoint.update")
			m.ReturnReceipt = true
			m.HasSubscriptions = true
			m.Subscriptions = []core.SubscriptionInput{mgmtSubscriptionInput(sub, tc.events...)}
			if tc.disabled {
				f.service.ConfigurationExpansionAvailable = false
			}
			_, err := f.service.MutateAuthorized(f.ctx, auth, f.owner, m)
			if tc.want != "" {
				mgmtWantFault(t, err, tc.want)
				f.noEffects()
			} else if err != nil {
				t.Fatal(err)
			} else if len(f.effects.bindings) != 1 || f.effects.bindings[0].DeletedAt == nil {
				t.Fatalf("narrow effects=%+v", f.effects)
			}
		})
	}
}

func TestScopedWebhookRedeliveryNeedsDeliver(t *testing.T) {
	for _, scopes := range [][]scopepolicy.ScopeID{{"webhook:write"}, {"webhook:delete"}, {"webhook:deliver"}} {
		t.Run(string(scopes[0]), func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			r.principal.Kind = model.PATCredential
			auth := webhookReadAuth(t, r.principal, scopes...)
			current := &scopedWriteFixture{WebhookWriteScope: r.write, auth: auth}
			r.db.WriteFn = func(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
				err := fn(current)
				if err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}
			r.recordWrites()
			m := r.intent()
			m.ReturnReceipt = true
			got, err := r.service.RedeliverAuthorized(r.ctx, auth, r.owner, r.endpoint.ID, r.delivery.ID, m)
			if scopes[0] != "webhook:deliver" {
				mgmtWantFault(t, err, "insufficient_scope")
				r.noEffects()
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.Body, map[string]any{"operationId": m.OperationID, "resourceId": r.delivery.ID}) {
				t.Fatalf("receipt=%#v", got.Body)
			}
		})
	}
}

func TestScopedWebhookDoesNotDiscloseVersionsBeforeAdmission(t *testing.T) {
	for _, version := range []int64{1, 999} {
		f, auth, _ := scopedMutationFixture(t, "webhook:secret")
		m := f.mutation("endpoint.update")
		m.ReturnReceipt = true
		m.IfVersion = version
		m.Name = mgmtPtr("test")
		_, err := f.service.MutateAuthorized(f.ctx, auth, f.owner, m)
		mgmtWantFault(t, err, "insufficient_scope")
		f.noEffects()
	}
	for _, version := range []int64{1, 999} {
		r := newMgmtRedeliveryFixture(t)
		r.principal.Kind = model.PATCredential
		auth := webhookReadAuth(t, r.principal, "webhook:write")
		current := &scopedWriteFixture{WebhookWriteScope: r.write, auth: auth}
		r.db.WriteFn = func(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
			err := fn(current)
			if err != nil {
				return store.Completion{Outcome: store.TransactionNotCommitted}, err
			}
			return store.Completion{Outcome: store.TransactionCommitted}, nil
		}
		r.recordWrites()
		m := r.intent()
		m.ReturnReceipt = true
		m.IfVersion = version
		m.IfGeneration = version
		_, err := r.service.RedeliverAuthorized(r.ctx, auth, r.owner, r.endpoint.ID, r.delivery.ID, m)
		mgmtWantFault(t, err, "insufficient_scope")
		r.noEffects()
	}
}

func TestScopedWebhookDisabledDraftAndReconfirmation(t *testing.T) {
	t.Run("disabled draft without delivery", func(t *testing.T) {
		f, auth, _ := scopedMutationFixture(t, "webhook:write")
		f.service.ConfigurationExpansionAvailable = false
		m := f.mutation("endpoint.create")
		m.EndpointID = ""
		m.IfVersion = 0
		m.ReturnReceipt = true
		m.Name = mgmtPtr("Draft")
		m.Enabled = mgmtPtr(false)
		m.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/draft"}
		m.HasSubscriptions = true
		result, err := f.service.MutateAuthorized(f.ctx, auth, f.owner, m)
		if err != nil {
			t.Fatal(err)
		}
		receipt := result.Body.(map[string]any)
		if len(receipt) != 2 || receipt["operationId"] != m.OperationID || receipt["resourceId"] != mgmtRandomID(0) || len(f.effects.endpoints) != 1 || f.effects.endpoints[0].Enabled {
			t.Fatalf("receipt=%v effects=%+v", receipt, f.effects)
		}
	})
	t.Run("reconfirmation requires delivery", func(t *testing.T) {
		f, auth, _ := scopedMutationFixture(t, "webhook:write")
		f.endpoint.Enabled = false
		sub, bindings := mgmtSubscription(f)
		sub.AuthorizationState = "confirmation_required"
		mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: bindings})
		m := f.mutation("endpoint.update")
		m.ReturnReceipt = true
		m.ConfirmProjectIDs = []string{sub.ProjectID}
		_, err := f.service.MutateAuthorized(f.ctx, auth, f.owner, m)
		mgmtWantFault(t, err, "insufficient_scope")
		f.noEffects()
	})
}
