package webhook

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func historyPageRows(f *historyScenario, n int) []store.WebhookDelivery {
	rows := make([]store.WebhookDelivery, n)
	for i := range rows {
		rows[i] = f.d
		rows[i].ID = fmt.Sprintf("%08x-1111-4111-8111-111111111111", i+1)
		rows[i].EventID = fmt.Sprintf("%08x-2222-4222-8222-222222222222", i+1)
		rows[i].OccurredAt = f.d.OccurredAt.Add(time.Duration(i) * time.Minute)
	}
	return rows
}

func TestHistoryDeliveryPaginationUsesLastEmittedPosition(t *testing.T) {
	f := newHistoryScenario(t)
	rows := historyPageRows(f, 3)
	call := 0
	f.reader.batch = func(_ context.Context, o Owner, e, actor string, at time.Time, id string, limit int) (store.WebhookHistoryBatch, error) {
		if o != f.owner || e != f.d.EndpointID || limit != 100 {
			t.Fatal("wrong history DAO scan")
		}
		if call == 0 {
			if !at.IsZero() || id != "" {
				t.Fatal("first scan has position")
			}
		} else if !at.Equal(rows[call-1].OccurredAt) || id != rows[call-1].ID {
			t.Fatalf("position=%v %s", at, id)
		}
		v := rows[call:]
		call++
		return historyBatchRows(f, v), nil
	}
	var cursor *string
	for i := range rows {
		svc := &Service{DB: f.service.DB}
		v, err := svc.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{Limit: 1, Cursor: cursor})
		retentionFail(t, err)
		p := v.(map[string]any)
		items := p["items"].([]any)
		if len(items) != 1 || items[0].(map[string]any)["id"] != rows[i].ID || p["historyMayBeIncomplete"] != true || p["retention"] == nil {
			t.Fatalf("page %d=%v", i, p)
		}
		if i < 2 {
			next := p["nextCursor"].(string)
			raw, err := base64.RawURLEncoding.DecodeString(next)
			if err != nil || strings.Contains(string(raw), f.d.ProjectID) || strings.Contains(string(raw), f.src.Event.TaskID) {
				t.Fatalf("cursor leaked resource identities %s %v", raw, err)
			}
			cursor = &next
		} else if p["nextCursor"] != nil {
			t.Fatal("last page claims more")
		}
	}
}

func TestHistoryFilteringCannotRevealMetadataOnlySources(t *testing.T) {
	for _, q := range []DeliveryQuery{{EventType: "task.created"}, {ProjectID: "44444444-4444-4444-8444-444444444444"}, {State: "failed"}, {From: func() *time.Time { x := retentionTestNow; return &x }()}, {To: func() *time.Time { x := retentionTestNow.Add(-2 * time.Hour); return &x }()}} {
		t.Run(fmt.Sprint(q), func(t *testing.T) {
			f := newHistoryScenario(t)
			rows := historyPageRows(f, 2)
			f.src.ProjectReadable = false
			f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
				return historyBatchRows(f, rows), nil
			}
			v, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, q)
			retentionFail(t, err)
			if p := v.(map[string]any); len(p["items"].([]any)) != 0 || p["nextCursor"] != nil {
				t.Fatalf("hidden filter matched=%v", p)
			}
		})
	}
}

func TestHistoryContinuesPastFullFilteredDAOPage(t *testing.T) {
	f := newHistoryScenario(t)
	rows := historyPageRows(f, 101)
	call := 0
	f.reader.batch = func(_ context.Context, _ Owner, _ string, _ string, at time.Time, id string, n int) (store.WebhookHistoryBatch, error) {
		if n != 100 {
			t.Fatal("unbounded history scan")
		}
		call++
		if call == 1 {
			return historyBatchRows(f, rows[:100]), nil
		}
		if call == 2 {
			if !at.Equal(rows[99].OccurredAt) || id != rows[99].ID {
				t.Fatal("scan did not advance across filtered rows")
			}
			return historyBatchRows(f, rows[100:]), nil
		}
		t.Fatal("unexpected scan")
		return store.WebhookHistoryBatch{}, nil
	}
	readBatch := f.reader.batch
	f.reader.batch = func(c context.Context, o Owner, e, actor string, at time.Time, id string, n int) (store.WebhookHistoryBatch, error) {
		batch, err := readBatch(c, o, e, actor, at, id, n)
		for i := range batch.Items {
			batch.Items[i].Sources.ProjectReadable = batch.Items[i].Delivery.ID == rows[100].ID
		}
		return batch, err
	}
	v, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{EventType: "task.created"})
	retentionFail(t, err)
	p := v.(map[string]any)
	items := p["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["id"] != rows[100].ID || call != 2 {
		t.Fatalf("filtered paging=%v calls=%d", p, call)
	}
}

func TestHistoryDeliveryCursorBindsDisclosureAndQuery(t *testing.T) {
	f := newHistoryScenario(t)
	rows := historyPageRows(f, 2)
	f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
		return historyBatchRows(f, rows), nil
	}
	v, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{Limit: 1})
	retentionFail(t, err)
	cursor := v.(map[string]any)["nextCursor"].(string)
	for _, query := range []DeliveryQuery{{Limit: 1, State: "failed"}, {Limit: 1, EventType: "task.deleted"}, {Limit: 1, ProjectID: f.d.ProjectID}, {Limit: 1, From: func() *time.Time { x := retentionTestNow; return &x }()}} {
		query.Cursor = &cursor
		_, err = f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, query)
		historyFaultCode(t, err, "invalid_input")
	}
	f.reader.disclosure = func(context.Context, Owner, string, string, time.Time) (string, error) {
		return "authorization-changed", nil
	}
	_, err = f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{Limit: 1, Cursor: &cursor})
	historyFaultCode(t, err, "invalid_input")
}

func TestHistoryCursorValidatesScopeAndPosition(t *testing.T) {
	expected := historyCursor{Version: 1, Kind: "deliveries", User: "user", OwnerKind: "personal", OwnerID: "owner", Endpoint: "endpoint", Delivery: "", Filter: "filter", View: "view"}
	valid := expected
	valid.ID = "11111111-1111-4111-8111-111111111111"
	valid.Time = retentionTestNow
	for _, mutate := range []struct {
		name string
		f    func(*historyCursor)
	}{
		{"version", func(c *historyCursor) { c.Version = 2 }}, {"kind", func(c *historyCursor) { c.Kind = "attempts" }}, {"user", func(c *historyCursor) { c.User = "other" }}, {"owner kind", func(c *historyCursor) { c.OwnerKind = "team" }}, {"owner", func(c *historyCursor) { c.OwnerID = "other" }}, {"endpoint", func(c *historyCursor) { c.Endpoint = "other" }}, {"delivery", func(c *historyCursor) { c.Delivery = "other" }}, {"filter", func(c *historyCursor) { c.Filter = "other" }}, {"view", func(c *historyCursor) { c.View = "other" }}, {"ID", func(c *historyCursor) { c.ID = "bad" }}, {"zero time", func(c *historyCursor) { c.Time = time.Time{} }}, {"generation", func(c *historyCursor) { c.Generation = 1 }}, {"sequence", func(c *historyCursor) { c.Sequence = 1 }},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			c := valid
			mutate.f(&c)
			b, err := json.Marshal(c)
			retentionFail(t, err)
			encoded := base64.RawURLEncoding.EncodeToString(b)
			_, err = (&Service{}).readHistoryCursor(&encoded, expected)
			historyFaultCode(t, err, "invalid_input")
		})
	}
	for _, raw := range []string{"%", base64.RawURLEncoding.EncodeToString([]byte("{}")), base64.RawURLEncoding.EncodeToString([]byte(`{"unknown":true}`))} {
		_, err := (&Service{}).readHistoryCursor(&raw, expected)
		historyFaultCode(t, err, "invalid_input")
	}
	attempts := expected
	attempts.Kind = "attempts"
	for _, c := range []historyCursor{{Version: 1, Kind: "attempts", User: expected.User, OwnerKind: expected.OwnerKind, OwnerID: expected.OwnerID, Endpoint: expected.Endpoint, Filter: expected.Filter, View: expected.View, ID: valid.ID, Generation: 0, Sequence: 1}, {Version: 1, Kind: "attempts", User: expected.User, OwnerKind: expected.OwnerKind, OwnerID: expected.OwnerID, Endpoint: expected.Endpoint, Filter: expected.Filter, View: expected.View, ID: valid.ID, Generation: 1, Sequence: 14}} {
		b, _ := json.Marshal(c)
		encoded := base64.RawURLEncoding.EncodeToString(b)
		_, err := (&Service{}).readHistoryCursor(&encoded, attempts)
		historyFaultCode(t, err, "invalid_input")
	}
}

func TestHistoryAttemptPaginationAndGenerationFilter(t *testing.T) {
	f := newHistoryScenario(t)
	var attempts []store.WebhookAttempt
	for i := 1; i <= 3; i++ {
		attempts = append(attempts, store.WebhookAttempt{ID: fmt.Sprintf("%08x-1111-4111-8111-111111111111", i), DeliveryID: f.d.ID, EndpointID: f.d.EndpointID, Generation: int64((i + 1) / 2), Sequence: int16(i), AdmittedAt: retentionTestNow})
	}
	f.reader.attempts = func(context.Context, string) ([]store.WebhookAttempt, error) { return attempts, nil }
	v, err := f.service.ListAttempts(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID, AttemptQuery{Limit: 1})
	retentionFail(t, err)
	p := v.(map[string]any)
	cursor := p["nextCursor"].(string)
	if len(p["items"].([]any)) != 1 || p["items"].([]any)[0].(map[string]any)["id"] != attempts[0].ID {
		t.Fatalf("first attempts=%v", p)
	}
	v, err = (&Service{DB: f.service.DB}).ListAttempts(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID, AttemptQuery{Limit: 100, Cursor: &cursor})
	retentionFail(t, err)
	items := v.(map[string]any)["items"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["id"] != attempts[1].ID {
		t.Fatalf("attempt resume=%v", v)
	}
	gen := int64(2)
	v, err = f.service.ListAttempts(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID, AttemptQuery{Generation: &gen})
	retentionFail(t, err)
	if len(v.(map[string]any)["items"].([]any)) != 1 {
		t.Fatalf("generation filter=%v", v)
	}
	_, err = f.service.ListAttempts(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID, AttemptQuery{Generation: &gen, Cursor: &cursor})
	historyFaultCode(t, err, "invalid_input")
	f.src.ProjectReadable = false
	_, err = f.service.ListAttempts(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID, AttemptQuery{Cursor: &cursor})
	historyFaultCode(t, err, "invalid_input")
}

func TestHistoryListLimitsAndEmptyPages(t *testing.T) {
	for _, limit := range []int{-1, 101} {
		for _, kind := range []string{"deliveries", "attempts"} {
			t.Run(fmt.Sprintf("%s/%d", kind, limit), func(t *testing.T) {
				f := newHistoryScenario(t)
				var err error
				if kind == "deliveries" {
					_, err = f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{Limit: limit})
				} else {
					_, err = f.service.ListAttempts(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID, AttemptQuery{Limit: limit})
				}
				historyFaultCode(t, err, "invalid_input")
			})
		}
	}
	f := newHistoryScenario(t)
	f.reader.batch = func(context.Context, Owner, string, string, time.Time, string, int) (store.WebhookHistoryBatch, error) {
		return store.WebhookHistoryBatch{}, nil
	}
	for _, limit := range []int{0, 1, 100} {
		v, err := f.service.ListDeliveries(t.Context(), f.principal, f.owner, f.d.EndpointID, DeliveryQuery{Limit: limit})
		retentionFail(t, err)
		p := v.(map[string]any)
		if len(p["items"].([]any)) != 0 || p["nextCursor"] != nil || p["historyMayBeIncomplete"] != true || p["retention"] == nil {
			t.Fatalf("empty delivery=%v", p)
		}
	}
	v, err := f.service.ListAttempts(t.Context(), f.principal, f.owner, f.d.EndpointID, f.d.ID, AttemptQuery{})
	retentionFail(t, err)
	if p := v.(map[string]any); len(p["items"].([]any)) != 0 || p["nextCursor"] != nil || p["retention"] == nil {
		t.Fatalf("empty attempts=%v", p)
	}
}
