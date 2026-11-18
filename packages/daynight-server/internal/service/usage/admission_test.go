package usage

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
)

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

func TestUsageCursorRejectsMalformedAuthenticatedPayloads(t *testing.T) {
	s := newTestService(t, nil, Options{})
	sign := func(raw string) string {
		h := hmac.New(sha256.New, s.cursorKey)
		h.Write([]byte(raw))
		return base64.RawURLEncoding.EncodeToString([]byte(raw)) + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil))
	}
	for _, token := range []string{
		"missing-separator",
		"%.AA",
		"e30.%",
		sign("{"),
		sign(`{"expiresAt":"not-a-time"}`),
	} {
		_, err := s.decodeCursor(token, time.Now())
		code(t, err, "invalid_cursor")
	}
}
