package webhook

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func TestRedeliveryRegistersManualIntentWithOriginalPlan(t *testing.T) {
	for _, open := range []bool{false, true} {
		for _, prior := range []int16{0, 1, 2} {
			t.Run(strings.Join([]string{map[bool]string{false: "closed", true: "open"}[open], string(rune('0' + prior))}, "/"), func(t *testing.T) {
				r := newMgmtRedeliveryFixture(t)
				r.delivery.AutomaticOpen = open
				r.delivery.ManualOperationCount = prior
				r.delivery.Generation = int64(prior) + 1
				r.delivery.AttemptSequence = prior + 1
				for i := int16(1); i <= prior+1; i++ {
					trigger := "manual"
					if i == 1 {
						trigger = "automatic"
					}
					outcome := "acknowledged"
					if prior == 2 && i == prior+1 {
						outcome = "http_error"
					}
					r.attempts = append(r.attempts, store.WebhookAttempt{ID: mgmtRandomID(64 + int(i)*16), DeliveryID: r.delivery.ID, EndpointID: r.endpoint.ID, Trigger: trigger, Generation: int64(i), Sequence: i, AdmittedAt: r.now.Add(-time.Duration(30-i) * time.Second), FinishedAt: mgmtPtr(r.now.Add(-time.Duration(20-i) * time.Second)), Outcome: &outcome})
				}
				if prior == 2 {
					r.delivery.State = "failed"
				}
				m := r.intent()
				expected := r.expectedDelivery(m)
				r.recordWrites()
				op := r.respond(m, expected)
				result, err := r.call(m)
				if err != nil || result.Replay {
					t.Fatalf("register=%#v %v", result, err)
				}
				mgmtWantEqual(t, r.effects.deliveries, []store.WebhookDelivery{expected})
				mgmtWantEqual(t, r.effects.operations, []wm.Operation{op})
				if len(r.effects.attempts) != 0 {
					t.Fatalf("registration invented attempt=%#v", r.effects.attempts)
				}
				original := r.delivery
				updated := r.effects.deliveries[0]
				mgmtWantEqual(t, updated.AutomaticScheduleAt, original.AutomaticScheduleAt)
				if updated.AutomaticOpen != open || updated.AutomaticAttemptCount != original.AutomaticAttemptCount || updated.AttemptSequence != original.AttemptSequence || !updated.AutomaticExpiresAt.Equal(original.AutomaticExpiresAt) || !updated.PayloadExpiresAt.Equal(original.PayloadExpiresAt) {
					t.Fatalf("changed original automatic plan=%#v", updated)
				}
				view := result.Body.(map[string]any)["delivery"].(map[string]any)
				if view["generation"] != version(expected.Generation) || view["manualOperationCount"] != expected.ManualOperationCount {
					t.Fatalf("projection=%#v", view)
				}
				r.order("redelivery.AdmissionSourcesForActor", "redelivery.LockDelivery", "redelivery.LockAttempts", "write.LockCredential", "redelivery.NextQueueOrder", "redelivery.UpdateDelivery", "write.dao.PutOperation", "post.dao.Operation")
			})
		}
	}
}

func TestRedeliveryReplayPreservesReceiptWithoutNewEffects(t *testing.T) {
	for _, kind := range []string{"normal", "dispatch disabled", "operation old", "changed raw digest", "conflict"} {
		t.Run(kind, func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			m := r.intent()
			if kind == "operation old" {
				m.IssuedAt = r.now.Add(-time.Hour).Format(time.RFC3339Nano)
			}
			op := r.respond(m, r.expectedDelivery(m))
			r.writer.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
			switch kind {
			case "dispatch disabled":
				r.service.DispatchEnabled = false
			case "changed raw digest":
				m.RequestSHA256 = strings.Repeat("c", 64)
			case "conflict":
				op.Fingerprint = "other intent"
			}
			r.postDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return op, nil }
			got, err := r.call(m)
			if kind == "conflict" {
				mgmtWantFault(t, err, "operation_conflict")
			} else {
				if err != nil || !got.Replay {
					t.Fatalf("replay=%#v %v", got, err)
				}
				view := got.Body.(map[string]any)["operation"].(map[string]any)
				if view["requestSha256"] != op.RequestSHA256 || view["issuedAt"] != op.IssuedAt {
					t.Fatalf("replay changed original receipt=%#v", view)
				}
			}
			r.noEffects()
			if mgmtCallNameCount(r.trace.snapshot(), "write.dao.Policy") != 0 {
				t.Fatal("replay repeated new-intent policy checks")
			}
		})
	}
}

func TestRedeliveryRejectsInvalidIdentityBeforeDAO(t *testing.T) {
	for _, kind := range []string{"operation", "actor", "endpoint", "delivery", "version", "generation", "time", "identity mismatch"} {
		t.Run(kind, func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			m := r.intent()
			endpoint, id := r.endpoint.ID, r.delivery.ID
			code := "invalid_input"
			switch kind {
			case "operation":
				m.OperationID = "bad"
			case "actor":
				m.ExpectedUserID = "bad"
			case "endpoint":
				endpoint = "bad"
			case "delivery":
				id = "bad"
			case "version":
				m.IfVersion = 0
			case "generation":
				m.IfGeneration = 0
			case "time":
				m.IssuedAt = "bad"
			case "identity mismatch":
				m.ExpectedUserID = "88888888-8888-4888-8888-888888888888"
				code = "identity_mismatch"
			}
			_, err := r.service.Redeliver(r.ctx, r.principal, r.owner, endpoint, id, m)
			mgmtWantFault(t, err, code)
			if len(r.trace.snapshot()) != 0 {
				t.Fatalf("invalid input accessed DAO=%v", r.trace.snapshot())
			}
		})
	}
}

func TestRedeliveryRefusalHasNoEffectCalls(t *testing.T) {
	cases := []struct {
		name, code string
		change     func(*mgmtRedeliveryFixture, *Redelivery)
	}{
		{"dispatch disabled", "webhooks_unavailable", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.service.DispatchEnabled = false }},
		{"stale configuration", "version_conflict", func(_ *mgmtRedeliveryFixture, m *Redelivery) { m.IfVersion = 2 }},
		{"stale generation", "generation_conflict", func(_ *mgmtRedeliveryFixture, m *Redelivery) { m.IfGeneration = 2 }},
		{"live lease", "delivery_busy", func(r *mgmtRedeliveryFixture, _ *Redelivery) {
			r.delivery.State = "leased"
			r.delivery.LeaseUntil = mgmtPtr(r.now.Add(time.Minute))
		}},
		{"lease without deadline", "delivery_busy", func(r *mgmtRedeliveryFixture, _ *Redelivery) {
			r.delivery.State = "leased"
			r.delivery.LeaseUntil = nil
		}},
		{"pending manual", "delivery_busy", func(r *mgmtRedeliveryFixture, _ *Redelivery) {
			r.delivery.State = "pending"
			r.delivery.Trigger = "manual"
		}},
		{"unadmitted expired manual", "delivery_busy", func(r *mgmtRedeliveryFixture, _ *Redelivery) {
			r.delivery.State = "leased"
			r.delivery.Trigger = "manual"
			r.delivery.LeaseUntil = mgmtPtr(r.now.Add(-time.Second))
		}},
		{"target changed", "target_changed", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.sources.Endpoint.DestinationRevision = 2 }},
		{"endpoint disabled", "delivery_stopped", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.sources.Endpoint.Enabled = false }},
		{"endpoint gone", "delivery_stopped", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.sources.EndpointPresent = false }},
		{"endpoint deleted", "delivery_stopped", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.sources.Endpoint.DeletedAt = mgmtPtr(r.now) }},
		{"project revoked", "delivery_stopped", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.sources.ProjectEligible = false }},
		{"task deleted", "delivery_stopped", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.sources.TaskPresent = false }},
		{"authorization gap", "delivery_stopped", func(r *mgmtRedeliveryFixture, _ *Redelivery) {
			r.sources.Matches[0].Continuous = false
			r.history.Matches[0].Continuous = false
		}},
		{"manual budget", "delivery_stopped", func(r *mgmtRedeliveryFixture, m *Redelivery) {
			r.delivery.ManualOperationCount = 3
			r.delivery.Generation = 4
			r.delivery.AttemptSequence = 4
			m.IfGeneration = 4
		}},
		{"missing original proof", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.sources.Matches = nil }},
		{"wrong original event", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) {
			r.sources.Event.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		}},
		{"wrong endpoint owner", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) {
			r.sources.Endpoint.Owner.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		}},
		{"wrong delivery owner", "not_found", func(r *mgmtRedeliveryFixture, _ *Redelivery) {
			r.delivery.Owner.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		}},
		{"wrong delivery endpoint", "not_found", func(r *mgmtRedeliveryFixture, _ *Redelivery) {
			r.delivery.EndpointID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
		}},
		{"fact removed prematurely", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.history.FactRemovedAt = mgmtPtr(r.now) }},
		{"fact bytes absent", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.history.Event.FactBytes = nil }},
		{"fact hash mismatch", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.history.Event.FactSHA256 = make([]byte, 32) }},
		{"payload absent", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.delivery.Body = nil }},
		{"payload removed", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.delivery.PayloadRemovedAt = mgmtPtr(r.now) }},
		{"payload reason", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.delivery.PayloadRemovedReason = mgmtPtr("removed") }},
		{"payload length", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.delivery.OriginalBodyBytes++ }},
		{"payload hash", "internal_error", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.delivery.BodySHA256 = make([]byte, 32) }},
		{"generation exhausted", "version_exhausted", func(r *mgmtRedeliveryFixture, m *Redelivery) {
			r.delivery.Generation = math.MaxInt64
			m.IfGeneration = math.MaxInt64
		}},
		{"credential expired", "unauthenticated", func(r *mgmtRedeliveryFixture, _ *Redelivery) {
			r.write.LockCredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
				return store.ThreadCredential{ExpiresAt: mgmtPtr(r.now)}, nil
			}
		}},
		{"operation expired", "operation_expired", func(r *mgmtRedeliveryFixture, m *Redelivery) {
			m.IssuedAt = r.now.Add(-301 * time.Second).Format(time.RFC3339Nano)
		}},
		{"operation future", "invalid_operation_time", func(r *mgmtRedeliveryFixture, m *Redelivery) {
			m.IssuedAt = r.now.Add(61 * time.Second).Format(time.RFC3339Nano)
		}},
		{"history expired", "not_found", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.delivery.MetadataExpiresAt = r.now }},
		{"history purging", "not_found", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.delivery.PurgingAt = mgmtPtr(r.now) }},
		{"payload expired", "payload_expired", func(r *mgmtRedeliveryFixture, _ *Redelivery) { r.delivery.PayloadExpiresAt = r.now }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			m := r.intent()
			c.change(r, &m)
			r.recordWrites()
			_, err := r.call(m)
			mgmtWantFault(t, err, c.code)
			r.noEffects()
		})
	}
}

func TestRedeliveryDeletedTaskAndRetainedHistory(t *testing.T) {
	r := newMgmtRedeliveryFixtureType(t, protocol.Deleted)
	r.sources.TaskPresent = false
	r.history.TaskPresent = false
	m := r.intent()
	r.recordWrites()
	r.respond(m, r.expectedDelivery(m))
	got, err := r.call(m)
	if err != nil || got.Replay {
		t.Fatalf("deleted source=%#v %v", got, err)
	}
	if len(r.effects.deliveries) != 1 {
		t.Fatalf("deleted source not registered=%#v", r.effects)
	}
}

func TestRedeliveryRechecksAfterEligibilityReads(t *testing.T) {
	for _, kind := range []string{"payload", "operation", "credential"} {
		t.Run(kind, func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			m := r.intent()
			deadline := r.now.Add(2 * time.Second)
			code := map[string]string{"payload": "payload_expired", "operation": "operation_expired", "credential": "unauthenticated"}[kind]
			switch kind {
			case "payload":
				r.delivery.PayloadExpiresAt = deadline
			case "operation":
				m.IssuedAt = deadline.Add(-5 * time.Minute).Format(time.RFC3339Nano)
			case "credential":
				r.write.LockCredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{ExpiresAt: &deadline}, nil
				}
			}
			observed := r.now
			reads := 0
			base := r.eligibility.ReadEligibilityFn
			r.eligibility.ReadEligibilityFn = func(ctx context.Context, o wm.Owner, p, a string) (store.WebhookEligibility, error) {
				reads++
				if reads == 2 {
					observed = deadline.Add(time.Nanosecond)
				}
				return base(ctx, o, p, a)
			}
			r.write.ObservedAtFn = func(context.Context) (time.Time, error) { return observed, nil }
			r.recordWrites()
			_, err := r.call(m)
			mgmtWantFault(t, err, code)
			r.noEffects()
			if reads != 2 {
				t.Fatalf("eligibility reads=%d", reads)
			}
			r.order("eligibility.ReadEligibility", "redelivery.NextQueueOrder", "write.ObservedAt")
		})
	}
}

func TestRedeliveryRecoversOnlyAdmittedExpiredAttempt(t *testing.T) {
	for _, kind := range []string{"unfinished admitted", "finished admitted", "unadmitted automatic", "missing attempt", "closed attempt", "wrong generation", "wrong token", "missing lease token"} {
		t.Run(kind, func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			r.delivery.State = "leased"
			r.delivery.LeaseUntil = mgmtPtr(r.now.Add(-time.Second))
			r.delivery.LeaseToken = mgmtPtr("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
			r.delivery.LeaseGeneration = mgmtPtr(r.delivery.Generation)
			a := store.WebhookAttempt{ID: "ffffffff-ffff-4fff-8fff-ffffffffffff", DeliveryID: r.delivery.ID, EndpointID: r.endpoint.ID, Trigger: "automatic", Generation: r.delivery.Generation, DestinationRevision: 1, Sequence: 1, LeaseToken: *r.delivery.LeaseToken, AdmittedAt: r.now.Add(-30 * time.Second), ClaimedAt: r.now.Add(-45 * time.Second)}
			r.delivery.CurrentAttemptID = &a.ID
			r.attempts = []store.WebhookAttempt{a}
			valid := true
			recover := false
			switch kind {
			case "unfinished admitted":
				recover = true
			case "finished admitted":
				a.FinishedAt = mgmtPtr(r.now.Add(-20 * time.Second))
				a.Outcome = mgmtPtr("acknowledged")
				r.attempts = []store.WebhookAttempt{a}
			case "unadmitted automatic":
				r.delivery.CurrentAttemptID = nil
				r.attempts = nil
			case "missing attempt":
				r.attempts = nil
				valid = false
			case "closed attempt":
				r.attempts[0].RetentionClosedAt = mgmtPtr(r.now)
				valid = false
			case "wrong generation":
				r.attempts[0].Generation++
				valid = false
			case "wrong token":
				r.attempts[0].LeaseToken = "other"
				valid = false
			case "missing lease token":
				r.delivery.LeaseToken = nil
				valid = false
			}
			m := r.intent()
			r.recordWrites()
			r.respond(m, r.expectedDelivery(m))
			got, err := r.call(m)
			if !valid {
				if err == nil {
					t.Fatal("invalid admitted history accepted")
				}
				r.noEffects()
				return
			}
			if err != nil || got.Replay {
				t.Fatalf("recovery=%#v %v", got, err)
			}
			mgmtWantEqual(t, r.effects.deliveries, []store.WebhookDelivery{r.expectedDelivery(m)})
			if recover {
				expected := a
				expected.FinishedAt = mgmtPtr(r.now)
				expected.Outcome = mgmtPtr("unknown")
				expected.RecoveredUnknownAt = mgmtPtr(r.now)
				mgmtWantEqual(t, r.effects.attempts, []store.WebhookAttempt{expected})
			} else if len(r.effects.attempts) != 0 {
				t.Fatalf("fabricated attempt=%#v", r.effects.attempts)
			}
		})
	}
}

func TestRedeliveryDependencyFailuresAndMissingReader(t *testing.T) {
	cause := errors.New("injected redelivery dependency failure")
	for _, phase := range []string{"initial snapshot", "receipt lookup", "policy", "initial clock", "sources", "delivery lock", "attempt locks", "credential", "locked clock", "history reader", "history sources", "eligibility", "ticket", "final clock", "delivery update", "receipt insert"} {
		t.Run(phase, func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			m := r.intent()
			r.recordWrites()
			r.respond(m, r.expectedDelivery(m))
			switch phase {
			case "initial snapshot":
				r.db.ReadFn = func(context.Context, func(store.WebhookReadScope) error) error { return cause }
			case "receipt lookup":
				r.writer.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return wm.Operation{}, cause }
			case "policy":
				r.writer.PolicyFn = func(context.Context, int64) (wm.Policy, error) { return wm.Policy{}, cause }
			case "initial clock", "locked clock", "final clock":
				n := 0
				fail := map[string]int{"initial clock": 1, "locked clock": 2, "final clock": 4}[phase]
				r.write.ObservedAtFn = func(context.Context) (time.Time, error) {
					n++
					if n == fail {
						return time.Time{}, cause
					}
					return r.now, nil
				}
			case "sources":
				r.redelivery.AdmissionSourcesForActorFn = func(context.Context, string, string, wm.Owner, string, time.Time) (store.WebhookAdmissionSources, error) {
					return store.WebhookAdmissionSources{}, cause
				}
			case "delivery lock":
				r.redelivery.LockDeliveryFn = func(context.Context, string) (store.WebhookDelivery, error) { return store.WebhookDelivery{}, cause }
			case "attempt locks":
				r.redelivery.LockAttemptsFn = func(context.Context, string) ([]store.WebhookAttempt, error) { return nil, cause }
			case "credential":
				r.write.LockCredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, cause
				}
			case "history reader":
				r.write.reader = mgmtBasicReader{WebhookReader: r.writer}
			case "history sources":
				r.writer.HistorySourcesFn = func(context.Context, store.WebhookDelivery, string) (store.WebhookHistorySources, error) {
					return store.WebhookHistorySources{}, cause
				}
			case "eligibility":
				r.eligibility.ReadEligibilityFn = func(context.Context, wm.Owner, string, string) (store.WebhookEligibility, error) {
					return store.WebhookEligibility{}, cause
				}
			case "ticket":
				r.redelivery.NextQueueOrderFn = func(context.Context) (int64, error) { return 0, cause }
			case "delivery update":
				r.redelivery.UpdateDeliveryFn = func(_ context.Context, d store.WebhookDelivery) error {
					r.effects.deliveries = append(r.effects.deliveries, d)
					return cause
				}
			case "receipt insert":
				r.writer.PutOperationFn = func(_ context.Context, o wm.Operation) error {
					r.effects.operations = append(r.effects.operations, o)
					return cause
				}
			}
			_, err := r.call(m)
			if phase == "history reader" {
				if err == nil || !strings.Contains(err.Error(), "history reader unavailable") {
					t.Fatalf("reader error=%v", err)
				}
			} else if !errors.Is(err, cause) {
				t.Fatalf("lost %s cause=%v", phase, err)
			}
			if phase == "delivery update" {
				if len(r.effects.deliveries) != 1 || len(r.effects.operations) != 0 {
					t.Fatalf("write failure attempted=%#v", r.effects)
				}
			} else if phase == "receipt insert" {
				if len(r.effects.deliveries) != 1 || len(r.effects.operations) != 1 {
					t.Fatalf("receipt failure attempted=%#v", r.effects)
				}
			} else {
				r.noEffects()
			}
		})
	}
}

func TestRedeliveryUnknownOutcomeAndPostCommitFailures(t *testing.T) {
	cause := errors.New("completion or projection unavailable")
	for _, phase := range []string{"unknown after callback", "unknown without error", "not committed without error", "projection snapshot", "projection operation", "projection credential", "projection delivery"} {
		t.Run(phase, func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			m := r.intent()
			r.recordWrites()
			r.respond(m, r.expectedDelivery(m))
			base := r.db.WriteFn
			switch phase {
			case "unknown after callback", "unknown without error", "not committed without error":
				r.db.WriteFn = func(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
					out, err := base(ctx, o, id, fn)
					if err != nil {
						return out, err
					}
					if phase == "not committed without error" {
						return store.Completion{Outcome: store.TransactionNotCommitted}, nil
					}
					if phase == "unknown without error" {
						return store.Completion{Outcome: store.TransactionUnknown}, nil
					}
					return store.Completion{Outcome: store.TransactionUnknown}, cause
				}
			case "projection snapshot":
				r.db.ReadFn = func(_ context.Context, fn func(store.WebhookReadScope) error) error {
					r.reads++
					if r.reads == 1 {
						return fn(r.pre)
					}
					return cause
				}
			case "projection operation":
				r.postDAO.OperationFn = func(context.Context, wm.Owner, string) (wm.Operation, error) { return wm.Operation{}, cause }
			case "projection credential":
				r.postCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, cause
				}
			case "projection delivery":
				r.postDAO.HistoryDeliveryFn = func(context.Context, wm.Owner, string, string) (store.WebhookDelivery, error) {
					return store.WebhookDelivery{}, cause
				}
			}
			got, err := r.call(m)
			mgmtWantFault(t, err, "write_outcome_unknown")
			if got.Body != nil {
				t.Fatalf("unknown exposed unverified result=%#v", got)
			}
			if !strings.HasSuffix(phase, "without error") && !errors.Is(err, cause) {
				t.Fatalf("lost completion cause=%v", err)
			}
			if len(r.effects.deliveries) != 1 || len(r.effects.operations) != 1 {
				t.Fatalf("transaction callback skipped=%#v", r.effects)
			}
		})
	}
}

func TestRedeliveryMissingEventReauthorizesAfterTransaction(t *testing.T) {
	for _, kind := range []string{"allowed", "credential revoked", "demoted", "database failure", "cleanup failure"} {
		t.Run(kind, func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			r.team("shared", model.ProjectAdmin)
			r.delivery.Owner = r.owner
			r.sources.Endpoint.Owner = r.owner
			missing := &store.WebhookAdmissionEventError{Cause: model.ErrNotFound}
			r.redelivery.AdmissionSourcesForActorFn = func(context.Context, string, string, wm.Owner, string, time.Time) (store.WebhookAdmissionSources, error) {
				return store.WebhookAdmissionSources{}, missing
			}
			cause := errors.New("database or cleanup failure")
			base := r.db.WriteFn
			switch kind {
			case "credential revoked":
				r.postCredential.CredentialFn = func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, model.ErrNotFound
				}
			case "demoted":
				r.postTeam.TeamFn = func(context.Context, string, string) (model.Team, error) {
					return model.Team{TeamRef: model.TeamRef{Kind: "shared"}, Membership: model.TeamMember{Role: model.ProjectMemberRole}}, nil
				}
			case "database failure", "cleanup failure":
				r.db.WriteFn = func(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
					out, err := base(ctx, o, id, fn)
					if kind == "database failure" {
						return out, errors.Join(err, &store.Error{DatabaseFailure: true, Cause: cause})
					}
					return out, errors.Join(err, &store.TransactionError{Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: cause})
				}
			}
			_, err := r.call(r.intent())
			switch kind {
			case "allowed":
				mgmtWantFault(t, err, "not_found")
			case "credential revoked":
				mgmtWantFault(t, err, "unauthenticated")
			case "demoted":
				mgmtWantFault(t, err, "forbidden")
			default:
				if !errors.Is(err, cause) || r.reads != 1 {
					t.Fatalf("database/cleanup error disguised: reads=%d err=%v", r.reads, err)
				}
			}
			r.noEffects()
			if kind == "allowed" || kind == "credential revoked" || kind == "demoted" {
				r.order("redelivery.AdmissionSourcesForActor", "post.credential.Credential")
			}
		})
	}
}

func TestRedeliveryHistoryCorruptionCannotCreateReceipt(t *testing.T) {
	for _, kind := range []string{"missing event", "removed fact", "missing match", "expired metadata", "payload expired", "purging"} {
		t.Run(kind, func(t *testing.T) {
			r := newMgmtRedeliveryFixture(t)
			code := "internal_error"
			switch kind {
			case "missing event":
				r.writer.HistorySourcesFn = func(context.Context, store.WebhookDelivery, string) (store.WebhookHistorySources, error) {
					return store.WebhookHistorySources{}, store.ErrWebhookHistoryEventMissing
				}
			case "removed fact":
				r.history.FactRemovedAt = mgmtPtr(r.now)
			case "missing match":
				r.history.Matches = nil
			case "expired metadata":
				r.delivery.MetadataExpiresAt = r.now
				code = "not_found"
			case "payload expired":
				r.delivery.PayloadExpiresAt = r.now
				code = "payload_expired"
			case "purging":
				r.delivery.PurgingAt = mgmtPtr(r.now)
				code = "not_found"
			}
			r.recordWrites()
			_, err := r.call(r.intent())
			mgmtWantFault(t, err, code)
			r.noEffects()
		})
	}
}
