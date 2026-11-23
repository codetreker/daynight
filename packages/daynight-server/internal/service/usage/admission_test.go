package usage

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
)

func TestRegistrationReplayRejectsCorruptStoredGrantVerifier(t *testing.T) {
	for _, raw := range [][]byte{nil, make([]byte, 32), make([]byte, 65)} {
		old := model.UsageRecord{GrantHash: raw}
		err := matchRegistration(old, model.UsageRecord{}, "controller", "1")
		if !errors.Is(err, core.ErrInvalidGrantVerifier) {
			t.Fatal("corrupt grant storage was treated as a registration replay", err)
		}
	}
}

func TestUsageRejectsInvalidRequestsBeforeOpeningTransactions(t *testing.T) {
	s := newTestService(t, nil, Options{WriteEnabled: true})
	ctx := t.Context()
	id := "10000000-0000-4000-8000-000000000001"
	_, err := s.Register(ctx, model.Principal{}, Registration{Protocol: "unknown"})
	code(t, err, "invalid_registration")
	_, err = s.Rotate(ctx, model.Principal{}, id, GrantRequest{ExpectedRowVersion: "0"})
	code(t, err, "invalid_registration")
	_, err = s.Revoke(ctx, model.Principal{}, id, "01")
	code(t, err, "invalid_registration")
	_, err = s.Batch(ctx, id, "token", Batch{Protocol: core.Protocol, BatchID: id})
	code(t, err, "invalid_batch")
	event := model.UsageEvent{EventID: id}
	_, err = s.Batch(ctx, id, "token", Batch{Protocol: core.Protocol, BatchID: id, Events: []model.UsageEvent{event, event}})
	code(t, err, "invalid_batch")
	for _, keys := range [][]string{nil, {""}, {strings.Repeat("x", 257)}} {
		_, err = s.Sources(ctx, id, "token", keys)
		code(t, err, "invalid_batch")
	}
	_, err = s.TaskSummaries(ctx, model.Principal{}, id, nil)
	code(t, err, "invalid_batch")
	for _, filter := range []PageRequest{
		{Kind: "measurement", Limit: 101},
		{Kind: "unknown", Limit: 1},
		{Kind: "measurement", Limit: 1, StateID: "not-a-uuid"},
		{Kind: "measurement", Limit: 1, Model: "unsafe\x00model"},
		{Kind: "measurement", Limit: 1, Provider: "unknown"},
		{Kind: "measurement", Limit: 1, Role: "unknown"},
	} {
		_, err = s.Records(ctx, model.Principal{}, id, id, "", filter)
		code(t, err, "invalid_filter")
	}
	_, err = s.Aggregate(ctx, model.Principal{}, id, "unknown", id, "")
	code(t, err, "resource_unavailable")
}

func TestUsageCursorFormatAndLegacyTransition(t *testing.T) {
	s := newTestService(t, nil, Options{})
	now := time.Date(2026, 11, 20, 1, 2, 3, 0, time.UTC)
	for _, lastTime := range []time.Time{now, {}} {
		c := cursor{Binding: strings.Repeat("a", 64), Revision: strings.Repeat("b", 64), LastTime: lastTime, LastID: "10000000-0000-4000-8000-000000000001", ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano)}
		token, err := s.encodeCursor(c)
		if err != nil {
			t.Fatal(err)
		}
		// The old signed format used this JSON as its first segment.
		lastTimeJSON := `2026-11-20T01:02:03Z`
		if lastTime.IsZero() {
			lastTimeJSON = `0001-01-01T00:00:00Z`
		}
		legacyJSON := `{"binding":"` + strings.Repeat("a", 64) + `","revision":"` + strings.Repeat("b", 64) + `","lastTime":"` + lastTimeJSON + `","lastId":"10000000-0000-4000-8000-000000000001","expiresAt":"2026-11-20T01:03:03Z"}`
		if token != base64.RawURLEncoding.EncodeToString([]byte(legacyJSON)) {
			t.Fatalf("payload changed: %q", token)
		}
		decoded, err := s.decodeCursor(token, now, !lastTime.IsZero())
		if err != nil || decoded != c {
			t.Fatalf("round trip: %#v %v", decoded, err)
		}
		_, err = s.decodeCursor(token, now.Add(time.Minute), !lastTime.IsZero())
		code(t, err, "cursor_expired")
		_, err = s.decodeCursor(token+"."+strings.Repeat("A", 43), now, !lastTime.IsZero())
		code(t, err, "reset_required")
	}
	for _, token := range []string{". " + strings.Repeat("A", 43), "a." + strings.Repeat("A", 42), "a." + strings.Repeat("A", 43) + ".", strings.Repeat("a", 4097) + "." + strings.Repeat("A", 43)} {
		_, err := s.decodeCursor(token, now, true)
		code(t, err, "invalid_cursor")
	}
}

func TestUsageCursorRejectsMalformedPayloads(t *testing.T) {
	s := newTestService(t, nil, Options{})
	now := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	binding, revision := strings.Repeat("a", 64), strings.Repeat("b", 64)
	valid := `{"binding":"` + binding + `","revision":"` + revision + `","lastTime":"2026-11-20T00:00:00Z","lastId":"10000000-0000-4000-8000-000000000001","expiresAt":"2026-11-20T00:15:00Z"}`
	payloads := []string{
		`{`, `[]`, `null`, valid + `{}`,
		strings.Replace(valid, `"binding":"`+binding+`",`, "", 1),
		strings.Replace(valid, `"binding":"`+binding+`"`, `"binding":null`, 1),
		strings.Replace(valid, `"binding":"`+binding+`"`, `"binding":""`, 1),
		strings.Replace(valid, binding, strings.Repeat("A", 64), 1),
		strings.Replace(valid, `"revision":"`+revision+`"`, `"revision":17`, 1),
		strings.Replace(valid, `"lastTime":"2026-11-20T00:00:00Z"`, `"lastTime":null`, 1),
		strings.Replace(valid, `"lastTime":"2026-11-20T00:00:00Z"`, `"lastTime":"0001-01-01T00:00:00Z"`, 1),
		strings.Replace(valid, `"lastId":"10000000-0000-4000-8000-000000000001"`, `"lastId":"invalid"`, 1),
		strings.Replace(valid, `"expiresAt":"2026-11-20T00:15:00Z"`, `"expiresAt":"invalid"`, 1),
		strings.Replace(valid, `"binding":`, `"unknown":true,"binding":`, 1),
		strings.Replace(valid, `"binding":`, `"binding":"`+binding+`","binding":`, 1),
	}
	for _, payload := range payloads {
		t.Run(payload, func(t *testing.T) {
			_, err := s.decodeCursor(base64.RawURLEncoding.EncodeToString([]byte(payload)), now, true)
			code(t, err, "invalid_cursor")
		})
	}
	for _, token := range []string{"%", "e30=", "e30\n", "e31", strings.Repeat("x", 4097)} {
		_, err := s.decodeCursor(token, now, true)
		code(t, err, "invalid_cursor")
	}
}
