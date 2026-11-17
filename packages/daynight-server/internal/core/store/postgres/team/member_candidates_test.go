package team_test

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestMemberCandidatesLiteralMatchingAndKeyset(t *testing.T) {
	tx := teamTransaction(t)
	a := addUser(t, tx, "Alpha%_\\ Mira")
	b := addUser(t, tx, "Alpha%_\\ Mira")
	c := addUser(t, tx, "Unrelated")
	d := addUser(t, tx, "Only name")
	e := addUser(t, tx, "Blank")
	large := strings.Repeat("a", 512*1024)
	execute(t, tx, `UPDATE users SET email=$2,avatar_url=$3 WHERE id=$1`, a, "same@example.test", large)
	execute(t, tx, `UPDATE users SET email=$2 WHERE id=$1`, b, "same@example.test")
	execute(t, tx, `UPDATE users SET name=NULL,email=$2 WHERE id=$1`, c, "ALPHA%_\\@example.test")
	execute(t, tx, `UPDATE users SET email=NULL,avatar_url=NULL WHERE id=$1`, d)
	execute(t, tx, `UPDATE users SET name=NULL,email=NULL,avatar_url=NULL WHERE id=$1`, e)
	reader := team.NewReader(tx)
	expected := []string{a, b, c}
	sort.Strings(expected)
	var ids []string
	var after *string
	for {
		page, err := reader.MemberCandidates(t.Context(), store.TeamMemberCandidateQuery{Query: "alpha%_\\", AfterID: after, Limit: 1})
		if err != nil || len(page.Items) != 1 {
			t.Fatalf("page %+v: %v", page, err)
		}
		item := page.Items[0]
		ids = append(ids, item.UserID)
		if item.UserID == a && (item.Profile.AvatarURL == nil || *item.Profile.AvatarURL != large) {
			t.Fatal("large avatar was truncated")
		}
		if item.UserID == c && (item.Profile.Name != nil || item.Profile.Email == nil) {
			t.Fatalf("nullable profile %+v", item.Profile)
		}
		if page.HasMore != (len(ids) < len(expected)) {
			t.Fatalf("incorrect lookahead %+v", page)
		}
		if !page.HasMore {
			break
		}
		after = &item.UserID
	}
	if !reflect.DeepEqual(ids, expected) {
		t.Fatalf("traversal %v want %v", ids, expected)
	}
	for _, query := range []string{"%", "_", "\\"} {
		page, err := reader.MemberCandidates(t.Context(), store.TeamMemberCandidateQuery{Query: query, Limit: 50})
		if err != nil || len(page.Items) != 3 || page.HasMore {
			t.Fatalf("literal %q %+v %v", query, page, err)
		}
	}
	page, err := reader.MemberCandidates(t.Context(), store.TeamMemberCandidateQuery{Query: "only", Limit: 20})
	if err != nil || len(page.Items) != 1 || page.Items[0].UserID != d || page.Items[0].Profile.Email != nil || page.Items[0].Profile.AvatarURL != nil {
		t.Fatalf("nullable projection %+v %v", page, err)
	}
	empty, err := reader.MemberCandidates(t.Context(), store.TeamMemberCandidateQuery{Query: "not-found", Limit: 20})
	if err != nil || empty.Items == nil || len(empty.Items) != 0 || empty.HasMore {
		t.Fatalf("empty %+v %v", empty, err)
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = reader.MemberCandidates(canceled, store.TeamMemberCandidateQuery{Query: "alpha", Limit: 20})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("lost cancellation %v", err)
	}
}

func TestMemberCandidatesCancelBlockedQueryReleasesConnection(t *testing.T) {
	db := testutil.OpenStore(t, postgres.Open)
	ctx, stop := context.WithTimeout(t.Context(), 10*time.Second)
	defer stop()
	blocker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err = blocker.Exec(ctx, `LOCK TABLE users IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- db.ReadSnapshot(readCtx, func(scope store.SnapshotScope) error {
			_, err := scope.TeamDAO().MemberCandidates(readCtx, store.TeamMemberCandidateQuery{Query: "alpha", Limit: 20})
			return err
		})
	}()
	testutil.WaitForQueryLock(t, db.Pool, "SELECT u.id::text,u.name,u.email,u.avatar_url FROM users u")
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("query did not exit after cancellation")
	}
	if err = blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for db.Pool.Stat().AcquiredConns() != 0 && ctx.Err() == nil {
		time.Sleep(10 * time.Millisecond)
	}
	if got := db.Pool.Stat().AcquiredConns(); got != 0 {
		t.Fatalf("retained %d connections", got)
	}
}
