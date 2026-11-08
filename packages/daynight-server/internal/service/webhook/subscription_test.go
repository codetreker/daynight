package webhook

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestSubscriptionIntentValidation(t *testing.T) {
	project := "77777777-7777-4777-8777-777777777777"
	id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	valid := core.SubscriptionInput{ID: &id, ProjectID: project, EventTypes: []string{"task.created"}}
	tests := []struct {
		name  string
		input Mutation
	}{
		{"project UUID", Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: "bad", EventTypes: []string{"task.created"}}}}},
		{"zero project", Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: "00000000-0000-0000-0000-000000000000", EventTypes: []string{"task.created"}}}}},
		{"empty events", Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: project}}}},
		{"bad subscription ID", Mutation{Subscriptions: []core.SubscriptionInput{{ID: mgmtPtr("bad"), ProjectID: project, EventTypes: []string{"task.created"}}}}},
		{"zero subscription ID", Mutation{Subscriptions: []core.SubscriptionInput{{ID: mgmtPtr("00000000-0000-0000-0000-000000000000"), ProjectID: project, EventTypes: []string{"task.created"}}}}},
		{"duplicate subscription", Mutation{Subscriptions: []core.SubscriptionInput{valid, valid}}},
		{"unknown event", Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.unknown"}}}}},
		{"duplicate event", Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created", "task.created"}}}}},
		{"invalid confirmation", Mutation{ConfirmProjectIDs: []string{"bad"}}},
		{"zero confirmation", Mutation{ConfirmProjectIDs: []string{"00000000-0000-0000-0000-000000000000"}}},
		{"duplicate confirmation", Mutation{ConfirmProjectIDs: []string{project, project}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { mgmtWantFault(t, validSubscriptionInput(tc.input), "invalid_input") })
	}
	if err := validSubscriptionInput(Mutation{Subscriptions: []core.SubscriptionInput{valid}, ConfirmProjectIDs: []string{project}}); err != nil {
		t.Fatal(err)
	}
}

func mgmtSubscription(f *mgmtFixture) (wm.Subscription, []wm.Binding) {
	sub := wm.Subscription{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", EndpointID: f.endpoint.ID, ProjectID: "77777777-7777-4777-8777-777777777777", Owner: f.owner, AuthorizationState: "active", AuthorizationEpoch: 4, CreatedAt: f.now.Add(-time.Hour), UpdatedAt: f.now.Add(-time.Hour)}
	bindings := []wm.Binding{{ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: sub.CreatedAt}, {ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", SubscriptionID: sub.ID, EventType: "task.paused", CreatedAt: sub.CreatedAt}}
	return sub, bindings
}
func mgmtSubscriptionInput(sub wm.Subscription, events ...string) core.SubscriptionInput {
	return core.SubscriptionInput{ID: mgmtPtr(sub.ID), ProjectID: sub.ProjectID, EventTypes: events}
}
func mgmtInstallSubscriptions(f *mgmtFixture, subs []wm.Subscription, bindings map[string][]wm.Binding) {
	f.t.Helper()
	f.writer.SubscriptionsFn = func(_ context.Context, id string) ([]wm.Subscription, error) {
		if id != f.endpoint.ID {
			f.t.Errorf("planned subscriptions=%s", id)
		}
		return append([]wm.Subscription(nil), subs...), nil
	}
	f.writer.LockSubscriptionsFn = f.writer.SubscriptionsFn
	f.writer.BindingsFn = func(_ context.Context, id string) ([]wm.Binding, error) {
		b, ok := bindings[id]
		if !ok {
			f.writer.need("unknown subscription bindings", false)
		}
		return append([]wm.Binding(nil), b...), nil
	}
	f.eligibility.ReadEligibilityFn = func(_ context.Context, o wm.Owner, project, actor string) (store.WebhookEligibility, error) {
		if o != f.owner || actor != f.principal.UserID {
			f.t.Errorf("subscription eligibility=%v %s", o, actor)
		}
		return store.WebhookEligibility{Status: "eligible", ProjectName: mgmtPtr("Project")}, nil
	}
}
func mgmtSubscriptionResponse(f *mgmtFixture, m Mutation, ep wm.Endpoint, effect string, subs []wm.Subscription, bindings map[string][]wm.Binding) wm.Operation {
	f.t.Helper()
	op := f.respondMutation(m, ep, effect, []wm.SigningKey{f.key})
	f.postDAO.SubscriptionsFn = func(_ context.Context, id string) ([]wm.Subscription, error) {
		if id != ep.ID {
			f.t.Errorf("subscription projection endpoint=%s", id)
		}
		return subs, nil
	}
	f.postDAO.BindingsFn = func(_ context.Context, id string) ([]wm.Binding, error) { return bindings[id], nil }
	return op
}

func TestSubscriptionEnrollmentRecordsCompleteIdentityAndSources(t *testing.T) {
	f := newMgmtFixture(t)
	m := f.mutation("endpoint.update")
	m.HasSubscriptions = true
	project := "77777777-7777-4777-8777-777777777777"
	m.Subscriptions = []core.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created", "task.paused"}}}
	mgmtInstallSubscriptions(f, nil, nil)
	var locked []string
	f.write.LockConfigurationSourcesFn = func(_ context.Context, o wm.Owner, actor string, projects []string) error {
		if o != f.owner || actor != f.principal.UserID {
			t.Fatal("wrong source authority")
		}
		locked = append([]string(nil), projects...)
		return nil
	}
	sub := wm.Subscription{ID: mgmtRandomID(0), EndpointID: f.endpoint.ID, ProjectID: project, Owner: f.owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: f.now, UpdatedAt: f.now}
	bindings := []wm.Binding{{ID: mgmtRandomID(16), SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: f.now}, {ID: mgmtRandomID(32), SubscriptionID: sub.ID, EventType: "task.paused", CreatedAt: f.now}}
	ep := f.endpoint
	ep.ConfigVersion = 2
	ep.UpdatedAt = f.now
	f.recordWrites()
	op := mgmtSubscriptionResponse(f, m, ep, "applied", []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: bindings})
	got, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
	if err != nil {
		t.Fatal(err)
	}
	mgmtWantEqual(t, locked, []string{project})
	mgmtWantEqual(t, f.effects.subscriptions, []wm.Subscription{sub})
	mgmtWantEqual(t, f.effects.bindings, bindings)
	mgmtWantEqual(t, f.effects.operations, []wm.Operation{op})
	subs := got.Body.(map[string]any)["endpoint"].(map[string]any)["subscriptions"].([]any)
	if len(subs) != 1 {
		t.Fatalf("subscriptions=%#v", subs)
	}
	f.order("write.LockConfigurationSources", "write.dao.LockEndpoint", "eligibility.ReadEligibility", "write.dao.PutSubscription", "write.dao.PutBinding", "write.dao.PutOperation")
}

func TestSubscriptionReplacementRetiresOldBindingBeforeNewIdentity(t *testing.T) {
	f := newMgmtFixture(t)
	sub, old := mgmtSubscription(f)
	mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: old})
	m := f.mutation("endpoint.update")
	m.HasSubscriptions = true
	m.Subscriptions = []core.SubscriptionInput{mgmtSubscriptionInput(sub, "task.created", "task.deleted")}
	retired := old[1]
	retired.DeletedAt = mgmtPtr(f.now)
	added := wm.Binding{ID: mgmtRandomID(0), SubscriptionID: sub.ID, EventType: "task.deleted", CreatedAt: f.now}
	ep := f.endpoint
	ep.ConfigVersion = 2
	ep.UpdatedAt = f.now
	f.recordWrites()
	mgmtSubscriptionResponse(f, m, ep, "applied", []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: {old[0], added}})
	if _, err := f.service.Mutate(f.ctx, f.principal, f.owner, m); err != nil {
		t.Fatal(err)
	}
	mgmtWantEqual(t, f.effects.bindings, []wm.Binding{retired, added})
	if len(f.effects.subscriptions) != 0 || added.ID == retired.ID {
		t.Fatalf("identity changed=%#v", f.effects)
	}
}

func TestSubscriptionRemovalAndEndpointDeletionRetireResponsibilities(t *testing.T) {
	for _, kind := range []string{"remove subscriptions", "delete endpoint"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			sub, old := mgmtSubscription(f)
			mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: old})
			m := f.mutation("endpoint.update")
			m.HasSubscriptions = true
			ep := f.endpoint
			ep.ConfigVersion = 2
			ep.UpdatedAt = f.now
			if kind == "delete endpoint" {
				m.Kind = "endpoint.delete"
				ep.Name = ""
				ep.Enabled = false
				ep.DeletedAt = mgmtPtr(f.now)
				ep.DestinationKind = ""
				ep.AdapterVersion = ""
				ep.Origin = ""
				ep.DestinationConfiguration = nil
				ep.ActiveKeyID = ""
			}
			expectedSub := sub
			expectedSub.DeletedAt = mgmtPtr(f.now)
			expectedSub.UpdatedAt = f.now
			retired := append([]wm.Binding(nil), old...)
			for i := range retired {
				retired[i].DeletedAt = mgmtPtr(f.now)
			}
			f.recordWrites()
			mgmtSubscriptionResponse(f, m, ep, "applied", nil, nil)
			if _, err := f.service.Mutate(f.ctx, f.principal, f.owner, m); err != nil {
				t.Fatal(err)
			}
			mgmtWantEqual(t, f.effects.subscriptions, []wm.Subscription{expectedSub})
			for _, b := range f.effects.bindings {
				if b.DeletedAt == nil || !b.DeletedAt.Equal(f.now) || b.SubscriptionID != sub.ID {
					t.Fatalf("retired binding=%#v", b)
				}
			}
			if len(f.effects.bindings) != len(retired) {
				t.Fatalf("binding retire count=%d", len(f.effects.bindings))
			}
		})
	}
}

func TestSubscriptionConfirmationPreservesEpochAndExpansionPolicy(t *testing.T) {
	for _, kind := range []string{"required", "required disabled", "redundant disabled", "revoked"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			sub, bindings := mgmtSubscription(f)
			bindings = bindings[:1]
			if kind != "redundant disabled" {
				sub.AuthorizationState = "confirmation_required"
			}
			mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: bindings})
			m := f.mutation("endpoint.update")
			m.ConfirmProjectIDs = []string{sub.ProjectID}
			f.service.ConfigurationExpansionAvailable = kind == "required" || kind == "revoked"
			if kind == "revoked" {
				f.eligibility.ReadEligibilityFn = func(context.Context, wm.Owner, string, string) (store.WebhookEligibility, error) {
					return store.WebhookEligibility{Status: "access_revoked"}, nil
				}
			}
			f.recordWrites()
			if kind == "required disabled" || kind == "revoked" {
				_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
				code := "webhooks_unavailable"
				if kind == "revoked" {
					code = "forbidden"
				}
				mgmtWantFault(t, err, code)
				f.noEffects()
				return
			}
			expected := sub
			ep := f.endpoint
			effect := "unchanged"
			if kind == "required" {
				expected.AuthorizationState = "active"
				expected.UpdatedAt = f.now
				ep.ConfigVersion = 2
				ep.UpdatedAt = f.now
				effect = "applied"
			}
			mgmtSubscriptionResponse(f, m, ep, effect, []wm.Subscription{expected}, map[string][]wm.Binding{sub.ID: bindings})
			got, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "required" {
				mgmtWantEqual(t, f.effects.subscriptions, []wm.Subscription{expected})
			} else if len(f.effects.subscriptions) != 0 || len(f.effects.bindings) != 0 || len(f.effects.endpoints) != 0 {
				t.Fatalf("redundant confirmation mutated=%#v", f.effects)
			}
			if len(f.effects.bindings) != 0 || got.Body.(map[string]any)["operation"].(map[string]any)["effect"] != effect {
				t.Fatalf("confirmation=%#v effects=%#v", got, f.effects)
			}
		})
	}
}

func TestSubscriptionNoOpRetainsIdentityAndAvoidsRewrites(t *testing.T) {
	f := newMgmtFixture(t)
	sub, b := mgmtSubscription(f)
	mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: b})
	m := f.mutation("endpoint.update")
	m.Name = mgmtPtr(f.endpoint.Name)
	f.recordWrites()
	op := mgmtSubscriptionResponse(f, m, f.endpoint, "unchanged", []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: b})
	if _, err := f.service.Mutate(f.ctx, f.principal, f.owner, m); err != nil {
		t.Fatal(err)
	}
	mgmtWantEqual(t, f.effects.operations, []wm.Operation{op})
	if f.effects.count() != 1 {
		t.Fatalf("no-op changed existing identities=%#v", f.effects)
	}
}

func TestSubscriptionPlanningUsesLockedVersionAndEligibleScope(t *testing.T) {
	for _, kind := range []string{"locked version changed", "source revoked", "actor demoted", "project revoked", "unknown subscription", "changed project", "confirmation not final", "expand disabled", "new binding disabled"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			sub, b := mgmtSubscription(f)
			mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: b})
			m := f.mutation("endpoint.update")
			m.HasSubscriptions = true
			m.Subscriptions = []core.SubscriptionInput{mgmtSubscriptionInput(sub, "task.created", "task.paused")}
			code := "forbidden"
			switch kind {
			case "locked version changed":
				f.writer.LockEndpointFn = func(context.Context, wm.Owner, string) (wm.Endpoint, error) {
					ep := f.endpoint
					ep.ConfigVersion = 2
					return ep, nil
				}
				code = "version_conflict"
			case "source revoked":
				f.write.LockConfigurationSourcesFn = func(context.Context, wm.Owner, string, []string) error { return model.ErrNotFound }
			case "actor demoted":
				f.team("shared", model.ProjectAdmin)
				sub.Owner = f.owner
				mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: b})
				f.write.LockConfigurationSourcesFn = func(context.Context, wm.Owner, string, []string) error {
					f.writeTeam.TeamFn = func(context.Context, string, string) (model.Team, error) {
						return model.Team{TeamRef: model.TeamRef{Kind: "shared"}, Membership: model.TeamMember{Role: model.ProjectMemberRole}}, nil
					}
					return nil
				}
			case "project revoked":
				m.Subscriptions = append(m.Subscriptions, core.SubscriptionInput{ProjectID: sub.ProjectID, EventTypes: []string{"task.created"}})
				f.eligibility.ReadEligibilityFn = func(context.Context, wm.Owner, string, string) (store.WebhookEligibility, error) {
					return store.WebhookEligibility{Status: "access_revoked"}, nil
				}
			case "unknown subscription":
				m.Subscriptions[0].ID = mgmtPtr("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
				code = "invalid_input"
			case "changed project":
				m.Subscriptions[0].ProjectID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
				code = "invalid_input"
			case "confirmation not final":
				m.ConfirmProjectIDs = []string{"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}
				code = "invalid_input"
			case "expand disabled":
				f.service.ConfigurationExpansionAvailable = false
				m.Subscriptions = append(m.Subscriptions, core.SubscriptionInput{ProjectID: sub.ProjectID, EventTypes: []string{"task.created"}})
				code = "webhooks_unavailable"
			case "new binding disabled":
				f.service.ConfigurationExpansionAvailable = false
				m.Subscriptions[0].EventTypes = append(m.Subscriptions[0].EventTypes, "task.deleted")
				code = "webhooks_unavailable"
			}
			f.recordWrites()
			_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			mgmtWantFault(t, err, code)
			f.noEffects()
		})
	}
}

func TestSubscriptionWriteFailureStopsSubsequentEffects(t *testing.T) {
	cause := errors.New("subscription write failed")
	for _, kind := range []string{"subscription insert", "binding insert", "binding retire"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			sub, b := mgmtSubscription(f)
			m := f.mutation("endpoint.update")
			m.HasSubscriptions = true
			f.recordWrites()
			if kind == "binding retire" {
				mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: b})
				m.Subscriptions = []core.SubscriptionInput{mgmtSubscriptionInput(sub, "task.created")}
				f.writer.PutBindingFn = func(_ context.Context, v wm.Binding) error {
					f.effects.bindings = append(f.effects.bindings, v)
					return &store.Error{DatabaseFailure: true, SQLState: "P0001", Cause: cause}
				}
			} else {
				mgmtInstallSubscriptions(f, nil, nil)
				m.Subscriptions = []core.SubscriptionInput{{ProjectID: sub.ProjectID, EventTypes: []string{"task.created"}}}
				if kind == "subscription insert" {
					f.writer.PutSubscriptionFn = func(_ context.Context, v wm.Subscription) error {
						f.effects.subscriptions = append(f.effects.subscriptions, v)
						return &store.Error{DatabaseFailure: true, SQLState: "P0001", Cause: cause}
					}
				} else {
					f.writer.PutBindingFn = func(_ context.Context, v wm.Binding) error {
						f.effects.bindings = append(f.effects.bindings, v)
						return &store.Error{DatabaseFailure: true, SQLState: "P0001", Cause: cause}
					}
				}
			}
			_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
			failed, state := store.DatabaseErrorFacts(err)
			if !failed || state != "P0001" || !errors.Is(err, cause) {
				t.Fatalf("error lost facts=%v", err)
			}
			if len(f.effects.endpoints) != 1 || len(f.effects.operations) != 0 || len(f.effects.deletedKeys) != 0 || len(f.effects.keys) != 0 {
				t.Fatalf("continued after failed save=%#v", f.effects)
			}
			if kind == "subscription insert" && len(f.effects.bindings) != 0 {
				t.Fatal("binding write followed subscription failure")
			}
		})
	}
}

func TestSubscriptionRejectsCorruptStoredIdentities(t *testing.T) {
	for _, kind := range []string{"endpoint", "owner", "epoch", "authorization state", "no bindings", "wrong subscription binding", "unknown event", "duplicate event", "binding read failure"} {
		t.Run(kind, func(t *testing.T) {
			f := newMgmtFixture(t)
			sub, b := mgmtSubscription(f)
			cause := errors.New("binding lookup failed")
			switch kind {
			case "endpoint":
				sub.EndpointID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
			case "owner":
				sub.Owner.ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
			case "epoch":
				sub.AuthorizationEpoch = 0
			case "authorization state":
				sub.AuthorizationState = "unexpected"
			case "no bindings":
				b = nil
			case "wrong subscription binding":
				b[0].SubscriptionID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
			case "unknown event":
				b[0].EventType = "task.invalid"
			case "duplicate event":
				b[1].EventType = b[0].EventType
			}
			mgmtInstallSubscriptions(f, []wm.Subscription{sub}, map[string][]wm.Binding{sub.ID: b})
			if kind == "binding read failure" {
				f.writer.BindingsFn = func(context.Context, string) ([]wm.Binding, error) { return nil, cause }
			}
			f.recordWrites()
			_, err := f.service.Mutate(f.ctx, f.principal, f.owner, f.mutation("endpoint.update"))
			if err == nil {
				t.Fatal("corrupt subscription accepted")
			}
			if kind == "binding read failure" && !errors.Is(err, cause) {
				t.Fatalf("lost binding error=%v", err)
			}
			f.noEffects()
		})
	}
}

func TestSubscriptionViewsHideRevokedNamesAndRejectUnknownEligibility(t *testing.T) {
	for _, status := range []string{"eligible", "access_revoked", "owner_scope_changed", "resource_unavailable", "unknown"} {
		t.Run(status, func(t *testing.T) {
			f := newMgmtFixture(t)
			sub, b := mgmtSubscription(f)
			f.preDAO.SubscriptionsFn = func(context.Context, string) ([]wm.Subscription, error) { return []wm.Subscription{sub}, nil }
			f.preDAO.BindingsFn = func(context.Context, string) ([]wm.Binding, error) { return b, nil }
			f.eligibility.ReadEligibilityFn = func(context.Context, wm.Owner, string, string) (store.WebhookEligibility, error) {
				return store.WebhookEligibility{Status: status, ProjectName: mgmtPtr("Secret Project")}, nil
			}
			v, err := f.service.subscriptionViews(f.ctx, f.pre, f.endpoint, f.principal.UserID)
			if status == "unknown" {
				if err == nil {
					t.Fatalf("unknown eligibility returned=%#v", v)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			name := v[0].(map[string]any)["projectName"].(*string)
			if status == "eligible" {
				if name == nil || *name != "Secret Project" {
					t.Fatal("eligible name absent")
				}
			} else if name != nil {
				t.Fatalf("revoked name exposed=%s", *name)
			}
		})
	}
}

func TestSubscriptionEntropyErrorDoesNotSavePartialPlan(t *testing.T) {
	f := newMgmtFixture(t)
	mgmtInstallSubscriptions(f, nil, nil)
	m := f.mutation("endpoint.update")
	m.HasSubscriptions = true
	m.Subscriptions = []core.SubscriptionInput{{ProjectID: "77777777-7777-4777-8777-777777777777", EventTypes: []string{"task.created"}}}
	f.service.Random = io.LimitReader(mgmtEntropy(), 16)
	f.recordWrites()
	_, err := f.service.Mutate(f.ctx, f.principal, f.owner, m)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("entropy cause=%v", err)
	}
	f.noEffects()
}

func TestConfigurationSourceProjectsAreSortedAndDeduplicated(t *testing.T) {
	a := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	b := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	c := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	got := configurationProjects([]wm.Subscription{{ProjectID: b}, {ProjectID: a}}, Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: c}, {ProjectID: b}}, ConfirmProjectIDs: []string{a, c}})
	if !reflect.DeepEqual(got, []string{a, b, c}) {
		t.Fatalf("source projects=%v", got)
	}
}
