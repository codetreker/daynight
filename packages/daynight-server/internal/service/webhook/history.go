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
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

type DeliveryQuery struct {
	EventType, State, ProjectID string
	From, To                    *time.Time
	Limit                       int
	Cursor                      *string
}
type AttemptQuery struct {
	Generation *int64
	Limit      int
	Cursor     *string
}

type historyCursor struct {
	Version                                                              int
	Kind, User, OwnerKind, OwnerID, Endpoint, Delivery, Filter, View, ID string
	Time                                                                 time.Time
	Generation                                                           int64
	Sequence                                                             int16
}

type historyDisclosure struct {
	At    time.Time
	State string
}

func historyReader(sc store.WebhookReadScope) (store.WebhookHistoryReader, error) {
	h, ok := sc.WebhookDAO().(store.WebhookHistoryReader)
	if !ok || h == nil {
		return nil, fmt.Errorf("webhook history reader unavailable")
	}
	return h, nil
}
func (s *Service) readHistoryCursor(raw *string, expected historyCursor) (historyCursor, error) {
	if raw == nil {
		return expected, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(*raw)
	if err != nil {
		return expected, fault("invalid_input", "Invalid cursor.")
	}
	var c historyCursor
	if decodeCursor(b, &c) != nil || c.Version != expected.Version || c.Kind != expected.Kind || c.User != expected.User || c.OwnerKind != expected.OwnerKind || c.OwnerID != expected.OwnerID || c.Endpoint != expected.Endpoint || c.Delivery != expected.Delivery || c.Filter != expected.Filter || (expected.View != "" && c.View != expected.View) || (c.ID == "" || core.CanonicalUUID(c.ID) != nil) {
		return expected, fault("invalid_input", "Invalid cursor.")
	}
	if c.Kind == "deliveries" && (c.Time.IsZero() || c.Generation != 0 || c.Sequence != 0) || c.Kind == "attempts" && (c.Generation < 1 || c.Sequence < 1 || c.Sequence > 13 || !c.Time.IsZero()) {
		return expected, fault("invalid_input", "Invalid cursor.")
	}
	return c, nil
}
func (s *Service) encodeHistoryCursor(c historyCursor) (string, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func cursorBase(kind string, p model.Principal, o Owner, endpoint, delivery, filter, view string) historyCursor {
	return historyCursor{Version: 1, Kind: kind, User: p.UserID, OwnerKind: o.Kind, OwnerID: o.ID, Endpoint: endpoint, Delivery: delivery, Filter: filter, View: view}
}
func retention(ctx context.Context, sc store.WebhookReadScope) (any, error) {
	p, e := sc.WebhookDAO().Policy(ctx, 1)
	if e != nil {
		return nil, e
	}
	return map[string]any{"payloadRetentionSeconds": p.PayloadRetentionSeconds, "metadataRetentionSeconds": p.MetadataRetentionSeconds}, nil
}
func historyEndpoint(ctx context.Context, sc store.WebhookReadScope, p model.Principal, o Owner, id string) (bool, error) {
	manage, err := authorize(ctx, sc, p, o)
	if err != nil {
		return false, err
	}
	_, err = sc.WebhookDAO().Endpoint(ctx, o, id)
	if errors.Is(err, model.ErrNotFound) {
		h, readErr := historyReader(sc)
		if readErr != nil {
			return false, readErr
		}
		retained, readErr := h.HistoryDeliveries(ctx, o, id, time.Time{}, "", 1)
		if readErr != nil {
			return false, readErr
		}
		if len(retained) == 0 {
			return false, fault("not_found", "Webhook resource was not found.")
		}
		return manage, nil
	}
	if err != nil {
		return false, err
	}
	return manage, nil
}
func historySources(ctx context.Context, sc store.WebhookReadScope, h store.WebhookHistoryReader, p model.Principal, d store.WebhookDelivery) (store.WebhookHistorySources, bool, bool, error) {
	src, err := h.HistorySources(ctx, d, p.UserID)
	if errors.Is(err, store.ErrWebhookHistoryEventMissing) {
		return src, false, false, fault("internal_error", "Webhook original event missing.")
	}
	if err != nil {
		return src, false, false, err
	}
	proof := store.WebhookAdmissionSources{Event: src.Event, Matches: src.Matches}
	if err = verifyProof(d, proof); err != nil {
		return src, false, false, fault("internal_error", "Webhook original proof integrity failure.")
	}
	now, err := sc.ObservedAt(ctx)
	if err != nil {
		return src, false, false, err
	}
	if now.Before(d.PayloadExpiresAt) {
		sum := sha256.Sum256(src.Event.FactBytes)
		if src.FactRemovedAt != nil || src.Event.FactBytes == nil || len(src.Event.FactBytes) != src.OriginalFactBytes || len(src.Event.FactBytes) > 65536 || !bytes.Equal(sum[:], src.Event.FactSHA256) {
			return src, false, false, fault("internal_error", "Webhook event fact integrity failure.")
		}
	}
	e, err := sc.EligibilityDAO().ReadEligibility(ctx, d.Owner, d.ProjectID, p.UserID)
	if err != nil {
		return src, false, false, err
	}
	full := src.ProjectReadable && (d.EventType == protocol.Deleted || src.TaskPresent)
	ep, err := sc.WebhookDAO().Endpoint(ctx, d.Owner, d.EndpointID)
	endpointPresent := err == nil
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return src, false, false, err
	}
	eligible := e.Status == "eligible" && (d.EventType == protocol.Deleted || src.TaskPresent) && continuous(src.Matches) && endpointPresent && ep.DeletedAt == nil && ep.DestinationRevision == d.DestinationRevision
	return src, full, eligible, nil
}

// AttemptResult projects the latest actual observation without discarding recovery history.
func AttemptResult(a store.WebhookAttempt) any {
	if a.Outcome == nil {
		return nil
	}
	category, code, status, duration := a.Outcome, a.ErrorCode, a.HTTPStatus, a.DurationMS
	if a.LateOutcome != nil {
		category, code, status, duration = a.LateOutcome, a.LateErrorCode, a.LateHTTPStatus, a.LateDurationMS
	}
	return map[string]any{"category": category, "code": code, "httpStatus": status, "durationMs": duration}
}
func attemptView(a store.WebhookAttempt) any {
	var errValue any
	if a.ErrorCode != nil {
		errValue = map[string]any{"category": a.Outcome, "code": a.ErrorCode, "message": "Webhook delivery failed."}
	}
	var late any
	if a.LateOutcome != nil {
		late = map[string]any{"observedAt": utcTime(a.LateObservedAt), "outcome": a.LateOutcome, "httpStatus": a.LateHTTPStatus, "durationMs": a.LateDurationMS, "error": a.LateErrorCode}
	}
	return map[string]any{"id": a.ID, "endpointId": a.EndpointID, "deliveryId": a.DeliveryID, "generation": version(a.Generation), "number": a.Sequence, "claimedAt": a.ClaimedAt.UTC(), "admittedAt": a.AdmittedAt.UTC(), "dispatchedAt": utcTime(a.DispatchedAt), "finishedAt": utcTime(a.FinishedAt), "outcome": a.Outcome, "httpStatus": a.HTTPStatus, "durationMs": a.DurationMS, "error": errValue, "recoveredUnknownAt": utcTime(a.RecoveredUnknownAt), "lateResult": late}
}
func (s *Service) makeDeliveryView(ctx context.Context, sc store.WebhookReadScope, h store.WebhookHistoryReader, p model.Principal, d store.WebhookDelivery, manage bool) (map[string]any, bool, error) {
	src, full, eligible, err := historySources(ctx, sc, h, p, d)
	if err != nil {
		return nil, false, err
	}
	now, err := sc.ObservedAt(ctx)
	if err != nil {
		return nil, false, err
	}
	if now.Before(d.PayloadExpiresAt) {
		sum := sha256.Sum256(d.Body)
		if d.PayloadRemovedAt != nil || d.Body == nil || len(d.Body) > 65536 || len(d.Body) != d.OriginalBodyBytes || !bytes.Equal(sum[:], d.BodySHA256) {
			return nil, false, fault("internal_error", "Webhook payload integrity failure.")
		}
	}
	attempts, err := h.HistoryAttempts(ctx, d.ID)
	if err != nil {
		return nil, false, err
	}
	var last, ack *time.Time
	var result any
	for _, a := range attempts {
		t := a.AdmittedAt.UTC()
		last = &t
		result = AttemptResult(a)
		if a.Outcome != nil && *a.Outcome == "acknowledged" && a.FinishedAt != nil && (ack == nil || a.FinishedAt.After(*ack)) {
			ack = utcTime(a.FinishedAt)
		}
		if a.LateOutcome != nil && *a.LateOutcome == "acknowledged" && a.LateObservedAt != nil && (ack == nil || a.LateObservedAt.After(*ack)) {
			ack = utcTime(a.LateObservedAt)
		}
	}
	state := d.State
	if (state == "pending" || state == "leased") && !eligible {
		state = "suppressed"
	}
	resource := map[string]any{"projectId": nil, "taskId": nil, "stepId": nil, "messageId": nil, "displayName": nil}
	var eventType, resourceVersion, url, display any
	disclosure := "metadata_only"
	if full {
		disclosure = "full"
		eventType = d.EventType
		resource["projectId"] = src.Event.ProjectID
		resource["taskId"] = src.Event.TaskID
		resource["messageId"] = src.Event.MessageID
		resource["displayName"] = src.TaskTitle
		if src.Event.StepID != nil {
			resource["stepId"] = fmt.Sprintf("%08x", *src.Event.StepID)
		}
		if src.Event.TaskVersion != nil {
			resourceVersion = version(*src.Event.TaskVersion)
		}
		display = d.DestinationOrigin + "/…"
		if manage {
			destination, e2 := decodeDeliveryDestination(d)
			if e2 != nil {
				return nil, false, e2
			}
			url = destination.URL
			display = destination.URL
		}
	}
	available := full && now.Before(d.PayloadExpiresAt) && d.PayloadRemovedAt == nil
	v := map[string]any{"id": d.ID, "endpointId": d.EndpointID, "eventId": d.EventID, "owner": map[string]any{"kind": d.Owner.Kind, "id": d.Owner.ID}, "eventType": eventType, "resource": resource, "occurredAt": d.OccurredAt.UTC(), "resourceVersion": resourceVersion, "target": map[string]any{"destinationRevision": version(d.DestinationRevision), "url": url, "displayUrl": display}, "generation": version(d.Generation), "state": state, "attemptCount": d.AttemptSequence, "automaticAttemptCount": d.AutomaticAttemptCount, "manualOperationCount": d.ManualOperationCount, "nextAttemptAt": utcTime(d.NextAttemptAt), "lastAttemptAt": last, "expiresAt": d.ExpiresAt.UTC(), "automaticExpiresAt": d.AutomaticExpiresAt.UTC(), "payloadExpiresAt": d.PayloadExpiresAt.UTC(), "lastAcknowledgedAt": ack, "lastResult": result, "payloadAvailable": available, "disclosure": disclosure}
	return v, full, nil
}

func (s *Service) deliveryViewInSnapshot(ctx context.Context, sc store.WebhookReadScope, p model.Principal, o Owner, endpoint, id string) (any, error) {
	manage, err := historyEndpoint(ctx, sc, p, o, endpoint)
	if err != nil {
		return nil, err
	}
	h, err := historyReader(sc)
	if err != nil {
		return nil, err
	}
	d, err := h.HistoryDelivery(ctx, o, endpoint, id)
	if err != nil {
		return nil, notFound(err)
	}
	v, _, err := s.makeDeliveryView(ctx, sc, h, p, d, manage)
	return v, err
}
func (s *Service) GetDelivery(ctx context.Context, p model.Principal, o Owner, endpoint, id string) (any, error) {
	var result any
	err := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		var e error
		result, e = s.deliveryViewInSnapshot(ctx, sc, p, o, endpoint, id)
		return e
	})
	return result, err
}
func (s *Service) Payload(ctx context.Context, p model.Principal, o Owner, endpoint, id string) (any, error) {
	var result any
	err := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		if _, e := historyEndpoint(ctx, sc, p, o, endpoint); e != nil {
			return e
		}
		h, e := historyReader(sc)
		if e != nil {
			return e
		}
		d, e := h.HistoryDelivery(ctx, o, endpoint, id)
		if e != nil {
			return notFound(e)
		}
		_, full, _, e := historySources(ctx, sc, h, p, d)
		if e != nil {
			return e
		}
		if !full {
			return fault("forbidden", "Access to this payload is denied.")
		}
		now, e := sc.ObservedAt(ctx)
		if e != nil {
			return e
		}
		if !now.Before(d.PayloadExpiresAt) {
			return fault("payload_expired", "Webhook payload has expired.")
		}
		sum := sha256.Sum256(d.Body)
		if d.PayloadRemovedAt != nil || d.Body == nil || len(d.Body) > 65536 || len(d.Body) != d.OriginalBodyBytes || !bytes.Equal(sum[:], d.BodySHA256) {
			return fault("internal_error", "Webhook payload integrity failure.")
		}
		result = map[string]any{"owner": map[string]any{"kind": o.Kind, "id": o.ID}, "endpointId": endpoint, "deliveryId": id, "eventId": d.EventID, "mediaType": d.RequestMediaType, "encoding": "base64", "body": base64.StdEncoding.EncodeToString(d.Body), "bytes": len(d.Body), "sha256": hex.EncodeToString(sum[:])}
		return nil
	})
	return result, err
}
func (s *Service) ListDeliveries(ctx context.Context, p model.Principal, o Owner, endpoint string, q DeliveryQuery) (any, error) {
	var result any
	err := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		manage, e := historyEndpoint(ctx, sc, p, o, endpoint)
		if e != nil {
			return e
		}
		h, e := historyReader(sc)
		if e != nil {
			return e
		}
		f, _ := json.Marshal(struct {
			EventType, State, ProjectID string
			From, To                    *time.Time
		}{q.EventType, q.State, q.ProjectID, q.From, q.To})
		c, e := s.readHistoryCursor(q.Cursor, cursorBase("deliveries", p, o, endpoint, "", string(f), ""))
		if e != nil {
			return e
		}
		var issued historyDisclosure
		if q.Cursor != nil {
			if decodeCursor([]byte(c.View), &issued) != nil || issued.At.IsZero() || issued.State == "" {
				return fault("invalid_input", "Invalid cursor.")
			}
		} else {
			issued.At, e = sc.ObservedAt(ctx)
			if e != nil {
				return e
			}
		}
		disclosure, e := h.HistoryDisclosure(ctx, o, endpoint, p.UserID, issued.At)
		if e != nil {
			return e
		}
		currentDisclosure := strconv.FormatBool(manage) + ":" + disclosure
		if q.Cursor != nil && issued.State != currentDisclosure {
			return fault("invalid_input", "Invalid cursor.")
		}
		issued.State = currentDisclosure
		limit := q.Limit
		if limit == 0 {
			limit = 50
		}
		if limit < 1 || limit > 100 {
			return fault("invalid_input", "Invalid limit.")
		}
		items := make([]any, 0, limit)
		var last historyCursor
		more := false
		at, id := c.Time, c.ID
		for !more {
			rows, e := h.HistoryDeliveries(ctx, o, endpoint, at, id, 100)
			if e != nil {
				return e
			}
			if len(rows) == 0 {
				break
			}
			for _, d := range rows {
				at, id = d.OccurredAt, d.ID
				v, full, e := s.makeDeliveryView(ctx, sc, h, p, d, manage)
				if e != nil {
					return e
				}
				if (q.EventType != "" && (!full || d.EventType != q.EventType)) || (q.ProjectID != "" && (!full || d.ProjectID != q.ProjectID)) || (q.State != "" && v["state"] != q.State) || (q.From != nil && d.OccurredAt.Before(*q.From)) || (q.To != nil && !d.OccurredAt.Before(*q.To)) {
					continue
				}
				if len(items) == limit {
					more = true
					break
				}
				items = append(items, v)
				last = c
				last.Time = d.OccurredAt
				last.ID = d.ID
			}
			if len(rows) < 100 {
				break
			}
		}
		var next any
		if more {
			// Each new page establishes its own baseline without freezing the
			// Delivery collection or exposing the underlying resource identities.
			issued.At, e = sc.ObservedAt(ctx)
			if e != nil {
				return e
			}
			disclosure, e = h.HistoryDisclosure(ctx, o, endpoint, p.UserID, issued.At)
			if e != nil {
				return e
			}
			issued.State = strconv.FormatBool(manage) + ":" + disclosure
			state, marshalErr := json.Marshal(issued)
			if marshalErr != nil {
				return marshalErr
			}
			last.View = string(state)
			encoded, encodeErr := s.encodeHistoryCursor(last)
			if encodeErr != nil {
				return encodeErr
			}
			next = encoded
		}
		policy, e := retention(ctx, sc)
		if e != nil {
			return e
		}
		result = map[string]any{"items": items, "nextCursor": next, "historyMayBeIncomplete": true, "retention": policy}
		return nil
	})
	return result, err
}
func (s *Service) ListAttempts(ctx context.Context, p model.Principal, o Owner, endpoint, id string, q AttemptQuery) (any, error) {
	var result any
	err := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		if _, e := historyEndpoint(ctx, sc, p, o, endpoint); e != nil {
			return e
		}
		h, e := historyReader(sc)
		if e != nil {
			return e
		}
		d, e := h.HistoryDelivery(ctx, o, endpoint, id)
		if e != nil {
			return notFound(e)
		}
		_, full, _, e := historySources(ctx, sc, h, p, d)
		if e != nil {
			return e
		}
		filter := ""
		if q.Generation != nil {
			filter = version(*q.Generation)
		}
		c, e := s.readHistoryCursor(q.Cursor, cursorBase("attempts", p, o, endpoint, id, filter, strconv.FormatBool(full)))
		if e != nil {
			return e
		}
		limit := q.Limit
		if limit == 0 {
			limit = 50
		}
		if limit < 1 || limit > 100 {
			return fault("invalid_input", "Invalid limit.")
		}
		attempts, e := h.HistoryAttempts(ctx, id)
		if e != nil {
			return e
		}
		items := make([]any, 0, limit)
		var last historyCursor
		more := false
		for _, a := range attempts {
			if q.Generation != nil && a.Generation != *q.Generation {
				continue
			}
			if c.ID != "" && (a.Generation < c.Generation || a.Generation == c.Generation && (a.Sequence < c.Sequence || a.Sequence == c.Sequence && a.ID <= c.ID)) {
				continue
			}
			if len(items) == limit {
				more = true
				break
			}
			items = append(items, attemptView(a))
			last = c
			last.Generation = a.Generation
			last.Sequence = a.Sequence
			last.ID = a.ID
		}
		var next any
		if more {
			encoded, encodeErr := s.encodeHistoryCursor(last)
			if encodeErr != nil {
				return encodeErr
			}
			next = encoded
		}
		policy, e := retention(ctx, sc)
		if e != nil {
			return e
		}
		result = map[string]any{"items": items, "nextCursor": next, "historyMayBeIncomplete": true, "retention": policy}
		return nil
	})
	return result, err
}
