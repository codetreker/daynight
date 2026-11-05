package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type TestListItem struct {
	SessionID       string    `json:"sessionId"`
	Provider        string    `json:"provider"`
	Lifecycle       string    `json:"lifecycle"`
	ConnectionState string    `json:"connectionState"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}
type TestListPage struct {
	Items      []TestListItem `json:"items"`
	NextCursor *string        `json:"nextCursor"`
}
type testListPosition struct {
	Online    bool      `json:"online,omitempty"`
	Kind      string    `json:"kind"`
	Owner     string    `json:"owner"`
	UpdatedAt time.Time `json:"updatedAt"`
	SessionID string    `json:"sessionId"`
}

func testListCursor(value string, owner string, online bool) (testListPosition, error) {
	var p testListPosition
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(value) > 512 || json.Unmarshal(raw, &p) != nil || !bytes.Equal(raw, encode(p)) || p.Kind != "test-sessions" || p.Owner != owner || p.Online != online || p.UpdatedAt.IsZero() {
		return p, fault("invalid_input", "Invalid test session list cursor.")
	}
	id, idErr := uuid.Parse(p.SessionID)
	if idErr != nil || id.String() != p.SessionID {
		return p, fault("invalid_input", "Invalid test session list cursor.")
	}
	return p, nil
}

func (s *Execution) ListTest(ctx context.Context, p model.Principal, token string, limit int, online bool) (TestListPage, error) {
	page := TestListPage{Items: []TestListItem{}}
	if limit < 1 || limit > 100 {
		return page, fault("invalid_input", "Test session list limit must be between 1 and 100.")
	}
	var position testListPosition
	var err error
	if token != "" {
		position, err = testListCursor(token, p.UserID, online)
		if err != nil {
			return page, err
		}
	}
	err = s.credentialRun(ctx, p, func(op *Operation, scope store.SessionScope) error {
		_, tx := op.scoped(scope)
		now := s.now()
		var cursor *time.Time
		if token != "" {
			cursor = &position.UpdatedAt
		}
		items, err := tx.dao.ListTestSessions(ctx, p.UserID, now, limit, online, now.Add(-HeartbeatTimeout), cursor, position.SessionID)
		if err != nil {
			return err
		}
		for _, value := range items {
			r := record{Snapshot: durableSnapshot(value.Snapshot), LastSeen: value.LastSeen, DrainUntil: value.DrainUntil}
			if online {
				r.Snapshot.ConnectionState = "connected"
			}
			v := permissions(&r, false, now)
			page.Items = append(page.Items, TestListItem{SessionID: v.SessionID, Provider: v.Identity.Provider, Lifecycle: v.Lifecycle, ConnectionState: v.ConnectionState, CreatedAt: value.CreatedAt.UTC(), UpdatedAt: value.UpdatedAt.UTC()})
		}
		return nil
	})
	if err != nil {
		return TestListPage{}, err
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		last := page.Items[limit-1]
		token := base64.RawURLEncoding.EncodeToString(encode(testListPosition{Online: online, Kind: "test-sessions", Owner: p.UserID, UpdatedAt: last.UpdatedAt, SessionID: last.SessionID}))
		page.NextCursor = &token
	}
	return page, nil
}
