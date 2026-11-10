package store

import (
	"testing"
	"time"
)

func TestWebhookHistoryRetentionUsesStrictActivityDeadlines(t *testing.T) {
	now := time.Date(2026, 11, 8, 6, 0, 0, 0, time.UTC)
	future := now.Add(time.Microsecond)
	old := now.Add(-30 * 24 * time.Hour)
	fresh := old.Add(time.Microsecond)
	for _, c := range []struct {
		name     string
		delivery WebhookDelivery
		attempts []WebhookAttempt
		retained bool
	}{
		{"metadata future", WebhookDelivery{MetadataExpiresAt: future}, nil, true},
		{"metadata exact deadline", WebhookDelivery{MetadataExpiresAt: now}, nil, false},
		{"pending future", WebhookDelivery{State: "pending", ExpiresAt: future}, nil, true},
		{"pending exact deadline", WebhookDelivery{State: "pending", ExpiresAt: now}, nil, false},
		{"live lease", WebhookDelivery{State: "leased", LeaseUntil: &future}, nil, true},
		{"lease exact deadline", WebhookDelivery{State: "leased", LeaseUntil: &now}, nil, false},
		{"lease deadline absent", WebhookDelivery{State: "leased"}, nil, false},
		{"recent finished attempt", WebhookDelivery{}, []WebhookAttempt{{FinishedAt: &fresh}}, true},
		{"finished exact deadline", WebhookDelivery{}, []WebhookAttempt{{FinishedAt: &old}}, false},
		{"recent late observation", WebhookDelivery{}, []WebhookAttempt{{LateObservedAt: &fresh}}, true},
		{"late exact deadline", WebhookDelivery{}, []WebhookAttempt{{LateObservedAt: &old}}, false},
		{"later attempt retains", WebhookDelivery{}, []WebhookAttempt{{FinishedAt: &old}, {LateObservedAt: &fresh}}, true},
		{"empty activity", WebhookDelivery{}, []WebhookAttempt{{}}, false},
		{"closed metadata never reopens", WebhookDelivery{PurgingAt: &now, MetadataExpiresAt: future}, nil, false},
		{"closed late history never reopens", WebhookDelivery{PurgingAt: &now}, []WebhookAttempt{{LateObservedAt: &future}}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := WebhookHistoryRetained(c.delivery, c.attempts, now); got != c.retained {
				t.Fatalf("retained=%v want=%v", got, c.retained)
			}
		})
	}
}
