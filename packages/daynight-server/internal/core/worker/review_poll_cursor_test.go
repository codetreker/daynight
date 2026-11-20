package worker

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestReviewPollCursorScopeAndValidation(t *testing.T) {
	const user = "a1111111-1111-4111-8111-111111111111"
	const worker = "b2222222-2222-4222-8222-222222222222"
	key := store.ReviewPollKey{ProjectID: "c3333333-3333-4333-8333-333333333333", RepositoryID: 9223372036854775807, GitHubPRID: 42}
	cursor := ReviewPollCursor(user, worker, 20, key)
	got, err := ReviewPollPage(model.PageRequest{Limit: 20, Cursor: &cursor}, user, worker)
	if err != nil || got == nil || *got != key {
		t.Fatalf("round trip: %+v %v", got, err)
	}
	for _, tc := range []struct {
		name, value, user, worker string
		limit                     int
	}{
		{"wrong user", cursor, worker, worker, 20}, {"wrong worker", cursor, user, user, 20}, {"wrong limit", cursor, user, worker, 21},
		{"invalid base64", cursor + "=", user, worker, 20}, {"oversize", strings.Repeat("a", 10000), user, worker, 20},
		{"duplicate", base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"v":1}`)), user, worker, 20},
		{"null", base64.RawURLEncoding.EncodeToString([]byte(`{"v":null}`)), user, worker, 20},
		{"extra", base64.RawURLEncoding.EncodeToString([]byte(`{"unexpected":1}`)), user, worker, 20},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ReviewPollPage(model.PageRequest{Limit: tc.limit, Cursor: &tc.value}, tc.user, tc.worker); err == nil {
				t.Fatal("accepted invalid cursor")
			}
		})
	}
	for _, limit := range []int{0, 101} {
		if _, err := ReviewPollPage(model.PageRequest{Limit: limit}, user, worker); err == nil {
			t.Fatalf("accepted limit %d", limit)
		}
	}
}
