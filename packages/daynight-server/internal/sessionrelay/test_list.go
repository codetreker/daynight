package sessionrelay

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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

func (s *Service) ListTest(ctx context.Context, p core.Principal, token string, limit int, online bool) (TestListPage, error) {
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
	err = transact(ctx, s.DB, func(tx pgx.Tx) error {
		now := s.now()
		if err := credential(ctx, tx, p, now); err != nil {
			return err
		}
		// Latest durable event time gives existing sessions an activity timestamp
		// without introducing a second clock or treating heartbeats as new work.
		query := `SELECT ts.snapshot,ts.created_at,recent.updated_at,ts.last_seen,ts.draining_until
   FROM task_sessions ts
   CROSS JOIN LATERAL (SELECT GREATEST(ts.created_at,COALESCE((SELECT e.created_at FROM session_events e WHERE e.session_id=ts.id ORDER BY e.event_seq DESC LIMIT 1),ts.created_at)) AS updated_at) recent
   WHERE ts.scope='test' AND ts.owner_user_id=$1
   AND (ts.parent_credential_id IS NULL OR EXISTS (SELECT 1 FROM personal_access_tokens pat WHERE pat.id=ts.parent_credential_id AND pat.user_id=$1 AND (pat.expires_at IS NULL OR pat.expires_at>$2) FOR SHARE))
   AND (NOT $4::boolean OR (
     ts.snapshot->>'lifecycle'='active'
     AND ts.snapshot->>'connectionState' IN ('connected','synchronizing')
     AND ts.last_seen >= $5::timestamptz
     AND ts.connection_expires_at > $2
     AND (ts.draining_until IS NULL OR ts.draining_until > $2)
     AND EXISTS (SELECT 1 FROM personal_access_tokens pat WHERE pat.id=ts.connection_parent_credential_id AND pat.user_id=$1 AND (pat.expires_at IS NULL OR pat.expires_at>$2) FOR SHARE)
   ))`
		// Connection leases belong to the credential captured at Connect. A fresh
		// grant may be unconsumed while the previous connection remains valid.
		args := []any{p.UserID, now, limit + 1, online, now.Add(-HeartbeatTimeout)}
		if token != "" {
			query += ` AND (recent.updated_at,ts.id)<($6::timestamptz,$7::uuid)`
			args = append(args, position.UpdatedAt, position.SessionID)
		}
		query += ` ORDER BY recent.updated_at DESC,ts.id DESC LIMIT $3`
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var raw []byte
			var item TestListItem
			var r record
			if err = rows.Scan(&raw, &item.CreatedAt, &item.UpdatedAt, &r.LastSeen, &r.DrainUntil); err != nil {
				return err
			}
			if err = json.Unmarshal(raw, &r.Snapshot); err != nil {
				return err
			}
			v := permissions(&r, false, now)
			item.SessionID = v.SessionID
			item.Provider = v.Identity.Provider
			item.Lifecycle = v.Lifecycle
			item.ConnectionState = v.ConnectionState
			item.CreatedAt = item.CreatedAt.UTC()
			item.UpdatedAt = item.UpdatedAt.UTC()
			page.Items = append(page.Items, item)
		}
		return rows.Err()
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
