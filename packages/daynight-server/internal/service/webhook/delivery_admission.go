package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

type preparedAttempt struct {
	attempt         store.WebhookAttempt
	delivery        store.WebhookDelivery
	originRequestID *string
	target          string
	body            []byte
	headers         http.Header
}

// admit takes all authorization locks and persists an attempt in a separate
// transaction. No request may leave until its commit is explicitly confirmed.
func (r *Runner) admit(ctx context.Context, claimed store.WebhookDelivery) (*preparedAttempt, error) {
	var prepared *preparedAttempt
	completion, err := r.transaction(ctx, func(ctx context.Context, sc store.WebhookDeliveryScope) error {
		now, err := sc.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if claimed.LeaseUntil == nil {
			return fmt.Errorf("invalid webhook claim lease")
		}
		if !now.Before(*claimed.LeaseUntil) {
			return nil
		}
		sources, err := sc.AdmissionSources(ctx, claimed.ID, now)
		if err != nil {
			if errors.Is(err, model.ErrNotFound) {
				// A delayed claimant can outlive retention. Reconcile under the
				// Delivery lock before distinguishing cleanup from corruption.
				d, lockErr := sc.LockDelivery(ctx, claimed.ID)
				if errors.Is(lockErr, model.ErrNotFound) {
					now, clockErr := sc.ObservedAt(ctx)
					if clockErr != nil {
						return clockErr
					}
					if claimed.LeaseUntil != nil && !now.Before(*claimed.LeaseUntil) {
						return nil
					}
					return lockErr
				}
				if lockErr != nil {
					return lockErr
				}
				now, clockErr := sc.ObservedAt(ctx)
				if clockErr != nil {
					return clockErr
				}
				if d.PurgingAt != nil || !sameLease(d, claimed) || d.LeaseUntil == nil || !now.Before(*d.LeaseUntil) || d.CurrentAttemptID != nil {
					return nil
				}
			}
			return err
		}
		d, err := sc.LockDelivery(ctx, claimed.ID)
		if errors.Is(err, model.ErrNotFound) {
			now, clockErr := sc.ObservedAt(ctx)
			if clockErr != nil {
				return clockErr
			}
			if claimed.LeaseUntil != nil && !now.Before(*claimed.LeaseUntil) {
				return nil
			}
			return err
		}
		if err != nil {
			return err
		}
		if !sameLease(d, claimed) || d.LeaseUntil == nil || !now.Before(*d.LeaseUntil) || d.CurrentAttemptID != nil {
			return nil
		}
		attempts, err := sc.LockAttempts(ctx, d.ID)
		if err != nil {
			return err
		}
		// Locks may have blocked behind a configuration or authorization change.
		// Recheck deadlines and key overlap against time after those waits.
		now, err = sc.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if !now.Before(*d.LeaseUntil) {
			return nil
		}
		if d.PurgingAt != nil {
			return nil
		}
		if err = verifyProof(d, sources); err != nil {
			return err
		}
		if d.Body == nil || !now.Before(d.ExpiresAt) || !now.Before(d.PayloadExpiresAt) {
			return terminalDelivery(ctx, sc, &d, now, "failed", "expired")
		}
		if !sources.ProjectEligible || (d.EventType != protocol.Deleted && !sources.TaskPresent) || !sources.EndpointPresent || sources.Endpoint.DeletedAt != nil || sources.Endpoint.DestinationRevision != d.DestinationRevision || !continuous(sources.Matches) {
			return terminalDelivery(ctx, sc, &d, now, "suppressed", "eligibility_ended")
		}
		// A replaced destination has no obligation to retain its old wait row.
		// Only the matching current revision requires this leaf.
		wait, err := sc.LockWait(ctx, d.EndpointID, d.DestinationRevision)
		if err != nil {
			return err
		}
		now, err = sc.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if !now.Before(*d.LeaseUntil) {
			return nil
		}
		if wait.Owner != d.Owner {
			return fmt.Errorf("webhook wait owner mismatch")
		}
		if !now.Before(d.ExpiresAt) || !now.Before(d.PayloadExpiresAt) {
			return terminalDelivery(ctx, sc, &d, now, "failed", "expired")
		}
		if !sources.Endpoint.Enabled || (wait.NotBefore != nil && wait.NotBefore.After(now)) {
			next := now.Add(5 * time.Second)
			if wait.NotBefore != nil && wait.NotBefore.After(next) {
				next = *wait.NotBefore
			}
			if !next.Before(d.ExpiresAt) {
				return terminalDelivery(ctx, sc, &d, now, "failed", "expired")
			}
			clearLease(&d)
			d.State, d.NextAttemptAt = "pending", &next
			touchDelivery(&d, now)
			return sc.UpdateDelivery(ctx, d)
		}
		if d.Trigger == "automatic" {
			for _, a := range attempts {
				if valueIs(a.Outcome, "acknowledged") || valueIs(a.LateOutcome, "acknowledged") {
					return terminalDelivery(ctx, sc, &d, now, "delivered", "")
				}
			}
			if !d.AutomaticOpen || d.AutomaticAttemptCount >= 10 {
				return terminalDelivery(ctx, sc, &d, now, "failed", "automatic_exhausted")
			}
		}
		if d.PolicyVersion != 1 || d.DestinationKind != "http" || d.AdapterVersion != 1 || d.RenderVersion != 1 || d.ConfigurationSchemaVersion != 1 || d.RequestMethod != "POST" || d.RequestMediaType != protocol.MediaType || !bytes.Equal(d.DeterministicHeadersJSON, []byte("[]")) {
			return fmt.Errorf("unsupported webhook delivery format")
		}
		hash := sha256.Sum256(d.Body)
		if len(d.Body) != d.OriginalBodyBytes || !bytes.Equal(hash[:], d.BodySHA256) {
			return fmt.Errorf("invalid webhook body")
		}
		destination, err := decodeDeliveryDestination(d)
		if err != nil {
			return err
		}
		ids, secrets, err := r.signingKeys(sources, now)
		if err != nil {
			return err
		}
		headers, err := protocol.Authenticate(d.EventID, d.Body, secrets, now)
		if err != nil {
			return err
		}
		headers.Set("Content-Type", d.RequestMediaType)
		id, err := r.service.newID()
		if err != nil {
			return err
		}
		a := store.WebhookAttempt{ID: id, DeliveryID: d.ID, EndpointID: d.EndpointID, Trigger: d.Trigger, LeaseToken: *d.LeaseToken, Generation: d.Generation, DestinationRevision: d.DestinationRevision, Sequence: d.AttemptSequence + 1, SigningKeyIDs: ids, ClaimedAt: *d.LeaseClaimedAt, AdmittedAt: now}
		if d.Trigger == "automatic" {
			slot, ok, err := core.AutomaticSlot(d.AutomaticScheduleAt, d.AutomaticPlanCursor, now, d.AutomaticExpiresAt)
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("automatic claim without due opportunity")
			}
			a.AutomaticPlanSlot, d.LeasePlanSlot = &slot, &slot
			d.AutomaticPlanCursor, d.AutomaticAttemptCount = slot, d.AutomaticAttemptCount+1
		} else if d.Trigger == "manual" && d.ManualOperationID != nil {
			a.ManualOperationID = d.ManualOperationID
		} else {
			return fmt.Errorf("invalid webhook trigger")
		}
		if a.Sequence > 13 {
			return fmt.Errorf("webhook attempt sequence exhausted")
		}
		if err := sc.InsertAttempt(ctx, a); err != nil {
			return err
		}
		d.AttemptSequence, d.CurrentAttemptID = a.Sequence, &a.ID
		touchDelivery(&d, now)
		if err := sc.UpdateDelivery(ctx, d); err != nil {
			return err
		}
		prepared = &preparedAttempt{attempt: a, delivery: d, originRequestID: sources.Event.OriginRequestID, target: destination.URL, body: d.Body, headers: headers}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		return nil, transactionError("admission", completion, err)
	}
	return prepared, nil
}

func verifyProof(d store.WebhookDelivery, s store.WebhookAdmissionSources) error {
	e := s.Event
	if e.ID != d.EventID || e.ProjectID != d.ProjectID || e.EventType != d.EventType || !e.OccurredAt.Equal(d.OccurredAt) || d.OriginalMatchCount != int64(len(s.Matches)) || d.OriginalMatchCount <= 0 {
		return fmt.Errorf("webhook original proof mismatch")
	}
	if s.EndpointPresent && (s.Endpoint.ID != d.EndpointID || s.Endpoint.Owner != d.Owner) {
		return fmt.Errorf("webhook endpoint identity mismatch")
	}
	matches := make([]store.WebhookCapturedMatch, 0, len(s.Matches))
	for _, m := range s.Matches {
		if m.ProjectID != d.ProjectID || m.EventType != d.EventType {
			return fmt.Errorf("webhook original proof mismatch")
		}
		matches = append(matches, m.WebhookCapturedMatch)
	}
	hash, err := MatchDigest(matches)
	if err != nil || !bytes.Equal(hash, d.OriginalMatchSHA256) {
		return fmt.Errorf("webhook original proof mismatch")
	}
	return nil
}
func continuous(matches []store.WebhookAdmissionMatch) bool {
	for _, m := range matches {
		if m.Continuous {
			return true
		}
	}
	return false
}
func valueIs(value *string, expected string) bool { return value != nil && *value == expected }
func sameLease(d, original store.WebhookDelivery) bool {
	return d.State == "leased" && d.LeaseToken != nil && original.LeaseToken != nil && *d.LeaseToken == *original.LeaseToken && d.Generation == original.Generation && d.LeaseGeneration != nil && *d.LeaseGeneration == d.Generation
}
func clearLease(d *store.WebhookDelivery) {
	d.LeaseToken, d.LeaseClaimedAt, d.LeaseUntil, d.LeaseGeneration, d.LeasePlanSlot, d.CurrentAttemptID = nil, nil, nil, nil, nil, nil
}
func terminalDelivery(ctx context.Context, sc store.WebhookDeliveryScope, d *store.WebhookDelivery, now time.Time, state, reason string) error {
	clearLease(d)
	d.State, d.AutomaticOpen, d.NextAttemptAt, d.TerminalAt = state, false, nil, &now
	touchDelivery(d, now)
	if reason != "" {
		d.PreparationErrorCode = &reason
	} else {
		d.PreparationErrorCode = nil
	}
	return sc.UpdateDelivery(ctx, *d)
}

func touchDelivery(d *store.WebhookDelivery, now time.Time) {
	if now.After(d.LastActivityAt) {
		d.LastActivityAt = now
	}
	deadline := now.Add(30 * 24 * time.Hour)
	if deadline.After(d.MetadataExpiresAt) {
		d.MetadataExpiresAt = deadline
	}
}
func (r *Runner) signingKeys(s store.WebhookAdmissionSources, now time.Time) ([]string, [][]byte, error) {
	var ids []string
	var secrets [][]byte
	for _, slot := range []string{"current", "overlap"} {
		for _, key := range s.SigningKeys {
			if key.Slot != slot || key.RevokedAt != nil || (slot == "overlap" && (key.OverlapUntil == nil || !now.Before(*key.OverlapUntil))) {
				continue
			}
			if slot == "current" && key.ID != s.Endpoint.ActiveKeyID {
				return nil, nil, fmt.Errorf("invalid current webhook key")
			}
			if len(key.Secret) != 32 {
				return nil, nil, fmt.Errorf("webhook signing key unavailable")
			}
			ids, secrets = append(ids, key.ID), append(secrets, key.Secret)
		}
	}
	if len(ids) == 0 || len(ids) > 2 || ids[0] != s.Endpoint.ActiveKeyID {
		return nil, nil, fmt.Errorf("webhook signing key unavailable")
	}
	return ids, secrets, nil
}
