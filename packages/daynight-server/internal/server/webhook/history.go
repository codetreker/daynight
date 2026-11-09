package webhook

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type historyService interface {
	ListDeliveries(context.Context, model.Principal, Owner, string, webhookservice.DeliveryQuery) (any, error)
	GetDelivery(context.Context, model.Principal, Owner, string, string) (any, error)
	ListAttempts(context.Context, model.Principal, Owner, string, string, webhookservice.AttemptQuery) (any, error)
	Payload(context.Context, model.Principal, Owner, string, string) (any, error)
	Redeliver(context.Context, model.Principal, Owner, string, string, webhookservice.Redelivery) (webhookservice.Result, error)
}

func (a Adapter) ListDeliveries(ctx context.Context, p model.Principal, o Owner, endpoint string, q webhookservice.DeliveryQuery) (any, error) {
	return a.Service.ListDeliveries(ctx, p, serviceOwner(o), endpoint, q)
}
func (a Adapter) GetDelivery(ctx context.Context, p model.Principal, o Owner, endpoint, delivery string) (any, error) {
	return a.Service.GetDelivery(ctx, p, serviceOwner(o), endpoint, delivery)
}
func (a Adapter) ListAttempts(ctx context.Context, p model.Principal, o Owner, endpoint, delivery string, q webhookservice.AttemptQuery) (any, error) {
	return a.Service.ListAttempts(ctx, p, serviceOwner(o), endpoint, delivery, q)
}
func (a Adapter) Payload(ctx context.Context, p model.Principal, o Owner, endpoint, delivery string) (any, error) {
	return a.Service.Payload(ctx, p, serviceOwner(o), endpoint, delivery)
}
func (a Adapter) Redeliver(ctx context.Context, p model.Principal, o Owner, endpoint, delivery string, input webhookservice.Redelivery) (webhookservice.Result, error) {
	return a.Service.Redeliver(ctx, p, serviceOwner(o), endpoint, delivery, input)
}

func deliveryQuery(r *http.Request) (webhookservice.DeliveryQuery, error) {
	var q webhookservice.DeliveryQuery
	if r.URL.ForceQuery && r.URL.RawQuery == "" {
		return q, httpx.InvalidInput("query must not be empty")
	}
	values, err := httpx.QueryValues(r, "eventType", "state", "projectId", "from", "to", "limit", "cursor")
	if err != nil {
		return q, err
	}
	page, err := httpx.PageValues(values)
	if err != nil {
		return q, err
	}
	q.Limit, q.Cursor = page.Limit, page.Cursor
	q.EventType, q.State, q.ProjectID = values.Get("eventType"), values.Get("state"), values.Get("projectId")
	if q.EventType != "" && !webhookcore.ValidEventType(q.EventType) {
		return q, httpx.InvalidInput("eventType must be registered")
	}
	if q.State != "" && q.State != "pending" && q.State != "leased" && q.State != "delivered" && q.State != "failed" && q.State != "suppressed" {
		return q, httpx.InvalidInput("invalid delivery state")
	}
	if q.ProjectID != "" {
		if _, err = uuidInput(q.ProjectID); err != nil {
			return q, err
		}
	}
	for _, field := range []struct {
		name   string
		target **time.Time
	}{{"from", &q.From}, {"to", &q.To}} {
		if value := values.Get(field.name); value != "" {
			t, e := time.Parse(time.RFC3339Nano, value)
			if e != nil || !strings.HasSuffix(value, "Z") {
				return q, httpx.InvalidInput("invalid time filter")
			}
			t = t.UTC()
			*field.target = &t
		}
	}
	if q.From != nil && q.To != nil && q.From.After(*q.To) {
		return q, httpx.InvalidInput("from must not be after to")
	}
	return q, nil
}

func attemptQuery(r *http.Request) (webhookservice.AttemptQuery, error) {
	var q webhookservice.AttemptQuery
	if r.URL.ForceQuery && r.URL.RawQuery == "" {
		return q, httpx.InvalidInput("query must not be empty")
	}
	values, err := httpx.QueryValues(r, "generation", "limit", "cursor")
	if err != nil {
		return q, err
	}
	page, err := httpx.PageValues(values)
	if err != nil {
		return q, err
	}
	q.Limit, q.Cursor = page.Limit, page.Cursor
	if v := values.Get("generation"); v != "" {
		n, e := webhookcore.ParseVersion(v)
		if e != nil {
			return q, httpx.InvalidInput("generation must be a positive int64 decimal string")
		}
		q.Generation = &n
	}
	return q, nil
}

func (h *Routes) history(w http.ResponseWriter, r *http.Request, p model.Principal, kind string) {
	o, err := owner(r, p)
	var endpoint, delivery string
	if err == nil {
		endpoint, err = uuidInput(r.PathValue("endpointId"))
	}
	if err == nil && kind != "deliveries" {
		delivery, err = uuidInput(r.PathValue("deliveryId"))
	}
	service, ok := h.service.(historyService)
	if err == nil && !ok {
		err = &model.Fault{Code: "dependency_unavailable", Message: "Webhook history service unavailable."}
	}
	var value any
	if err == nil {
		switch kind {
		case "deliveries":
			var q webhookservice.DeliveryQuery
			q, err = deliveryQuery(r)
			if err == nil {
				value, err = service.ListDeliveries(r.Context(), p, o, endpoint, q)
			}
		case "attempts":
			var q webhookservice.AttemptQuery
			q, err = attemptQuery(r)
			if err == nil {
				value, err = service.ListAttempts(r.Context(), p, o, endpoint, delivery, q)
			}
		case "delivery":
			err = noQuery(r)
			if err == nil {
				value, err = service.GetDelivery(r.Context(), p, o, endpoint, delivery)
			}
		case "payload":
			err = noQuery(r)
			if err == nil {
				value, err = service.Payload(r.Context(), p, o, endpoint, delivery)
			}
		case "redeliver":
			err = noQuery(r)
			if err == nil {
				var fields map[string]json.RawMessage
				var digest string
				fields, digest, err = readBody(w, r, "operationId", "issuedAt", "expectedUserId", "ifVersion", "ifGeneration")
				if err == nil {
					var m Mutation
					m, err = mutationInput(fields, digest, "delivery.redeliver", endpoint, p)
					if err == nil {
						var raw string
						raw, err = httpx.RequiredString(fields, "ifGeneration")
						if err == nil {
							var gen int64
							gen, err = webhookcore.ParseVersion(raw)
							if err != nil {
								err = httpx.InvalidInput("ifGeneration must be a positive int64 decimal string")
							} else {
								var result webhookservice.Result
								h.logOperation(r, p, o, m.OperationID, "delivery.redeliver")
								result, err = service.Redeliver(r.Context(), p, o, endpoint, delivery, webhookservice.Redelivery{OperationID: m.OperationID, IssuedAt: m.IssuedAt, ExpectedUserID: m.ExpectedUserID, IfVersion: m.IfVersion, IfGeneration: gen, RequestSHA256: digest})
								value = result.Body
							}
						}
					}
				}
			}
		}
	}
	if err != nil {
		h.failure(w, r, p, kind, err)
		return
	}
	if kind == "redeliver" {
		httpx.WriteMutationJSON(w, r, h.logger, "webhook", http.StatusAccepted, value)
		return
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, value)
}
