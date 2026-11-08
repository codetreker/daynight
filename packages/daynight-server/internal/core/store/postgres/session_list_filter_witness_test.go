package postgres

import (
	"crypto/sha256"
	"encoding/json"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type sessionListFilterRow struct {
	id, owner, lifecycle, connection string
	created                          time.Time
	parent, connectionParent         *string
	seen, expiry, drain              *time.Time
}

func insertSessionListFilterRow(t *testing.T, database *Store, row sessionListFilterRow) {
	t.Helper()
	snapshot, err := json.Marshal(sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: row.id, TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}}, Lifecycle: row.lifecycle, ConnectionState: row.connection})
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id,created_at,parent_credential_id,connection_parent_credential_id,last_seen,connection_expires_at,draining_until)
 VALUES($1,$2,$1,'{}',$3,'test',$4,$5,$6,$7,$8,$9,$10)`, row.id, row.owner, snapshot, uuid.NewString(), row.created, row.parent, row.connectionParent, row.seen, row.expiry, row.drain)
}

func TestSessionListOnlineFiltersBeforePagination(t *testing.T) {
	database := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, database)
	_, foreign, _ := testAuthRecords(t, database)
	now := time.Now().UTC().Truncate(time.Microsecond)
	floor := now.Add(-30 * time.Second)
	parent, connection, expired, other := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, credential := range []struct {
		id, owner string
		expiry    time.Time
	}{{parent, actor.UserID, now.Add(time.Hour)}, {connection, actor.UserID, now.Add(time.Hour)}, {expired, actor.UserID, now}, {other, foreign.UserID, now.Add(time.Hour)}} {
		hash := sha256.Sum256([]byte(credential.id))
		mustQueryExec(t, database, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'list',$4,$5)`, credential.id, credential.owner, hash[:], now.Add(-time.Hour), credential.expiry)
	}
	row := func(id string) sessionListFilterRow {
		return sessionListFilterRow{id: id, owner: actor.UserID, lifecycle: "active", connection: "connected", created: now.Add(-time.Minute), parent: &parent, connectionParent: &connection, seen: &now, expiry: ptrTime(now.Add(time.Hour))}
	}
	connected, synchronizing := row(queryID(301)), row(queryID(302))
	connected.created, connected.seen = now.Add(-time.Hour), &floor
	synchronizing.created, synchronizing.connection = now.Add(-time.Hour+time.Second), "synchronizing"
	insertSessionListFilterRow(t, database, connected)
	insertSessionListFilterRow(t, database, synchronizing)
	cases := []struct {
		name   string
		change func(*sessionListFilterRow)
	}{
		{"archived", func(r *sessionListFilterRow) { r.lifecycle = "archived" }},
		{"draining", func(r *sessionListFilterRow) { r.lifecycle, r.drain = "draining", ptrTime(now.Add(time.Hour)) }},
		{"missing connection expiry", func(r *sessionListFilterRow) { r.expiry = nil }},
		{"missing heartbeat", func(r *sessionListFilterRow) { r.seen = nil }},
		{"expired heartbeat", func(r *sessionListFilterRow) { r.seen = ptrTime(floor.Add(-time.Microsecond)) }},
		{"expired connection", func(r *sessionListFilterRow) { r.expiry = &now }},
		{"expired drain", func(r *sessionListFilterRow) { r.drain = &now }},
		{"missing connection parent", func(r *sessionListFilterRow) { r.connectionParent = nil }},
		{"expired connection parent", func(r *sessionListFilterRow) { r.connectionParent = &expired }},
		{"foreign connection parent", func(r *sessionListFilterRow) { r.connectionParent = &other }},
	}
	for index, test := range cases {
		r := row(queryID(310 + index))
		test.change(&r)
		insertSessionListFilterRow(t, database, r)
	}
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		items, err := dao.ListTestSessions(t.Context(), actor.UserID, now, 1, true, floor, nil, "")
		if err != nil || len(items) != 2 || items[0].Snapshot.SessionID != synchronizing.id || items[1].Snapshot.SessionID != connected.id {
			t.Fatalf("online filters, heartbeat edge and lookahead: %+v %v", items, err)
		}
		cursor := items[0].UpdatedAt
		items, err = dao.ListTestSessions(t.Context(), actor.UserID, now, 1, true, floor, &cursor, synchronizing.id)
		if err != nil || len(items) != 1 || items[0].Snapshot.SessionID != connected.id {
			t.Fatalf("filtered cursor tail: %+v %v", items, err)
		}
		return nil
	})
	mustQueryExec(t, database, `DELETE FROM personal_access_tokens WHERE id=$1`, connection)
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		items, err := dao.ListTestSessions(t.Context(), actor.UserID, now, 100, true, floor, nil, "")
		if err != nil || len(items) != 0 {
			t.Fatalf("revoked connection retained online sessions: %+v %v", items, err)
		}
		items, err = dao.ListTestSessions(t.Context(), actor.UserID, now, 100, false, floor, nil, "")
		if err != nil || len(items) != len(cases)+2 {
			t.Fatalf("connection revocation removed readable history: count=%d error=%v", len(items), err)
		}
		return nil
	})
}

func TestSessionListParentOwnershipAndTiedCursor(t *testing.T) {
	database := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, database)
	_, foreign, _ := testAuthRecords(t, database)
	now := time.Now().UTC().Truncate(time.Microsecond)
	created := now.Add(-time.Hour)
	parent, expired, other := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, credential := range []struct {
		id, owner string
		expiry    time.Time
	}{{parent, actor.UserID, now.Add(time.Hour)}, {expired, actor.UserID, now}, {other, foreign.UserID, now.Add(time.Hour)}} {
		hash := sha256.Sum256([]byte(credential.id))
		mustQueryExec(t, database, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'list',$4,$5)`, credential.id, credential.owner, hash[:], created.Add(-time.Hour), credential.expiry)
	}
	for index, credential := range []*string{&parent, &parent, &expired, &other} {
		insertSessionListFilterRow(t, database, sessionListFilterRow{id: queryID(401 + index), owner: actor.UserID, lifecycle: "archived", created: created, parent: credential})
	}
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		items, err := dao.ListTestSessions(t.Context(), actor.UserID, now, 1, false, now, nil, "")
		if err != nil || len(items) != 2 || items[0].Snapshot.SessionID != queryID(402) || items[1].Snapshot.SessionID != queryID(401) || !items[0].UpdatedAt.Equal(created) {
			t.Fatalf("parent ownership and tied ID ordering: %+v %v", items, err)
		}
		items, err = dao.ListTestSessions(t.Context(), actor.UserID, now, 1, false, now, &created, queryID(402))
		if err != nil || len(items) != 1 || items[0].Snapshot.SessionID != queryID(401) {
			t.Fatalf("tied cursor skipped or duplicated history: %+v %v", items, err)
		}
		return nil
	})
	mustQueryExec(t, database, `DELETE FROM personal_access_tokens WHERE id=$1`, parent)
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		items, err := scope.SessionDAO().ListTestSessions(t.Context(), actor.UserID, now, 100, false, now, nil, "")
		if err != nil || len(items) != 0 {
			t.Fatalf("revoked registration parent remained discoverable: %+v %v", items, err)
		}
		return nil
	})
}
