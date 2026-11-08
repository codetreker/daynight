package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

// Redelivery is one immutable, caller-observed manual operation.
type Redelivery struct {
	OperationID, IssuedAt, ExpectedUserID, RequestSHA256 string
	IfVersion, IfGeneration                              int64
}

func redeliveryFingerprint(p model.Principal, o Owner, endpoint, delivery string, m Redelivery) (string, error) {
	data, err := json.Marshal(struct {
		Operation, Actor, OwnerKind, OwnerID, Kind, Endpoint, Delivery, IssuedAt string
		Version, Generation                                                      int64
	}{m.OperationID, p.UserID, o.Kind, o.ID, "delivery.redeliver", endpoint, delivery, m.IssuedAt, m.IfVersion, m.IfGeneration})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// Redeliver records an intent, not an HTTP send. Dispatch requires a separate
// committed admission by the runner.
func (s *Service) Redeliver(ctx context.Context, p model.Principal, o Owner, endpointID, deliveryID string, m Redelivery) (Result, error) {
	if core.CanonicalUUID(m.OperationID) != nil || core.CanonicalUUID(m.ExpectedUserID) != nil || core.CanonicalUUID(endpointID) != nil || core.CanonicalUUID(deliveryID) != nil || m.IfVersion <= 0 || m.IfGeneration <= 0 {
		return Result{}, fault("invalid_input", "Invalid operation identity or version.")
	}
	if _, err := core.ParseIssuedAt(m.IssuedAt); err != nil {
		return Result{}, fault("invalid_input", "Invalid operation time.")
	}
	if p.UserID != m.ExpectedUserID {
		return Result{}, fault("identity_mismatch", "Expected user differs from current identity.")
	}
	if err := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error { _, e := authorize(ctx, sc, p, o); return e }); err != nil {
		return Result{}, err
	}
	fp, err := redeliveryFingerprint(p, o, endpointID, deliveryID, m)
	if err != nil {
		return Result{}, err
	}
	var op wm.Operation
	var replay, conflict bool
	completion, err := s.DB.WriteWebhook(ctx, o, m.OperationID, func(sc store.WebhookWriteScope) error {
		w := sc.WebhookWriter()
		existing, e := w.Operation(ctx, o, m.OperationID)
		if e == nil {
			op, replay, conflict = existing, true, existing.Fingerprint != fp
			return nil
		}
		if !errors.Is(e, model.ErrNotFound) {
			return e
		}
		manage, e := authorize(ctx, sc, p, o)
		if e != nil {
			return e
		}
		if !manage {
			return fault("forbidden", "Webhook management permission is required.")
		}
		if !s.DispatchEnabled {
			return fault("webhooks_unavailable", "Webhook dispatch is unavailable.")
		}
		policy, e := w.Policy(ctx, 1)
		if e != nil {
			return e
		}
		now, e := sc.ObservedAt(ctx)
		if e != nil {
			return e
		}
		if e = checkTime(m.IssuedAt, now, policy); e != nil {
			return e
		}
		dao := sc.RedeliveryWriter()
		sources, e := dao.AdmissionSourcesForActor(ctx, deliveryID, endpointID, o, p.UserID, now)
		if e != nil {
			var missing *store.WebhookAdmissionEventError
			if errors.As(e, &missing) {
				return e
			}
			return notFound(e)
		}
		d, e := dao.LockDelivery(ctx, deliveryID)
		if e != nil {
			return notFound(e)
		}
		if d.Owner != o || d.EndpointID != endpointID {
			return fault("not_found", "Webhook resource was not found.")
		}
		attempts, e := dao.LockAttempts(ctx, d.ID)
		if e != nil {
			return e
		}
		credential, e := sc.LockCredential(ctx, p)
		if e != nil {
			if errors.Is(e, model.ErrNotFound) {
				return model.Unauthenticated(e)
			}
			return e
		}
		now, e = sc.ObservedAt(ctx)
		if e != nil {
			return e
		}
		if credential.ExpiresAt != nil && !credential.ExpiresAt.After(now) {
			return model.Unauthenticated(model.ErrNotFound)
		}
		if e = checkTime(m.IssuedAt, now, policy); e != nil {
			return e
		}
		manage, e = authorize(ctx, sc, p, o)
		if e != nil {
			return e
		}
		if !manage {
			return fault("forbidden", "Webhook management permission is required.")
		}
		if !store.WebhookHistoryRetained(d, attempts, now) {
			return fault("not_found", "Webhook resource was not found.")
		}
		if !now.Before(d.PayloadExpiresAt) {
			return fault("payload_expired", "Webhook payload has expired.")
		}
		if err := verifyProof(d, sources); err != nil {
			return fault("internal_error", "Webhook original proof integrity failure.")
		}
		// Reuse the retained-history validation under the same Delivery lock so
		// damaged original facts cannot produce a committed manual intent.
		history, e := historyReader(sc)
		if e != nil {
			return e
		}
		if _, _, _, e = historySources(ctx, sc, history, p, d); e != nil {
			return e
		}
		if !sources.EndpointPresent || sources.Endpoint.DeletedAt != nil {
			return fault("delivery_stopped", "Webhook delivery is no longer eligible.")
		}
		if sources.Endpoint.ConfigVersion != m.IfVersion {
			return fault("version_conflict", "Webhook configuration version changed.")
		}
		if d.Generation != m.IfGeneration {
			return fault("generation_conflict", "Webhook delivery generation changed.")
		}
		if (d.State == "leased" && (d.LeaseUntil == nil || now.Before(*d.LeaseUntil))) || (d.State == "pending" && d.Trigger == "manual") || (d.State == "leased" && d.Trigger == "manual" && d.CurrentAttemptID == nil) {
			return fault("delivery_busy", "Webhook delivery is already active.")
		}
		if sources.Endpoint.DestinationRevision != d.DestinationRevision {
			return fault("target_changed", "Webhook destination changed.")
		}
		if !sources.Endpoint.Enabled || !sources.ProjectEligible || (d.EventType != protocol.Deleted && !sources.TaskPresent) || !continuous(sources.Matches) || d.ManualOperationCount >= policy.MaxManualOperations {
			return fault("delivery_stopped", "Webhook delivery is no longer eligible.")
		}
		eligible, e := sc.EligibilityDAO().ReadEligibility(ctx, o, d.ProjectID, p.UserID)
		if e != nil {
			return e
		}
		if eligible.Status != "eligible" || eligible.ProjectName == nil {
			return fault("forbidden", "Access to this resource is denied.")
		}
		if d.PayloadRemovedAt != nil || d.PayloadRemovedReason != nil || d.Body == nil || len(d.Body) > 65536 || len(d.Body) != d.OriginalBodyBytes {
			return fault("internal_error", "Webhook payload integrity failure.")
		}
		sum := sha256.Sum256(d.Body)
		if !bytes.Equal(sum[:], d.BodySHA256) {
			return fault("internal_error", "Webhook payload integrity failure.")
		}
		if d.Generation == math.MaxInt64 {
			return fault("version_exhausted", "Delivery generation exhausted.")
		}
		ticket, e := dao.NextQueueOrder(ctx)
		if e != nil {
			return e
		}
		// Reads after the first lock-time check can themselves wait. The
		// operation and payload deadlines must still hold immediately before
		// updating the retained attempt, Delivery and receipt.
		now, e = sc.ObservedAt(ctx)
		if e != nil {
			return e
		}
		if credential.ExpiresAt != nil && !credential.ExpiresAt.After(now) {
			return model.Unauthenticated(model.ErrNotFound)
		}
		if e = checkTime(m.IssuedAt, now, policy); e != nil {
			return e
		}
		if !store.WebhookHistoryRetained(d, attempts, now) {
			return fault("not_found", "Webhook resource was not found.")
		}
		if !now.Before(d.PayloadExpiresAt) {
			return fault("payload_expired", "Webhook payload has expired.")
		}
		// An expired admitted lease remains an unknown historical attempt. Fence
		// it before replacing the intent; a mere manual claim must instead be
		// recovered by the runner so its one unused admission is not discarded.
		if d.State == "leased" && d.CurrentAttemptID != nil {
			var current *store.WebhookAttempt
			for i := range attempts {
				if attempts[i].ID == *d.CurrentAttemptID {
					current = &attempts[i]
					break
				}
			}
			if current == nil || current.RetentionClosedAt != nil || current.Generation != d.Generation || d.LeaseToken == nil || current.LeaseToken != *d.LeaseToken {
				return fmt.Errorf("webhook admitted attempt missing or invalid")
			}
			if current.FinishedAt == nil {
				unknown := "unknown"
				current.FinishedAt, current.Outcome, current.RecoveredUnknownAt = &now, &unknown, &now
				if e = dao.UpdateAttempt(ctx, *current); e != nil {
					return e
				}
			}
		}
		d.Generation++
		d.ManualOperationCount++
		d.State, d.Trigger, d.ManualOperationID = "pending", "manual", &m.OperationID
		d.NextAttemptAt, d.ExpiresAt, d.QueueOrder = &now, d.PayloadExpiresAt, ticket
		d.TerminalAt, d.PreparationErrorCode = nil, nil
		clearLease(&d)
		touchDelivery(&d, now)
		if e = dao.UpdateDelivery(ctx, d); e != nil {
			return e
		}
		generation := d.Generation
		op = wm.Operation{Owner: o, ID: m.OperationID, ActorID: p.UserID, Kind: "delivery.redeliver", TargetID: endpointID, DeliveryID: deliveryID, GenerationAfter: &generation, IssuedAt: m.IssuedAt, RequestSHA256: m.RequestSHA256, Fingerprint: fp, Effect: "applied", ConfigVersion: sources.Endpoint.ConfigVersion, DestinationRevisionAfter: sources.Endpoint.DestinationRevision, RecordedAt: now, ExpiresAt: now.Add(time.Duration(policy.OperationRetentionSeconds) * time.Second)}
		return w.PutOperation(ctx, op)
	})
	if err != nil {
		if completion.Outcome == store.TransactionUnknown {
			return Result{}, &model.Fault{Code: "write_outcome_unknown", Message: "The write outcome is unknown. Check the original operation.", Cause: err}
		}
		var missing *store.WebhookAdmissionEventError
		var txFailure *store.TransactionError
		databaseFailure, _ := store.DatabaseErrorFacts(err)
		if errors.As(err, &missing) && !databaseFailure && (!errors.As(err, &txFailure) || !txFailure.CleanupFailed) {
			// Release the Delivery lock first; reacquiring owner roots here would
			// invert the source-before-Delivery lock order. A fresh snapshot
			// authorizes the error without retaining an earlier role observation.
			authErr := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
				manage, e := authorize(ctx, sc, p, o)
				if e != nil {
					return e
				}
				if !manage {
					return fault("forbidden", "Webhook management permission is required.")
				}
				return nil
			})
			if authErr != nil {
				return Result{}, authErr
			}
			return Result{}, notFound(err)
		}
		return Result{}, err
	}
	if completion.Outcome != store.TransactionCommitted {
		return Result{}, fault("write_outcome_unknown", "The write outcome is unknown. Check the original operation.")
	}
	var body any
	err = s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		manage, e := authorize(ctx, sc, p, o)
		if e != nil {
			return e
		}
		cur, e := sc.WebhookDAO().Operation(ctx, o, op.ID)
		if e != nil {
			return notFound(e)
		}
		if !manage && cur.ActorID != p.UserID {
			return fault("forbidden", "Access to this operation is denied.")
		}
		if conflict {
			return fault("operation_conflict", "Operation ID was already used for a different intent.")
		}
		view, e := s.deliveryViewInSnapshot(ctx, sc, p, o, endpointID, deliveryID)
		if e != nil {
			return e
		}
		body = map[string]any{"operation": opView(cur), "delivery": view}
		return nil
	})
	if err != nil && !replay {
		return Result{}, &model.Fault{Code: "write_outcome_unknown", Message: "The write committed but its response could not be verified. Check the original operation.", Cause: err}
	}
	return Result{Body: body, Replay: replay}, err
}
