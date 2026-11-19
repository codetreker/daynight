package assistanttask

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestResponsibleBotFollowsLiveClaimOrPendingTransfer(t *testing.T) {
	pending := baseTask()
	pending.ClaimTokenHash = nil
	expired := baseTask()
	expired.LeaseUntil = ptr(epoch)
	deleted := baseTask()
	deleted.HolderDeleted = true
	unowned := baseTask()
	unowned.HolderBotID, unowned.LeaseUntil = nil, nil
	for _, tc := range []struct {
		name string
		task model.AssistantTask
		want string
	}{
		{"active", baseTask(), botID},
		{"pending transfer", pending, botID},
		{"expired lease", expired, ""},
		{"deleted holder", deleted, ""},
		{"unowned", unowned, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ResponsibleBot(tc.task, epoch)
			if got != tc.want || ok != (tc.want != "") {
				t.Fatalf("got %q %v", got, ok)
			}
		})
	}
}

func TestInboxTargetMatchesOnlyThisInboxPath(t *testing.T) {
	const inbox = "77777777-7777-4777-8777-777777777777"
	const origin = "https://daynight.example"
	doc := func(kind, url string) []byte {
		return []byte(`{"kind":"` + kind + `","adapterVersion":"1","configuration":{"url":"` + url + `"}}`)
	}
	for _, tc := range []struct {
		name   string
		config []byte
		want   bool
	}{
		{"exact", doc("http", origin+InboxPathPrefix+inbox), true},
		{"query ignored", doc("http", origin+InboxPathPrefix+inbox+"?source=daynight"), true},
		{"host case", doc("http", "https://DAYNIGHT.example"+InboxPathPrefix+inbox), true},
		{"other inbox", doc("http", origin+InboxPathPrefix+"88888888-8888-4888-8888-888888888888"), false},
		{"trailing slash", doc("http", origin+InboxPathPrefix+inbox+"/"), false},
		{"other origin", doc("http", "https://attacker.example"+InboxPathPrefix+inbox), false},
		{"explicit default port", doc("http", origin+":443"+InboxPathPrefix+inbox), true},
		{"explicit default port with leading zeros", doc("http", "https://Daynight.EXAMPLE:00443"+InboxPathPrefix+inbox), true},
		{"empty port", doc("http", origin+":"+InboxPathPrefix+inbox), true},
		{"explicit default port other path", doc("http", origin+":443"+InboxPathPrefix+inbox+"/"), false},
		{"other port", doc("http", origin+":8443"+InboxPathPrefix+inbox), false},
		{"other scheme default port", doc("http", "http://daynight.example:443"+InboxPathPrefix+inbox), false},
		{"port out of range", doc("http", origin+":70000"+InboxPathPrefix+inbox), false},
		{"user info", doc("http", "https://user@daynight.example"+InboxPathPrefix+inbox), false},
		{"other kind", doc("slack", origin+InboxPathPrefix+inbox), false},
		{"unparsable url", doc("http", "https://daynight.example/%zz"), false},
		{"invalid json", []byte("{"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := InboxTargetMatches(tc.config, origin, inbox); got != tc.want {
				t.Fatalf("got %v", got)
			}
		})
	}
	// A server origin with a non-default port matches only that port.
	const ported = "https://daynight.example:8443"
	for url, want := range map[string]bool{
		ported + InboxPathPrefix + inbox:                           true,
		"https://daynight.example:08443" + InboxPathPrefix + inbox: true,
		origin + InboxPathPrefix + inbox:                           false,
		origin + ":443" + InboxPathPrefix + inbox:                  false,
	} {
		if got := InboxTargetMatches(doc("http", url), ported, inbox); got != want {
			t.Fatalf("%s against %s: got %v", url, ported, got)
		}
	}
	for _, bad := range []string{"%zz", "/relative"} {
		if InboxTargetMatches(doc("http", origin+InboxPathPrefix+inbox), bad, inbox) {
			t.Fatalf("matched invalid origin %q", bad)
		}
	}
}

func TestReclaimInboundStopsAtFirstFailure(t *testing.T) {
	d := baseDAO(t, baseTask())
	d.reclaimReceipts = func(context.Context, string, string, int) (int64, error) { return 0, sentinel }
	if err := ReclaimInbound(context.Background(), d, ownerID, taskID, epoch); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	d = baseDAO(t, baseTask())
	d.reclaimEvents = func(context.Context, string, string, time.Time, int) (int64, error) { return 0, sentinel }
	if err := ReclaimInbound(context.Background(), d, ownerID, taskID, epoch); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
}

func TestTaskEventPullReclaimsUnderTaskLock(t *testing.T) {
	m := New()
	for _, failure := range []string{"", "lock", "now", "reclaim"} {
		t.Run("failure="+failure, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			var steps []string
			task := d.task
			d.task = func(ctx context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
				if lock {
					steps = append(steps, "lock")
					if failure == "lock" {
						return model.AssistantTask{}, sentinel
					}
				}
				return task(ctx, owner, id, lock)
			}
			now := d.now
			d.now = func(ctx context.Context) (time.Time, error) {
				if failure == "now" && len(steps) == 1 {
					return time.Time{}, sentinel
				}
				return now(ctx)
			}
			d.reclaimReceipts = func(context.Context, string, string, int) (int64, error) {
				steps = append(steps, "reclaim")
				if failure == "reclaim" {
					return 0, sentinel
				}
				return 1, nil
			}
			d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) { return nil, nil }
			d.events = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskEvent, error) { return nil, nil }
			_, err := m.ListEvents(context.Background(), d, userActor(), taskID, PageInput{})
			if failure != "" {
				if !errors.Is(err, sentinel) {
					t.Fatal(err)
				}
				return
			}
			if err != nil || len(steps) != 2 || steps[0] != "lock" || steps[1] != "reclaim" {
				t.Fatalf("steps=%v err=%v", steps, err)
			}
		})
	}
}

func TestCrossTaskEventPullReclaimsIdleInboxes(t *testing.T) {
	m := New()
	for _, failure := range []string{"", "list", "lock", "reclaim", "deleted"} {
		t.Run("failure="+failure, func(t *testing.T) {
			task := baseTask()
			if failure == "deleted" {
				task.State = "deleted"
			}
			d := baseDAO(t, task)
			var steps []string
			list := d.reclaimTasks
			d.reclaimTasks = func(ctx context.Context, owner string, before time.Time, limit int) ([]string, error) {
				steps = append(steps, "list")
				if _, err := list(ctx, owner, before, limit); err != nil {
					t.Fatal(err)
				}
				if failure == "list" {
					return nil, sentinel
				}
				return []string{taskID}, nil
			}
			load := d.task
			d.task = func(ctx context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
				if !lock {
					t.Fatal("reclamation must lock its task")
				}
				steps = append(steps, "lock")
				if failure == "lock" {
					return model.AssistantTask{}, sentinel
				}
				return load(ctx, owner, id, lock)
			}
			reclaim := d.reclaimReceipts
			d.reclaimReceipts = func(ctx context.Context, owner, id string, limit int) (int64, error) {
				steps = append(steps, "reclaim")
				if _, err := reclaim(ctx, owner, id, limit); err != nil {
					t.Fatal(err)
				}
				if failure == "reclaim" {
					return 0, sentinel
				}
				return 1, nil
			}
			d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) { return nil, nil }
			d.events = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskEvent, error) { return nil, nil }
			_, err := m.ListEvents(context.Background(), d, userActor(), "", PageInput{})
			want := []string{"list", "lock", "reclaim"}
			switch failure {
			case "list":
				want = want[:1]
			case "lock", "deleted":
				want = want[:2]
			}
			if failure != "" && failure != "deleted" {
				if !errors.Is(err, sentinel) {
					t.Fatal(err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if len(steps) != len(want) {
				t.Fatalf("steps=%v want=%v", steps, want)
			}
			for i := range want {
				if steps[i] != want[i] {
					t.Fatalf("steps=%v want=%v", steps, want)
				}
			}
		})
	}
}

type wakeStub struct {
	store.AssistantTaskDAO
	woke                bool
	err                 error
	calls               int
	bot, subject, owner string
	since               time.Time
}

func (s *wakeStub) ReceivedInbound(_ context.Context, owner, bot, subject string, since time.Time) (bool, error) {
	s.calls++
	s.owner, s.bot, s.subject, s.since = owner, bot, subject, since
	return s.woke, s.err
}

func TestSuppressInboundOnlyForOwnerBotLoops(t *testing.T) {
	const peer, subject = "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"
	bot := func(user, id string) *InboundActor {
		return &InboundActor{Kind: InboundActorBot, UserID: ptr(user), BotID: ptr(id)}
	}
	for _, tc := range []struct {
		name        string
		actor       *InboundActor
		woke        bool
		want, query bool
	}{
		{"unknown", nil, true, false, false},
		{"user", &InboundActor{Kind: InboundActorUser, UserID: ptr(ownerID)}, true, false, false},
		{"system", &InboundActor{Kind: InboundActorSystem}, true, false, false},
		{"bot without id", &InboundActor{Kind: InboundActorBot, UserID: ptr(ownerID)}, true, false, false},
		{"bot without user", &InboundActor{Kind: InboundActorBot, BotID: ptr(botID)}, true, false, false},
		{"other user's bot", bot("33333333-3333-4333-8333-333333333333", peer), true, false, false},
		{"holder", bot(ownerID, botID), false, true, false},
		{"reacting peer", bot(ownerID, peer), true, true, true},
		{"quiet peer", bot(ownerID, peer), false, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &wakeStub{woke: tc.woke}
			got, err := SuppressInbound(context.Background(), d, ownerID, botID, subject, tc.actor, epoch)
			if err != nil || got != tc.want || (d.calls == 1) != tc.query {
				t.Fatalf("got %v err %v calls %d", got, err, d.calls)
			}
			if tc.query && (d.owner != ownerID || d.bot != peer || d.subject != subject || !d.since.Equal(epoch.Add(-10*time.Minute))) {
				t.Fatalf("query %+v", d)
			}
		})
	}
	d := &wakeStub{err: sentinel}
	if _, err := SuppressInbound(context.Background(), d, ownerID, botID, subject, bot(ownerID, peer), epoch); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
}
