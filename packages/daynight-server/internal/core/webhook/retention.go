package webhook

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RetentionActive protects a currently valid lease or unfinished scheduled work.
func RetentionActive(d store.WebhookDelivery, now time.Time) bool {
	return (d.State == "leased" && d.LeaseUntil != nil && d.LeaseUntil.After(now)) ||
		(d.State == "pending" && d.ExpiresAt.After(now))
}

// LastRetentionActivity includes observations written without a Delivery lock.
func LastRetentionActivity(d store.WebhookDelivery, attempts []store.WebhookAttempt) time.Time {
	last := d.LastActivityAt
	for _, a := range attempts {
		for _, at := range []*time.Time{a.FinishedAt, a.LateObservedAt} {
			if at != nil && at.After(last) {
				last = *at
			}
		}
	}
	return last
}
