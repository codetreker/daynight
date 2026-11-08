package webhook_test

import (
	"testing"
	"time"
)

// Set setup identities to a point over 30 days before the event. Configuration
// operation receipts are omitted after their historical retention window; this
// does not rewrite their issued-at, fingerprint, or request digest.
func setJointFixtureTime(t *testing.T, f *captureFixture, endpoint string, configured time.Time) {
	t.Helper()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE users SET created_at=$1,updated_at=$1 WHERE id=$2`, []any{configured, f.principal.UserID}},
		{`UPDATE projects SET created_at=$1,updated_at=$1 WHERE id=$2`, []any{configured, f.project}},
		{`UPDATE teams SET created_at=$1,updated_at=$1 WHERE id=(SELECT team_id FROM project_ownership WHERE project_id=$2)`, []any{configured, f.project}},
		{`UPDATE team_members SET created_at=$1,updated_at=$1 WHERE team_id=(SELECT team_id FROM project_ownership WHERE project_id=$2)`, []any{configured, f.project}},
		{`UPDATE project_ownership SET updated_at=$1 WHERE project_id=$2`, []any{configured, f.project}},
		{`UPDATE webhook_endpoints SET created_at=$1,updated_at=$1 WHERE id=$2`, []any{configured, endpoint}},
		{`UPDATE webhook_signing_keys SET created_at=$1 WHERE endpoint_id=$2`, []any{configured, endpoint}},
		{`UPDATE webhook_subscriptions SET created_at=$1,updated_at=$1 WHERE endpoint_id=$2`, []any{configured, endpoint}},
		{`UPDATE webhook_bindings SET created_at=$1 WHERE subscription_id IN (SELECT id FROM webhook_subscriptions WHERE endpoint_id=$2)`, []any{configured, endpoint}},
		{`UPDATE webhook_endpoint_waits SET updated_at=$1 WHERE endpoint_id=$2`, []any{configured, endpoint}},
		{`DELETE FROM webhook_operations WHERE endpoint_id=$1`, []any{endpoint}},
	} {
		if _, err := f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
}

func assertJointFixtureTime(t *testing.T, f *captureFixture, endpoint string, occurred time.Time) {
	t.Helper()
	var coherent bool
	err := f.db.Pool.QueryRow(f.ctx, `SELECT e.created_at < $2 AND k.created_at < $2 AND s.created_at < $2 AND b.created_at < $2 AND p.created_at < $2 AND u.created_at < $2 AND tm.created_at < $2 AND po.updated_at < $2 AND w.updated_at < $2 FROM webhook_endpoints e JOIN webhook_signing_keys k ON k.id=e.active_key_id JOIN webhook_subscriptions s ON s.endpoint_id=e.id JOIN webhook_bindings b ON b.subscription_id=s.id JOIN projects p ON p.id=s.project_id JOIN users u ON u.id=e.owner_id JOIN project_ownership po ON po.project_id=p.id JOIN team_members tm ON tm.team_id=po.team_id AND tm.user_id=u.id JOIN webhook_endpoint_waits w ON w.endpoint_id=e.id AND w.destination_revision=e.destination_revision WHERE e.id=$1 LIMIT 1`, endpoint, occurred).Scan(&coherent)
	if err != nil || !coherent {
		t.Fatalf("historical configuration chronology coherent=%t err=%v", coherent, err)
	}
}
