package webhook

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"sort"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
)

// Capturer prepares and persists notification responsibilities in the source transaction.
type Capturer struct {
	Random    io.Reader
	Logger    *slog.Logger
	RequestID func(context.Context) string
}

// MatchDigest hashes a sorted JSON array of immutable tuple arrays. This format is
// shared with readers of the original match proof.
func MatchDigest(matches []store.WebhookCapturedMatch) ([]byte, error) {
	sorted := append([]store.WebhookCapturedMatch(nil), matches...)
	sort.Slice(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.SubscriptionID != b.SubscriptionID {
			return a.SubscriptionID < b.SubscriptionID
		}
		return a.BindingID < b.BindingID
	})
	tuples := make([][5]string, 0, len(sorted))
	for i, m := range sorted {
		if m.AuthorizationEpoch <= 0 || (i > 0 && sorted[i-1].SubscriptionID == m.SubscriptionID && sorted[i-1].BindingID == m.BindingID) {
			return nil, fmt.Errorf("invalid original webhook match")
		}
		tuples = append(tuples, [5]string{m.SubscriptionID, m.BindingID, m.ProjectID, m.EventType, strconv.FormatInt(m.AuthorizationEpoch, 10)})
	}
	b, err := json.Marshal(tuples)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(b)
	return sum[:], nil
}

func (c *Capturer) random() io.Reader {
	if c.Random != nil {
		return c.Random
	}
	return rand.Reader
}
func (c *Capturer) id() (string, error) {
	id, err := uuid.NewRandomFromReader(c.random())
	if err != nil {
		return "", fmt.Errorf("generate webhook ID: %w", err)
	}
	return id.String(), nil
}

func (c *Capturer) schedule(at time.Time, p wm.Policy) ([]time.Time, error) {
	offsets := p.AutomaticOffsetsSeconds
	if p.Version != 1 || p.MaxAutomaticAttempts != 10 || len(offsets) != 10 || p.AutomaticWindowSeconds != 259200 || p.PayloadRetentionSeconds != 604800 || p.JitterBasisPoints != 1000 || p.JitterMaxSeconds != 1800 {
		return nil, fmt.Errorf("unsupported webhook policy")
	}
	expected := []int32{0, 60, 300, 1800, 7200, 21600, 43200, 86400, 172800, 255600}
	for i := range expected {
		if offsets[i] != expected[i] {
			return nil, fmt.Errorf("invalid webhook policy offsets")
		}
	}
	result := []time.Time{at}
	deadline := at.Add(time.Duration(p.AutomaticWindowSeconds) * time.Second)
	for i := 1; i < len(offsets); i++ {
		interval := time.Duration(offsets[i]-offsets[i-1]) * time.Second
		jitter := interval * time.Duration(p.JitterBasisPoints) / 10000
		if max := time.Duration(p.JitterMaxSeconds) * time.Second; jitter > max {
			jitter = max
		}
		// Leave enough time for every remaining minimum interval before the deadline.
		remaining := time.Duration(0)
		for j := i + 1; j < len(offsets); j++ {
			d := time.Duration(offsets[j]-offsets[j-1]) * time.Second
			x := d * time.Duration(p.JitterBasisPoints) / 10000
			if x > time.Duration(p.JitterMaxSeconds)*time.Second {
				x = time.Duration(p.JitterMaxSeconds) * time.Second
			}
			remaining += d - x
		}
		low, high := interval-jitter, interval+jitter
		if cap := deadline.Add(-remaining - time.Microsecond).Sub(result[i-1]); high > cap {
			high = cap
		}
		if high < low {
			return nil, fmt.Errorf("invalid webhook schedule window")
		}
		span := int64((high-low)/time.Microsecond) + 1
		n, err := rand.Int(c.random(), big.NewInt(span))
		if err != nil {
			return nil, fmt.Errorf("generate webhook jitter: %w", err)
		}
		result = append(result, result[i-1].Add(low+time.Duration(n.Int64())*time.Microsecond))
	}
	return result, nil
}

// CaptureBatch freezes the audience once for one source operation and never
// opens a separate transaction. Errors abort the caller's source write.
func (c *Capturer) CaptureBatch(ctx context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) (failure error) {
	phase, eventID := "source", ""
	var project, request, deliveryID, endpointID, ownerKind, ownerID string
	var adapterVersion int64
	defer func() {
		if failure != nil && c.Logger != nil {
			c.Logger.ErrorContext(ctx, "webhook capture failed", "component", "webhook", "phase", phase, "event_id", eventID, "delivery_id", deliveryID, "endpoint_id", endpointID, "owner_kind", ownerKind, "owner_id", ownerID, "project_id", project, "origin_request_id", request, "adapter_version", adapterVersion, "schema_version", 1, "error_kind", "capture_failed")
		}
	}()
	if len(facts) < 1 || len(facts) > 2 || dao == nil {
		return fmt.Errorf("invalid webhook capture batch")
	}
	types := make([]string, 0, len(facts))
	project = facts[0].ProjectID
	if c.RequestID != nil {
		request = c.RequestID(ctx)
		if len(request) > 128 {
			return fmt.Errorf("invalid webhook request ID")
		}
	}
	for _, f := range facts {
		if f.ProjectID != project {
			return fmt.Errorf("webhook batch has multiple projects")
		}
		if _, err := protocol.Render("00000000-0000-4000-8000-000000000000", f); err != nil {
			return fmt.Errorf("validate webhook fact: %w", err)
		}
		for _, t := range types {
			if t == f.Type {
				return fmt.Errorf("duplicate webhook fact type")
			}
		}
		types = append(types, f.Type)
	}
	phase = "freeze"
	audience, err := dao.FreezeAudience(ctx, project, types)
	if err != nil {
		return fmt.Errorf("freeze webhook audience: %w", err)
	}
	if len(audience) == 0 {
		return nil
	}
	policy, err := dao.Policy(ctx, 1)
	if err != nil {
		return fmt.Errorf("read webhook policy: %w", err)
	}
	recorded, err := dao.RecordedAt(ctx)
	if err != nil {
		return fmt.Errorf("read webhook capture time: %w", err)
	}
	var requestID *string
	if request != "" {
		requestID = &request
	}
	for _, f := range facts {
		phase, eventID, deliveryID, endpointID, ownerKind, ownerID, adapterVersion = "capture", "", "", "", "", "", 0
		var selected []store.WebhookAudience
		for _, a := range audience {
			if a.EventType == f.Type {
				selected = append(selected, a)
			}
		}
		if len(selected) == 0 {
			continue
		}
		eventID, err = c.id()
		if err != nil {
			return err
		}
		phase = "render"
		body, err := protocol.Render(eventID, f)
		if err != nil {
			return fmt.Errorf("render webhook event: %w", err)
		}
		hash := sha256.Sum256(body)
		phase = "capture"
		subject := "tasks/" + f.TaskID
		event := store.WebhookCapturedEvent{ID: eventID, EventType: f.Type, Source: "urn:daynight:project:" + project, Subject: subject, ProjectID: project, TaskID: f.TaskID, WireVersion: 1, SchemaVersion: 1, FactCodecVersion: 1, OccurredAt: f.OccurredAt, RecordedAt: recorded, OriginRequestID: requestID, FactBytes: body, FactSHA256: hash[:]}
		if f.Type != protocol.ThreadPosted {
			v := f.TaskVersion
			event.TaskVersion = &v
		}
		if f.Type == protocol.Deleted {
			event.TaskDeletedAt = f.DeletedAt
		}
		if f.Type == protocol.StepUpdated {
			event.Subject += "/steps"
			n, e := strconv.ParseInt(f.StepID, 16, 64)
			if e != nil {
				return e
			}
			event.StepID = &n
		}
		if f.Type == protocol.ThreadPosted {
			event.Subject += "/thread/" + f.MessageID
			m := f.MessageID
			event.MessageID = &m
		}
		var deliveries []store.WebhookCapturedDelivery
		for start := 0; start < len(selected); {
			a := selected[start]
			end := start + 1
			for end < len(selected) && selected[end].Endpoint.ID == a.Endpoint.ID {
				end++
			}
			ep := a.Endpoint
			endpointID, ownerKind, ownerID, adapterVersion = ep.ID, ep.Owner.Kind, ep.Owner.ID, 1
			if ep.DestinationKind != "http" || ep.AdapterVersion != "1" || a.ConfigurationSchemaVersion != 1 {
				return fmt.Errorf("unsupported webhook destination renderer")
			}
			id, err := c.id()
			if err != nil {
				return err
			}
			deliveryID = id
			if _, err := decodeEndpointDestination(ep); err != nil {
				return fmt.Errorf("decode webhook destination: %w", err)
			}
			d := store.WebhookCapturedDelivery{ID: id, EndpointID: ep.ID, Owner: ep.Owner, PolicyVersion: 1, DestinationRevision: ep.DestinationRevision, DestinationKind: ep.DestinationKind, AdapterVersion: 1, RenderVersion: 1, ConfigurationSchemaVersion: 1, DestinationOrigin: ep.Origin, DestinationConfiguration: append([]byte(nil), ep.DestinationConfiguration...), RequestMethod: "POST", RequestMediaType: protocol.MediaType, DeterministicHeadersJSON: []byte("[]"), Body: body, BodySHA256: hash[:], AutomaticExpiresAt: f.OccurredAt.Add(72 * time.Hour), PayloadExpiresAt: f.OccurredAt.Add(7 * 24 * time.Hour), LastActivityAt: recorded, MetadataExpiresAt: recorded.Add(time.Duration(policy.MetadataRetentionSeconds) * time.Second)}
			for _, m := range selected[start:end] {
				d.Matches = append(d.Matches, store.WebhookCapturedMatch{SubscriptionID: m.SubscriptionID, BindingID: m.BindingID, ProjectID: m.ProjectID, EventType: m.EventType, AuthorizationEpoch: m.AuthorizationEpoch})
			}
			d.OriginalMatchSHA256, err = MatchDigest(d.Matches)
			if err != nil {
				return err
			}
			d.AutomaticScheduleAt, err = c.schedule(f.OccurredAt, policy)
			if err != nil {
				return err
			}
			deliveries = append(deliveries, d)
			start = end
		}
		phase = "persist"
		deliveryID, endpointID, ownerKind, ownerID, adapterVersion = "", "", "", "", 0
		if err := dao.SaveCapture(ctx, event, deliveries); err != nil {
			return fmt.Errorf("persist webhook capture: %w", err)
		}
		if c.Logger != nil {
			for _, d := range deliveries {
				c.Logger.InfoContext(ctx, "webhook responsibility prepared", "component", "webhook", "phase", "persist", "event_id", eventID, "delivery_id", d.ID, "endpoint_id", d.EndpointID, "owner_kind", d.Owner.Kind, "owner_id", d.Owner.ID, "project_id", project, "schema_version", 1, "adapter_version", d.AdapterVersion, "origin_request_id", requestID)
			}
		}
	}
	return nil
}
