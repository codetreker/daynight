package webhook

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func TestCaptureRejectsInvalidBatchBeforeDAO(t *testing.T) {
	valid := captureFact(protocol.Created)
	for _, tc := range []struct {
		name  string
		facts func() []protocol.Fact
	}{
		{"empty", func() []protocol.Fact { return nil }},
		{"too many", func() []protocol.Fact { return []protocol.Fact{valid, valid, valid} }},
		{"duplicate type", func() []protocol.Fact { return []protocol.Fact{valid, valid} }},
		{"different projects", func() []protocol.Fact {
			other := captureFact(protocol.Paused)
			other.ProjectID = captureOwnerID
			return []protocol.Fact{valid, other}
		}},
		{"invalid task identity", func() []protocol.Fact { f := valid; f.TaskID = "missing"; return []protocol.Fact{f} }},
		{"zero version", func() []protocol.Fact { f := valid; f.TaskVersion = 0; return []protocol.Fact{f} }},
		{"unknown event", func() []protocol.Fact { f := valid; f.Type = "task.unknown"; return []protocol.Fact{f} }},
		{"unchanged status", func() []protocol.Fact {
			f := captureFact(protocol.StatusChanged)
			f.Status = f.PreviousStatus
			return []protocol.Fact{f}
		}},
		{"wrong created fields", func() []protocol.Fact { f := valid; f.PreviousStatus = "todo"; return []protocol.Fact{f} }},
		{"invalid step", func() []protocol.Fact {
			f := captureFact(protocol.StepUpdated)
			f.StepID = "1"
			return []protocol.Fact{f}
		}},
		{"wrong deletion time", func() []protocol.Fact {
			f := captureFact(protocol.Deleted)
			at := f.OccurredAt.Add(time.Second)
			f.DeletedAt = &at
			return []protocol.Fact{f}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := newCaptureDAOMock(t)
			if err := (&Capturer{}).CaptureBatch(t.Context(), dao, tc.facts()); err == nil {
				t.Fatal("invalid batch accepted")
			}
		})
	}
	t.Run("missing DAO", func(t *testing.T) {
		if err := (&Capturer{}).CaptureBatch(t.Context(), nil, []protocol.Fact{valid}); err == nil {
			t.Fatal("missing DAO accepted")
		}
	})
	t.Run("request ID too long", func(t *testing.T) {
		dao := newCaptureDAOMock(t)
		c := &Capturer{RequestID: func(context.Context) string { return strings.Repeat("x", 129) }}
		if err := c.CaptureBatch(t.Context(), dao, []protocol.Fact{valid}); err == nil {
			t.Fatal("oversized request ID accepted")
		}
	})
}

func TestCaptureEmptyAudienceStopsBeforePolicyAndPersistence(t *testing.T) {
	dao := newCaptureDAOMock(t, "freeze")
	dao.freeze = func(context.Context, string, []string) ([]store.WebhookAudience, error) { return nil, nil }
	if err := (&Capturer{}).CaptureBatch(t.Context(), dao, []protocol.Fact{captureFact(protocol.Created)}); err != nil {
		t.Fatal(err)
	}
	if len(dao.writes) != 0 {
		t.Fatal("empty audience produced a write")
	}
}

func TestCaptureDAOFailuresPreserveCauseAndStop(t *testing.T) {
	for _, phase := range []string{"freeze", "policy", "recorded", "save"} {
		t.Run(phase, func(t *testing.T) {
			cause := errors.New("injected " + phase + " failure")
			a := captureAudience(t, protocol.Created)
			dao := captureSuccessfulDAO(t, []store.WebhookAudience{a}, 1)
			switch phase {
			case "freeze":
				dao.want = []string{"freeze"}
				// A failed stream may expose partial data; none may be used.
				dao.freeze = func(context.Context, string, []string) ([]store.WebhookAudience, error) {
					return []store.WebhookAudience{a}, cause
				}
			case "policy":
				dao.want = []string{"freeze", "policy"}
				dao.policy = func(context.Context, int64) (wm.Policy, error) { return wm.Policy{}, cause }
			case "recorded":
				dao.want = []string{"freeze", "policy", "recorded"}
				dao.recorded = func(context.Context) (time.Time, error) { return time.Time{}, cause }
			case "save":
				dao.save = func(context.Context, store.WebhookCapturedEvent, []store.WebhookCapturedDelivery) error { return cause }
			}
			if err := (&Capturer{Random: &captureEntropy{}}).CaptureBatch(t.Context(), dao, []protocol.Fact{captureFact(protocol.Created)}); !errors.Is(err, cause) {
				t.Fatalf("lost cause: %v", err)
			}
			if phase != "save" && len(dao.writes) != 0 {
				t.Fatal("failed preparation requested persistence")
			}
		})
	}
}

type captureFailedEntropy struct {
	captureEntropy
	cause         error
	uuidFailure   uint64
	jitterFailure bool
}

func (r *captureFailedEntropy) Read(p []byte) (int, error) {
	if (len(p) == 16 && r.ids+1 == r.uuidFailure) || (len(p) != 16 && r.jitterFailure) {
		return 0, r.cause
	}
	return r.captureEntropy.Read(p)
}

func TestCaptureEntropyFailureStopsBeforeSave(t *testing.T) {
	for _, tc := range []struct {
		name          string
		uuidFailure   uint64
		jitterFailure bool
	}{
		{"event ID", 1, false}, {"delivery ID", 2, false}, {"schedule jitter", 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, protocol.Created)}, 0)
			cause := errors.New("entropy unavailable")
			c := &Capturer{Random: &captureFailedEntropy{cause: cause, uuidFailure: tc.uuidFailure, jitterFailure: tc.jitterFailure}}
			if err := c.CaptureBatch(t.Context(), dao, []protocol.Fact{captureFact(protocol.Created)}); !errors.Is(err, cause) {
				t.Fatalf("entropy cause = %v", err)
			}
			if len(dao.writes) != 0 {
				t.Fatal("entropy failure requested persistence")
			}
		})
	}
}

func TestCaptureUnsupportedPolicyAndTargetStopBeforeSave(t *testing.T) {
	for _, tc := range []struct {
		name   string
		policy func(*wm.Policy)
		target func(*store.WebhookAudience)
	}{
		{"policy version", func(p *wm.Policy) { p.Version = 2 }, nil},
		{"attempt count", func(p *wm.Policy) { p.MaxAutomaticAttempts = 9 }, nil},
		{"schedule length", func(p *wm.Policy) { p.AutomaticOffsetsSeconds = p.AutomaticOffsetsSeconds[:9] }, nil},
		{"schedule offset", func(p *wm.Policy) { p.AutomaticOffsetsSeconds[1]++ }, nil},
		{"automatic window", func(p *wm.Policy) { p.AutomaticWindowSeconds-- }, nil},
		{"payload window", func(p *wm.Policy) { p.PayloadRetentionSeconds-- }, nil},
		{"jitter", func(p *wm.Policy) { p.JitterBasisPoints-- }, nil},
		{"jitter cap", func(p *wm.Policy) { p.JitterMaxSeconds-- }, nil},
		{"destination kind", nil, func(a *store.WebhookAudience) { a.Endpoint.DestinationKind = "unsupported" }},
		{"adapter", nil, func(a *store.WebhookAudience) { a.Endpoint.AdapterVersion = "2" }},
		{"configuration schema", nil, func(a *store.WebhookAudience) { a.ConfigurationSchemaVersion = 2 }},
		{"invalid target bytes", nil, func(a *store.WebhookAudience) { a.Endpoint.DestinationConfiguration = []byte("invalid") }},
		{"invalid epoch", nil, func(a *store.WebhookAudience) { a.AuthorizationEpoch = 0 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := captureAudience(t, protocol.Created)
			if tc.target != nil {
				tc.target(&a)
			}
			dao := captureSuccessfulDAO(t, []store.WebhookAudience{a}, 0)
			p := captureTestPolicy()
			if tc.policy != nil {
				tc.policy(&p)
			}
			dao.policy = func(context.Context, int64) (wm.Policy, error) { return p, nil }
			if err := (&Capturer{Random: &captureEntropy{}}).CaptureBatch(t.Context(), dao, []protocol.Fact{captureFact(protocol.Created)}); err == nil {
				t.Fatal("unsupported capture accepted")
			}
		})
	}
	t.Run("duplicate original match", func(t *testing.T) {
		a := captureAudience(t, protocol.Created)
		dao := captureSuccessfulDAO(t, []store.WebhookAudience{a, a}, 0)
		if err := (&Capturer{Random: &captureEntropy{}}).CaptureBatch(t.Context(), dao, []protocol.Fact{captureFact(protocol.Created)}); err == nil {
			t.Fatal("duplicate original identity accepted")
		}
	})
}

func TestCaptureSaveFailureDoesNotPrepareLaterFact(t *testing.T) {
	facts := []protocol.Fact{captureFact(protocol.StatusChanged), captureFact(protocol.Paused)}
	dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, facts[0].Type), captureAudience(t, facts[1].Type)}, 1)
	cause := errors.New("source transaction insert failed")
	dao.save = func(context.Context, store.WebhookCapturedEvent, []store.WebhookCapturedDelivery) error { return cause }
	entropy := &captureEntropy{}
	if err := (&Capturer{Random: entropy}).CaptureBatch(t.Context(), dao, facts); !errors.Is(err, cause) {
		t.Fatalf("save cause = %v", err)
	}
	if len(dao.writes) != 1 || dao.writes[0].event.EventType != facts[0].Type || entropy.ids != 2 {
		t.Fatal("failed first write prepared another fact")
	}
}

func TestCaptureCancellationAfterAudienceReadKeepsCause(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dao := newCaptureDAOMock(t, "freeze", "policy")
	entered := make(chan struct{})
	cleanupRelease := make(chan struct{})
	audience := captureAudience(t, protocol.Created)
	dao.freeze = func(ctx context.Context, _ string, _ []string) ([]store.WebhookAudience, error) {
		close(entered)
		select {
		case <-ctx.Done():
			return []store.WebhookAudience{audience}, nil
		case <-cleanupRelease:
			return nil, errors.New("capture freeze released by cleanup")
		}
	}
	dao.policy = func(ctx context.Context, _ int64) (wm.Policy, error) { return wm.Policy{}, ctx.Err() }
	result := make(chan error, 1)
	done := make(chan struct{})
	t.Cleanup(func() {
		cancel()
		close(cleanupRelease)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("capture goroutine did not drain")
		}
	})
	go func() {
		defer close(done)
		result <- (&Capturer{}).CaptureBatch(ctx, dao, []protocol.Fact{captureFact(protocol.Created)})
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("freeze not entered")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation cause = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("capture did not drain after cancellation")
	}
	if len(dao.writes) != 0 || !slices.Equal(dao.calls, []string{"freeze", "policy"}) {
		t.Fatal("cancelled capture requested persistence")
	}
}
