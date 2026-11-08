package webhook

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

func notFound(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return fault("not_found", "Webhook resource was not found.")
	}
	return err
}
func version(v int64) string { return strconv.FormatInt(v, 10) }
func utcTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	v := t.UTC()
	return &v
}
func wireOperationKind(kind string) string {
	switch kind {
	case "endpoint.update":
		return "endpoint.patch"
	case "signing.rotate":
		return "signing-secret.rotate"
	}
	return kind
}
func opView(o wm.Operation) map[string]any {
	var key any
	if o.ActiveKeyID != "" {
		key = o.ActiveKeyID
	}
	var deliveryID, generationAfter any
	if o.DeliveryID != "" {
		deliveryID = o.DeliveryID
	}
	if o.GenerationAfter != nil {
		generationAfter = version(*o.GenerationAfter)
	}
	return map[string]any{"operationId": o.ID, "kind": wireOperationKind(o.Kind), "issuedAt": o.IssuedAt, "requestSha256": o.RequestSHA256, "actorUserId": o.ActorID, "owner": map[string]any{"kind": o.Owner.Kind, "id": o.Owner.ID}, "endpointId": o.TargetID, "effect": o.Effect, "configVersionAfter": version(o.ConfigVersion), "destinationRevisionAfter": version(o.DestinationRevisionAfter), "deliveryId": deliveryID, "generationAfter": generationAfter, "keyId": key, "recordedAt": o.RecordedAt.UTC(), "expiresAt": o.ExpiresAt.UTC()}
}
func (s *Service) endpointView(ctx context.Context, scope store.WebhookReadScope, e wm.Endpoint, actor string, manage bool) (map[string]any, error) {
	owner := map[string]any{"kind": e.Owner.Kind, "id": e.Owner.ID}
	if e.DeletedAt != nil {
		return map[string]any{"id": e.ID, "owner": owner, "lifecycle": "deleted", "configVersion": version(e.ConfigVersion), "deletedAt": utcTime(e.DeletedAt)}, nil
	}
	var url any
	display := e.Origin + "/…"
	if manage {
		destination, err := decodeEndpointDestination(e)
		if err != nil {
			return nil, err
		}
		url = destination.URL
		display = destination.URL
	}
	keys, err := scope.WebhookDAO().SigningKeys(ctx, e.ID)
	if err != nil {
		return nil, err
	}
	var overlap any
	now, err := scope.ObservedAt(ctx)
	if err != nil {
		return nil, err
	}
	for _, k := range keys {
		if k.ID != e.ActiveKeyID && k.RevokedAt == nil && k.OverlapUntil != nil && k.OverlapUntil.After(now) {
			overlap = utcTime(k.OverlapUntil)
		}
	}
	subscriptions, err := s.subscriptionViews(ctx, scope, e, actor)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": e.ID, "owner": owner, "lifecycle": "active", "name": e.Name, "enabled": e.Enabled, "configVersion": version(e.ConfigVersion), "destinationRevision": version(e.DestinationRevision), "destination": map[string]any{"kind": e.DestinationKind, "adapterVersion": e.AdapterVersion, "url": url, "displayUrl": display}, "signing": map[string]any{"scheme": "standard-webhooks-v1", "activeKeyId": e.ActiveKeyID, "overlapUntil": overlap}, "subscriptions": subscriptions, "capabilities": map[string]any{"manage": manage, "readSecret": manage, "redeliver": manage}, "createdAt": e.CreatedAt.UTC(), "updatedAt": e.UpdatedAt.UTC(), "deletedAt": nil}, nil
}
func (s *Service) Get(ctx context.Context, p model.Principal, o Owner, id string) (any, error) {
	var v any
	err := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		m, e := authorize(ctx, sc, p, o)
		if e != nil {
			return e
		}
		ep, e := sc.WebhookDAO().Endpoint(ctx, o, id)
		if e != nil {
			return notFound(e)
		}
		v, e = s.endpointView(ctx, sc, ep, p.UserID, m)
		return e
	})
	return v, err
}
func (s *Service) Operation(ctx context.Context, p model.Principal, o Owner, id string) (any, error) {
	var v any
	err := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		m, e := authorize(ctx, sc, p, o)
		if e != nil {
			return e
		}
		op, e := sc.WebhookDAO().Operation(ctx, o, id)
		if e != nil {
			return notFound(e)
		}
		if !m && op.ActorID != p.UserID {
			return fault("forbidden", "Access to this operation is denied.")
		}
		v = opView(op)
		return nil
	})
	return v, err
}
func (s *Service) Secret(ctx context.Context, p model.Principal, o Owner, id string) (any, error) {
	var v any
	err := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		m, e := authorize(ctx, sc, p, o)
		if e != nil {
			return e
		}
		if !m {
			return fault("forbidden", "Webhook management permission is required.")
		}
		ep, e := sc.WebhookDAO().Endpoint(ctx, o, id)
		if e != nil {
			return notFound(e)
		}
		if ep.DeletedAt != nil {
			return fault("not_found", "Webhook resource was not found.")
		}
		keys, e := sc.WebhookDAO().SigningKeys(ctx, id)
		if e != nil {
			return e
		}
		for _, k := range keys {
			if k.ID == ep.ActiveKeyID && k.RevokedAt == nil {
				if len(k.Secret) != 32 {
					return fmt.Errorf("invalid webhook signing key")
				}
				v = map[string]any{"endpointId": id, "configVersion": version(ep.ConfigVersion), "keyId": k.ID, "scheme": "standard-webhooks-v1", "secret": "whsec_" + base64.StdEncoding.EncodeToString(k.Secret)}
				return nil
			}
		}
		return fmt.Errorf("active signing key missing")
	})
	return v, err
}

// A cursor binds its scope and disclosure level to the position.
type cursor struct {
	Version                                              int
	List, User, Kind, Owner, Query, Enabled, View, After string
	CreatedAt                                            time.Time
}

func decodeCursor(data []byte, target any) error {
	var allowed []string
	switch target.(type) {
	case *cursor:
		allowed = []string{"Version", "List", "User", "Kind", "Owner", "Query", "Enabled", "View", "After", "CreatedAt"}
	case *historyCursor:
		allowed = []string{"Version", "Kind", "User", "OwnerKind", "OwnerID", "Endpoint", "Delivery", "Filter", "View", "ID", "Time", "Generation", "Sequence"}
	case *historyDisclosure:
		allowed = []string{"At", "State"}
	default:
		return fmt.Errorf("unsupported webhook cursor")
	}
	if _, err := jsonobject.Decode(data, "cursor", allowed...); err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func (s *Service) List(ctx context.Context, p model.Principal, o Owner, q ListQuery) (any, error) {
	var result any
	err := s.DB.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		m, e := authorize(ctx, sc, p, o)
		if e != nil {
			return e
		}
		history, e := historyReader(sc)
		if e != nil {
			return e
		}
		list, e := sc.WebhookDAO().Endpoints(ctx, o)
		if e != nil {
			return e
		}
		flag := "all"
		if q.Enabled != nil {
			flag = strconv.FormatBool(*q.Enabled)
		}
		c := cursor{Version: 1, List: "endpoints", User: p.UserID, Kind: o.Kind, Owner: o.ID, Query: q.Query, Enabled: flag, View: strconv.FormatBool(m)}
		if q.Cursor != nil {
			b, e := base64.RawURLEncoding.DecodeString(*q.Cursor)
			if e != nil {
				return fault("invalid_input", "Invalid cursor.")
			}
			var old cursor
			if decodeCursor(b, &old) != nil || old.Version != c.Version || old.List != c.List || old.View != c.View || old.CreatedAt.IsZero() || old.User != c.User || old.Kind != c.Kind || old.Owner != c.Owner || old.Query != c.Query || old.Enabled != c.Enabled || core.CanonicalUUID(old.After) != nil {
				return fault("invalid_input", "Invalid cursor.")
			}
			c.After = old.After
			c.CreatedAt = old.CreatedAt
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].CreatedAt.Equal(list[j].CreatedAt) {
				return list[i].ID < list[j].ID
			}
			return list[i].CreatedAt.Before(list[j].CreatedAt)
		})
		items := []any{}
		more := false
		last := ""
		var lastTime time.Time
		limit := q.Limit
		if limit < 1 {
			limit = 50
		}
		for _, ep := range list {
			if ep.DeletedAt != nil || (c.After != "" && (ep.CreatedAt.Before(c.CreatedAt) || (ep.CreatedAt.Equal(c.CreatedAt) && ep.ID <= c.After))) || (q.Enabled != nil && ep.Enabled != *q.Enabled) {
				continue
			}
			v, e := s.endpointView(ctx, sc, ep, p.UserID, m)
			if e != nil {
				return e
			}
			dest := v["destination"].(map[string]any)
			if q.Query != "" && !strings.Contains(strings.ToLower(ep.Name), strings.ToLower(q.Query)) && !strings.Contains(strings.ToLower(dest["displayUrl"].(string)), strings.ToLower(q.Query)) {
				continue
			}
			if len(items) == limit {
				more = true
				break
			}
			projects, eventTypes := map[string]bool{}, map[string]bool{}
			for _, item := range v["subscriptions"].([]any) {
				sub := item.(map[string]any)
				projects[sub["projectId"].(string)] = true
				for _, eventType := range sub["eventTypes"].([]string) {
					eventTypes[eventType] = true
				}
			}
			attempt, e := history.LatestAttempt(ctx, ep.ID)
			if e != nil {
				return e
			}
			var lastAttemptAt, lastResult any
			if attempt != nil {
				lastAttemptAt = attempt.AdmittedAt.UTC()
				lastResult = AttemptResult(*attempt)
			}
			items = append(items, map[string]any{"id": ep.ID, "owner": v["owner"], "name": ep.Name, "enabled": ep.Enabled, "configVersion": version(ep.ConfigVersion), "destination": dest, "projectCount": len(projects), "eventTypeCount": len(eventTypes), "lastResult": lastResult, "lastAttemptAt": lastAttemptAt})
			last = ep.ID
			lastTime = ep.CreatedAt
		}
		var next any
		if more {
			c.After = last
			c.CreatedAt = lastTime
			b, _ := json.Marshal(c)
			next = base64.RawURLEncoding.EncodeToString(b)
		}
		result = map[string]any{"items": items, "nextCursor": next}
		return nil
	})
	return result, err
}
