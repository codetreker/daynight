package store

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"testing"
	"time"
)

func TestBotLockedReadObservesCompleteConcurrentBinding(t *testing.T) {
	db := isolatedStore(t)
	bot := runtimeStoredBot(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	writer, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if _, err = ReadBotForUpdate(ctx, writer, bot.ID); err != nil {
		t.Fatal(err)
	}
	sid, eid := uuid.NewString(), uuid.NewString()
	if err = insertBotSession(ctx, writer, bot, sid, eid); err != nil {
		t.Fatal(err)
	}
	if _, err = BindBotSession(ctx, writer, bot.ID, 1, sid, core.BotRoleConfiguration{Instructions: "role", Revision: "1", Digest: "digest"}); err != nil {
		t.Fatal(err)
	}
	reader, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Rollback(context.Background())
	var pid int
	if err = reader.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		t.Fatal(err)
	}
	type result struct {
		bot core.Bot
		err error
	}
	done := make(chan result, 1)
	go func() { b, e := ReadBotForUpdate(ctx, reader, bot.ID); done <- result{b, e} }()
	for {
		var waiting bool
		if err = db.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')", pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	if err = writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil {
		t.Fatal(got.err)
	}
	if got.bot.Version != 2 || got.bot.SessionID == nil || *got.bot.SessionID != sid || got.bot.TestExecutionID == nil || *got.bot.TestExecutionID != eid {
		t.Fatalf("waiting reader returned an incomplete binding: %+v", got.bot)
	}
}
