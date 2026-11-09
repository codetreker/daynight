package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func TestHistoryPayloadPreservesExactOriginalBytes(t *testing.T) {
	f := newHistoryScenario(t)
	f.d.Body = append([]byte(`{"data":"<script>original</script>"}`), bytes.Repeat([]byte(" "), 65536-len(`{"data":"<script>original</script>"}`))...)
	f.d.OriginalBodyBytes = len(f.d.Body)
	sum := sha256.Sum256(f.d.Body)
	f.d.BodySHA256 = sum[:]
	for _, title := range []string{"original title", "changed current title"} {
		f.src.TaskTitle = &title
		v, err := f.service.Payload(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID)
		retentionFail(t, err)
		p := v.(map[string]any)
		b, err := base64.StdEncoding.DecodeString(p["body"].(string))
		if err != nil || !bytes.Equal(b, f.d.Body) || p["bytes"] != 65536 || p["sha256"] != hex.EncodeToString(sum[:]) || p["encoding"] != "base64" || p["mediaType"] != f.d.RequestMediaType {
			t.Fatalf("payload result=%v err=%v", p, err)
		}
		if p["owner"].(map[string]any)["id"] != f.owner.ID || p["endpointId"] != f.d.EndpointID || p["deliveryId"] != f.d.ID || p["eventId"] != f.d.EventID {
			t.Fatal("payload identity changed")
		}
	}
}

func TestHistoryPayloadFailsClosedForCorruptCapturedData(t *testing.T) {
	for _, kind := range []string{"delivery hash", "missing body", "oversize body", "body size", "premature removal", "event hash", "missing fact", "fact size", "removed fact", "event identity", "match digest", "missing original event"} {
		t.Run(kind, func(t *testing.T) {
			f := newHistoryScenario(t)
			switch kind {
			case "delivery hash":
				f.d.BodySHA256 = []byte("wrong")
			case "missing body":
				f.d.Body = nil
			case "oversize body":
				f.d.Body = bytes.Repeat([]byte("x"), 65537)
				f.d.OriginalBodyBytes = len(f.d.Body)
				h := sha256.Sum256(f.d.Body)
				f.d.BodySHA256 = h[:]
			case "body size":
				f.d.OriginalBodyBytes++
			case "premature removal":
				f.d.PayloadRemovedAt = &retentionTestNow
			case "event hash":
				f.src.Event.FactSHA256 = []byte("wrong")
			case "missing fact":
				f.src.Event.FactBytes = nil
			case "fact size":
				f.src.OriginalFactBytes++
			case "removed fact":
				f.src.FactRemovedAt = &retentionTestNow
			case "event identity":
				f.src.Event.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			case "match digest":
				f.d.OriginalMatchSHA256 = []byte("wrong")
			case "missing original event":
				f.reader.sources = func(context.Context, store.WebhookDelivery, string) (store.WebhookHistorySources, error) {
					return store.WebhookHistorySources{}, store.ErrWebhookHistoryEventMissing
				}
			}
			value, err := f.service.Payload(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID)
			historyFaultCode(t, err, "internal_error")
			if value != nil {
				t.Fatalf("corruption returned payload: %v", value)
			}
		})
	}
}

func TestHistoryPayloadDeadlineAndCurrentAccess(t *testing.T) {
	for _, kind := range []string{"before deadline", "exact deadline", "after deadline", "project unreadable", "task absent", "deleted event", "step absent"} {
		t.Run(kind, func(t *testing.T) {
			f := newHistoryScenario(t)
			want := ""
			switch kind {
			case "before deadline":
				f.d.PayloadExpiresAt = retentionTestNow.Add(time.Nanosecond)
			case "exact deadline":
				f.d.PayloadExpiresAt = retentionTestNow
				want = "payload_expired"
			case "after deadline":
				f.d.PayloadExpiresAt = retentionTestNow.Add(-time.Nanosecond)
				want = "payload_expired"
			case "project unreadable":
				f.src.ProjectReadable = false
				want = "forbidden"
			case "task absent":
				f.src.TaskPresent = false
				want = "forbidden"
			case "deleted event":
				f.src.TaskPresent = false
				f.d.EventType = protocol.Deleted
				f.src.Event.EventType = protocol.Deleted
				f.src.Matches[0].EventType = protocol.Deleted
				f.d.OriginalMatchSHA256, _ = MatchDigest([]store.WebhookCapturedMatch{f.src.Matches[0].WebhookCapturedMatch})
			case "step absent":
				step := int64(1)
				f.src.Event.StepID = &step
			}
			v, err := f.service.Payload(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID)
			if want != "" {
				historyFaultCode(t, err, want)
				if v != nil {
					t.Fatalf("refused payload=%v", v)
				}
			} else if err != nil || v == nil {
				t.Fatalf("eligible original payload %v %v", v, err)
			}
		})
	}
}

func TestHistoryProjectionSeparatesDisclosureFromSendEligibility(t *testing.T) {
	for _, kind := range []string{"eligible", "source revoked", "project unreadable", "task deleted", "binding revoked", "endpoint gone", "destination replaced", "member", "deleted event"} {
		t.Run(kind, func(t *testing.T) {
			f := newHistoryScenario(t)
			full, eligible, manage := true, true, true
			switch kind {
			case "source revoked":
				f.scope.eligibility = historyEligibilityMock{t: t, read: func(context.Context, Owner, string, string) (store.WebhookEligibility, error) {
					return store.WebhookEligibility{Status: "revoked"}, nil
				}}
				eligible = false
			case "project unreadable":
				f.src.ProjectReadable = false
				full = false
			case "task deleted":
				f.src.TaskPresent = false
				full, eligible = false, false
			case "binding revoked":
				f.src.Matches[0].Continuous = false
				eligible = false
			case "endpoint gone":
				f.reader.endpoint = func(context.Context, Owner, string) (wm.Endpoint, error) { return wm.Endpoint{}, model.ErrNotFound }
				f.reader.deliveries = func(context.Context, Owner, string, time.Time, string, int) ([]store.WebhookDelivery, error) {
					return []store.WebhookDelivery{f.d}, nil
				}
				eligible = false
			case "destination replaced":
				f.endpoint.DestinationRevision = 2
				eligible = false
			case "member":
				f.owner = Owner{Kind: "team", ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
				f.d.Owner = f.owner
				f.endpoint.Owner = f.owner
				f.scope.team = historyTeamMock{t: t, read: func(_ context.Context, u, id string) (model.Team, error) {
					if u != f.principal.UserID || id != f.owner.ID {
						t.Errorf("team args %s %s", u, id)
					}
					return model.Team{TeamRef: model.TeamRef{ID: id, Kind: "shared"}, Membership: model.TeamMember{Role: model.ProjectMemberRole}}, nil
				}}
				manage = false
			case "deleted event":
				f.src.TaskPresent = false
				f.d.EventType = protocol.Deleted
				f.src.Event.EventType = protocol.Deleted
				f.src.Matches[0].EventType = protocol.Deleted
				f.d.OriginalMatchSHA256, _ = MatchDigest([]store.WebhookCapturedMatch{f.src.Matches[0].WebhookCapturedMatch})
			}
			v := f.get(t)
			wantDisclosure := "full"
			if !full {
				wantDisclosure = "metadata_only"
			}
			wantState := "pending"
			if !eligible {
				wantState = "suppressed"
			}
			if v["disclosure"] != wantDisclosure || v["state"] != wantState || v["payloadAvailable"] != full {
				t.Fatalf("projection %+v", v)
			}
			resource := v["resource"].(map[string]any)
			target := v["target"].(map[string]any)
			if !full {
				for _, k := range []string{"projectId", "taskId", "stepId", "messageId", "displayName"} {
					if resource[k] != nil {
						t.Fatalf("metadata disclosed %s=%v", k, resource[k])
					}
				}
				if v["eventType"] != nil || v["resourceVersion"] != nil || target["url"] != nil || target["displayUrl"] != nil {
					t.Fatalf("metadata target/event leak: %v", v)
				}
				encoded, err := json.Marshal(v)
				if err != nil {
					t.Fatal(err)
				}
				for _, private := range []string{f.d.ProjectID, f.src.Event.TaskID, *f.src.TaskTitle, "receiver.example", "token=secret"} {
					if strings.Contains(string(encoded), private) {
						t.Fatalf("metadata disclosed %q: %s", private, encoded)
					}
				}
			} else {
				if resource["projectId"] != f.d.ProjectID || v["resourceVersion"] != "7" {
					t.Fatalf("full source missing: %v", v)
				}
				if manage {
					if target["url"] != "https://receiver.example/private?token=secret" {
						t.Fatal("manager original target missing")
					}
				} else if target["url"] != nil || target["displayUrl"] != "https://receiver.example/…" {
					t.Fatalf("member target=%v", target)
				}
			}
		})
	}
}

func TestHistoryMissingEndpointRequiresRetainedDelivery(t *testing.T) {
	for _, retained := range []bool{false, true} {
		t.Run(fmt.Sprint(retained), func(t *testing.T) {
			f := newHistoryScenario(t)
			f.reader.endpoint = func(context.Context, Owner, string) (wm.Endpoint, error) { return wm.Endpoint{}, model.ErrNotFound }
			f.reader.deliveries = func(_ context.Context, o Owner, e string, a time.Time, id string, n int) ([]store.WebhookDelivery, error) {
				if o != f.owner || e != f.d.EndpointID || !a.IsZero() || id != "" || n != 1 {
					t.Fatal("wrong retained endpoint check")
				}
				if retained {
					return []store.WebhookDelivery{f.d}, nil
				}
				return nil, nil
			}
			v, err := f.service.GetDelivery(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID)
			if retained {
				if err != nil || v == nil || v.(map[string]any)["state"] != "suppressed" {
					t.Fatalf("retained delivery %v %v", v, err)
				}
			} else {
				historyFaultCode(t, err, "not_found")
			}
		})
	}
}

func TestHistoryPropagatesDependencyErrors(t *testing.T) {
	failure := errors.New("private database marker")
	for _, kind := range []string{"snapshot", "credential", "team", "endpoint", "sources", "clock", "eligibility", "attempts", "history delivery", "history list", "disclosure", "policy", "clock after source"} {
		t.Run(kind, func(t *testing.T) {
			f := newHistoryScenario(t)
			operation := func() (any, error) {
				return f.service.GetDelivery(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID)
			}
			switch kind {
			case "snapshot":
				f.service.DB = historyTransactionsMock{t: t, read: func(context.Context, func(store.WebhookReadScope) error) error { return failure }}
			case "credential":
				f.scope.credential = historyCredentialMock{t: t, read: func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, failure
				}}
			case "team":
				f.owner.Kind = "team"
				f.scope.team = historyTeamMock{t: t, read: func(context.Context, string, string) (model.Team, error) { return model.Team{}, failure }}
			case "endpoint":
				f.reader.endpoint = func(context.Context, Owner, string) (wm.Endpoint, error) { return wm.Endpoint{}, failure }
			case "sources":
				f.reader.sources = func(context.Context, store.WebhookDelivery, string) (store.WebhookHistorySources, error) {
					return store.WebhookHistorySources{}, failure
				}
			case "clock":
				f.scope.now = func(context.Context) (time.Time, error) { return time.Time{}, failure }
			case "clock after source":
				n := 0
				f.scope.now = func(context.Context) (time.Time, error) {
					n++
					if n == 2 {
						return time.Time{}, failure
					}
					return retentionTestNow, nil
				}
			case "eligibility":
				f.scope.eligibility = historyEligibilityMock{t: t, read: func(context.Context, Owner, string, string) (store.WebhookEligibility, error) {
					return store.WebhookEligibility{}, failure
				}}
			case "attempts":
				f.reader.attempts = func(context.Context, string) ([]store.WebhookAttempt, error) { return nil, failure }
			case "history delivery":
				f.reader.delivery = func(context.Context, Owner, string, string) (store.WebhookDelivery, error) {
					return store.WebhookDelivery{}, failure
				}
			case "history list":
				f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
					return store.WebhookHistoryBatch{}, failure
				}
				operation = func() (any, error) {
					return f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{})
				}
			case "disclosure":
				f.reader.disclosure = func(context.Context, Owner, string, string, time.Time) (string, error) { return "", failure }
				operation = func() (any, error) {
					return f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{})
				}
			case "policy":
				f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
					return store.WebhookHistoryBatch{}, nil
				}
				f.reader.policy = func(context.Context, int64) (wm.Policy, error) { return wm.Policy{}, failure }
				operation = func() (any, error) {
					return f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{})
				}
			}
			v, err := operation()
			if !errors.Is(err, failure) {
				t.Fatalf("lost %s failure: %v %v", kind, v, err)
			}
			historyAssertNoProjection(t, v)
		})
	}
}

func TestHistoryAuthorizationRejectsBeforeReadingResource(t *testing.T) {
	for _, kind := range []string{"invalid principal", "other personal owner", "missing credential", "other team", "personal team", "invalid owner"} {
		t.Run(kind, func(t *testing.T) {
			f := newHistoryScenario(t)
			want := "forbidden"
			switch kind {
			case "invalid principal":
				f.principal.Kind = "invalid"
				want = "unauthenticated"
			case "other personal owner":
				f.owner.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			case "missing credential":
				f.scope.credential = historyCredentialMock{t: t, read: func(context.Context, model.Principal) (store.ThreadCredential, error) {
					return store.ThreadCredential{}, model.ErrNotFound
				}}
				want = "unauthenticated"
			case "other team":
				f.owner.Kind = "team"
				f.scope.team = historyTeamMock{t: t, read: func(context.Context, string, string) (model.Team, error) { return model.Team{}, model.ErrNotFound }}
			case "personal team":
				f.owner.Kind = "team"
				f.scope.team = historyTeamMock{t: t, read: func(context.Context, string, string) (model.Team, error) {
					return model.Team{TeamRef: model.TeamRef{Kind: "personal"}}, nil
				}}
			case "invalid owner":
				f.owner.Kind = "invalid"
				want = "invalid_input"
			}
			f.reader.endpoint = nil
			v, err := f.service.GetDelivery(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID)
			historyFaultCode(t, err, want)
			if v != nil {
				t.Fatal("unauthorized resource returned")
			}
		})
	}
}

func TestHistoryAttemptProjectionPreservesAcknowledgementAndLateResult(t *testing.T) {
	f := newHistoryScenario(t)
	ack, fail, late := "acknowledged", "http_error", "timeout"
	one, two, three := retentionTestNow.Add(-3*time.Minute), retentionTestNow.Add(-2*time.Minute), retentionTestNow.Add(-time.Minute)
	status := int16(503)
	duration := int64(17)
	code := "http_503"
	f.reader.attempts = func(context.Context, string) ([]store.WebhookAttempt, error) {
		return []store.WebhookAttempt{{ID: "a", AdmittedAt: one, FinishedAt: &one, Outcome: &ack}, {ID: "b", AdmittedAt: two, FinishedAt: &two, Outcome: &fail, HTTPStatus: &status, ErrorCode: &code, DurationMS: &duration, LateObservedAt: &three, LateOutcome: &late}}, nil
	}
	v := f.get(t)
	if !v["lastAcknowledgedAt"].(*time.Time).Equal(one) || !v["lastAttemptAt"].(*time.Time).Equal(two) || v["lastResult"].(map[string]any)["category"] != &late {
		t.Fatalf("attempt projection=%v", v)
	}
	a := store.WebhookAttempt{Outcome: &fail, ErrorCode: &code, LateOutcome: &late, LateErrorCode: &code, HTTPStatus: &status, DurationMS: &duration}
	result := AttemptResult(a).(map[string]any)
	if result["category"] != &late || result["code"] != &code {
		t.Fatalf("late outcome=%v", result)
	}
	view := attemptView(a).(map[string]any)
	if view["error"].(map[string]any)["message"] != "Webhook delivery failed." {
		t.Fatalf("unsafe error=%v", view)
	}
	if AttemptResult(store.WebhookAttempt{}) != nil {
		t.Fatal("unobserved attempt had result")
	}
}

func TestHistoryFullProjectionIncludesStepAndMessageIdentity(t *testing.T) {
	for _, kind := range []string{"step", "thread"} {
		t.Run(kind, func(t *testing.T) {
			f := newHistoryScenario(t)
			if kind == "step" {
				step := int64(1)
				f.src.Event.StepID = &step
				f.d.EventType = protocol.StepUpdated
			} else {
				message := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
				f.src.Event.MessageID = &message
				f.src.Event.TaskVersion = nil
				f.d.EventType = protocol.ThreadPosted
			}
			f.src.Event.EventType = f.d.EventType
			f.src.Matches[0].EventType = f.d.EventType
			f.d.OriginalMatchSHA256, _ = MatchDigest([]store.WebhookCapturedMatch{f.src.Matches[0].WebhookCapturedMatch})
			view := f.get(t)
			resource := view["resource"].(map[string]any)
			if kind == "step" && resource["stepId"] != "00000001" || kind == "thread" && resource["messageId"] != f.src.Event.MessageID || resource["displayName"] != f.src.TaskTitle {
				t.Fatalf("full event identity=%v", resource)
			}
			f.d.DestinationConfiguration = []byte("invalid target")
			value, err := f.service.GetDelivery(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID)
			if err == nil || !strings.Contains(err.Error(), "decode stored destination") {
				t.Fatalf("corrupt captured target returned %v %v", value, err)
			}
			historyAssertNoProjection(t, value)
		})
	}
}
