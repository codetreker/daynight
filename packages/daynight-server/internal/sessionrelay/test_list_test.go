package sessionrelay

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func listRegistration(t *testing.T, f fixture, p core.Principal, provider string) sp.Snapshot {
	t.Helper()
	v, err := f.s.RegisterTest(context.Background(), p, sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: provider, InitialInput: "none"})
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func listCredential(t *testing.T, f fixture, user string, kind core.CredentialKind) core.Principal {
	t.Helper()
	ctx := context.Background()
	p := core.Principal{Kind: kind, UserID: user, CredentialID: uuid.NewString()}
	hash := sha256.Sum256([]byte(p.CredentialID))
	if _, err := f.s.DB.Pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,($1::uuid)::text,now(),now()) ON CONFLICT DO NOTHING`, user); err != nil {
		t.Fatal(err)
	}
	table := "personal_access_tokens"
	columns := "id,user_id,token_hash,name,created_at,expires_at"
	values := "$1,$2,$3,'list',now(),now()+interval '1 day'"
	if kind == core.SessionCredential {
		table = "sessions"
		columns = "id,user_id,token_hash,created_at,expires_at"
		values = "$1,$2,$3,now(),now()+interval '1 day'"
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `INSERT INTO `+table+`(`+columns+`) VALUES(`+values+`)`, p.CredentialID, user, hash[:]); err != nil {
		t.Fatal(err)
	}
	return p
}
func TestListTestSessionsUsesOwnerParentAndStableActivityPagination(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	now := time.Now().UTC()
	created := now.Add(-time.Hour).Truncate(time.Microsecond)
	browser := listCredential(t, f, f.p.UserID, core.SessionCredential)
	other := listCredential(t, f, uuid.NewString(), core.PATCredential)
	listRegistration(t, f, other, "codex")
	if _, err := f.s.Register(ctx, f.p, f.project, f.task, f.r); err != nil {
		t.Fatal(err)
	}
	values := []sp.Snapshot{listRegistration(t, f, f.p, "codex"), listRegistration(t, f, f.p, "claude"), listRegistration(t, f, f.p, "copilot")}
	for i, v := range values {
		if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET created_at=$2 WHERE id=$1`, v.SessionID, created.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	// An archived session remains discoverable; bounded lease metadata determines recency.
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"archived"') WHERE id=$1`, values[0].SessionID); err != nil {
		t.Fatal(err)
	}
	eventTime := created.Add(time.Minute)
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET last_seen=$2 WHERE id=$1`, values[0].SessionID, eventTime); err != nil {
		t.Fatal(err)
	}
	expired := listCredential(t, f, f.p.UserID, core.PATCredential)
	listRegistration(t, f, expired, "copilot")
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE personal_access_tokens SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 second' WHERE id=$1`, expired.CredentialID); err != nil {
		t.Fatal(err)
	}
	page, err := f.s.ListTest(ctx, browser, "", 2, false)
	if err != nil || len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatal("first page", page, err)
	}
	if page.Items[0].SessionID != values[0].SessionID || page.Items[0].Lifecycle != "archived" || page.Items[0].ConnectionState != "disconnected" || !page.Items[0].UpdatedAt.Equal(eventTime) || !page.Items[0].CreatedAt.Equal(created) || page.Items[1].SessionID != values[2].SessionID {
		t.Fatal("order/metadata", page)
	}
	tail, err := f.s.ListTest(ctx, browser, *page.NextCursor, 2, false)
	if err != nil || len(tail.Items) != 1 || tail.Items[0].SessionID != values[1].SessionID || tail.NextCursor != nil {
		t.Fatal("tail", tail, err)
	}
	if _, err = f.s.ListTest(ctx, other, *page.NextCursor, 2, false); err == nil {
		t.Fatal("cross-owner cursor accepted")
	}
	foreign, err := f.s.ListTest(ctx, other, "", 50, false)
	if err != nil || len(foreign.Items) != 1 {
		t.Fatal("foreign ownership", foreign, err)
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	revoked, err := f.s.ListTest(ctx, browser, "", 50, false)
	if err != nil || len(revoked.Items) != 0 || revoked.Items == nil {
		t.Fatal("revoked parent still visible", revoked, err)
	}
	if _, err = f.s.ListTest(ctx, f.p, "", 50, false); err == nil {
		t.Fatal("revoked calling credential")
	}
}
func TestListTestSessionsTieCursorAndReadState(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	a := listRegistration(t, f, f.p, "codex")
	b := listRegistration(t, f, f.p, "claude")
	created := time.Now().Add(-time.Hour).UTC().Truncate(time.Microsecond)
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET created_at=$1,snapshot=jsonb_set(snapshot,'{connectionState}','"connected"'),last_seen=now()-interval '1 minute' WHERE scope='test'`, created); err != nil {
		t.Fatal(err)
	}
	p, err := f.s.ListTest(ctx, f.p, "", 1, false)
	if err != nil || p.NextCursor == nil {
		t.Fatal(p, err)
	}
	high, low := a.SessionID, b.SessionID
	if high < low {
		high, low = low, high
	}
	if p.Items[0].SessionID != high || p.Items[0].ConnectionState != "disconnected" {
		t.Fatal(p)
	}
	tail, err := f.s.ListTest(ctx, f.p, *p.NextCursor, 1, false)
	if err != nil || tail.Items[0].SessionID != low || tail.NextCursor != nil {
		t.Fatal(tail, err)
	}
	for _, limit := range []int{0, 101} {
		if _, err = f.s.ListTest(ctx, f.p, "", limit, false); err == nil {
			t.Fatal("limit", limit)
		}
	}
	position := testListPosition{Kind: "test-sessions", Owner: f.p.UserID, UpdatedAt: created, SessionID: high}
	for _, raw := range []string{"bad", strings.Repeat("a", 513), base64.RawURLEncoding.EncodeToString([]byte(`{"kind":"test-sessions","extra":1}`)), base64.RawURLEncoding.EncodeToString(encode(testListPosition{Kind: position.Kind, Owner: position.Owner, UpdatedAt: created, SessionID: "bad"}))} {
		if _, err = f.s.ListTest(ctx, f.p, raw, 1, false); err == nil {
			t.Fatal("cursor accepted", raw)
		}
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET draining_until=now()-interval '1 second',snapshot=jsonb_set(snapshot,'{lifecycle}','"draining"') WHERE id=$1`, high); err != nil {
		t.Fatal(err)
	}
	all, err := f.s.ListTest(ctx, f.p, "", 50, false)
	if err != nil || all.Items[0].Lifecycle != "archived" || all.Items[0].ConnectionState != "disconnected" {
		t.Fatal(all, err)
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET snapshot='"invalid snapshot"' WHERE id=$1`, high); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.ListTest(ctx, f.p, "", 50, false); err == nil {
		t.Fatal("invalid persisted snapshot")
	}
}

func TestListOnlineTestSessionsFiltersBeforePaginationAndBindsCursor(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	f.s.now = func() time.Time { return now }
	connection := listCredential(t, f, f.p.UserID, core.PATCredential)
	foreign := listCredential(t, f, uuid.NewString(), core.PATCredential)
	expired := listCredential(t, f, f.p.UserID, core.PATCredential)
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE personal_access_tokens SET created_at=$2::timestamptz-interval '1 hour',expires_at=$2 WHERE id=$1`, expired.CredentialID, now); err != nil {
		t.Fatal(err)
	}
	makeOnline := func(provider string, created time.Time) sp.Snapshot {
		v := listRegistration(t, f, f.p, provider)
		if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET created_at=$2,snapshot=jsonb_set(snapshot,'{connectionState}','"connected"'),last_seen=$3::timestamptz,connection_expires_at=$3::timestamptz+interval '1 hour',connection_parent_credential_id=$4 WHERE id=$1`, v.SessionID, created, now, connection.CredentialID); err != nil {
			t.Fatal(err)
		}
		return v
	}
	connected := makeOnline("codex", now.Add(-time.Hour))
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET last_seen=$2 WHERE id=$1`, connected.SessionID, now.Add(-HeartbeatTimeout)); err != nil {
		t.Fatal(err)
	}
	synchronizing := makeOnline("claude", now.Add(-time.Hour+time.Second))
	// A newly issued reconnect grant does not invalidate the still-live connection.
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{connectionState}','"synchronizing"'),grant_consumed=false,grant_expires_at=NULL WHERE id=$1`, synchronizing.SessionID); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, assignment string
		argument         any
	}{
		{"archived", `snapshot=jsonb_set(snapshot,'{lifecycle}','"archived"')`, nil},
		{"draining", `snapshot=jsonb_set(snapshot,'{lifecycle}','"draining"'),draining_until=$2`, now.Add(time.Hour)},
		{"disconnected", `connection_expires_at=NULL`, nil},
		{"no heartbeat", `last_seen=NULL`, nil},
		{"expired heartbeat", `last_seen=$2`, now.Add(-HeartbeatTimeout - time.Microsecond)},
		{"no expiry", `connection_expires_at=NULL`, nil},
		{"expired connection", `connection_expires_at=$2`, now},
		{"expired drain", `draining_until=$2`, now},
		{"missing connection parent", `connection_parent_credential_id=NULL`, nil},
		{"expired connection parent", `connection_parent_credential_id=$2`, expired.CredentialID},
		{"foreign connection parent", `connection_parent_credential_id=$2`, foreign.CredentialID},
	}
	for i, tc := range cases {
		v := makeOnline("copilot", now.Add(time.Duration(i)*time.Second))
		args := []any{v.SessionID}
		if tc.argument != nil {
			args = append(args, tc.argument)
		}
		if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET `+tc.assignment+` WHERE id=$1`, args...); err != nil {
			t.Fatal(tc.name, err)
		}
	}
	page, err := f.s.ListTest(ctx, f.p, "", 1, true)
	if err != nil || len(page.Items) != 1 || page.Items[0].SessionID != synchronizing.SessionID || page.Items[0].ConnectionState != "connected" || page.NextCursor == nil {
		t.Fatal("filtered first page", page, err)
	}
	tail, err := f.s.ListTest(ctx, f.p, *page.NextCursor, 1, true)
	if err != nil || len(tail.Items) != 1 || tail.Items[0].SessionID != connected.SessionID || tail.NextCursor != nil {
		t.Fatal("filtered tail", tail, err)
	}
	if _, err := f.s.ListTest(ctx, f.p, *page.NextCursor, 1, false); err == nil {
		t.Fatal("online cursor reused for all sessions")
	}
	all, err := f.s.ListTest(ctx, f.p, "", 1, false)
	if err != nil || all.NextCursor == nil {
		t.Fatal(all, err)
	}
	if _, err := f.s.ListTest(ctx, f.p, *all.NextCursor, 1, true); err == nil {
		t.Fatal("all cursor reused for online sessions")
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, connection.CredentialID); err != nil {
		t.Fatal(err)
	}
	page, err = f.s.ListTest(ctx, f.p, "", 50, true)
	if err != nil || len(page.Items) != 0 || page.Items == nil {
		t.Fatal("revoked connection still online", page, err)
	}
	all, err = f.s.ListTest(ctx, f.p, "", 50, false)
	if err != nil || len(all.Items) != len(cases)+2 {
		t.Fatal("all retains readable history", all, err)
	}
}
