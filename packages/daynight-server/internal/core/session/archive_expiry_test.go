package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type expiryScopeStub struct {
	store.ArchiveCleanupScope
	target    store.ArchiveCleanupTarget
	retention store.ArchiveRetentionDAO
	expire    func(context.Context, int64, time.Time) error
}

func (s expiryScopeStub) Target() store.ArchiveCleanupTarget      { return s.target }
func (s expiryScopeStub) RetentionDAO() store.ArchiveRetentionDAO { return s.retention }
func (s expiryScopeStub) ExpireArchive(c context.Context, v int64, at time.Time) error {
	return s.expire(c, v, at)
}

func TestExpireArchiveUsesRefreshedFacts(t *testing.T) {
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	deadline := base.Add(ArchiveRetentionPeriod)
	failure := errors.New("expiry write failure")
	for _, tc := range []struct {
		name   string
		now    time.Time
		status string
		fail   string
		want   bool
	}{
		{"before", deadline.Add(-time.Nanosecond), "done", "", false},
		{"at", deadline, "done", "", true},
		{"after", deadline.Add(time.Second), "done", "", true},
		{"reopened", deadline.Add(time.Second), "in_progress", "", false},
		{"new unfinished member", deadline.Add(time.Second), "todo", "", false},
		{"facts error", deadline, "done", "read", false},
		{"save error", deadline, "done", "save", false},
		{"expire error", deadline, "done", "expire", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			reads, saves, expires := 0, 0, 0
			target := store.ArchiveCleanupTarget{ProjectID: "project", TaskID: "task", SessionID: "session"}
			dao := retentionDAOStub{read: func(c context.Context, p, task, id string) (store.ArchiveRetentionFacts, error) {
				reads++
				if c != ctx || p != target.ProjectID || task != target.TaskID || id != target.SessionID {
					t.Fatal("wrong scope")
				}
				if tc.fail == "read" {
					return store.ArchiveRetentionFacts{}, failure
				}
				return store.ArchiveRetentionFacts{State: "ready", Archive: store.ArchiveRetention{SessionID: id, Version: 7, FirstSucceededAt: &base, ExpiresAt: &base}, Members: []store.ArchiveRetentionMember{{TaskID: task, Version: 19, Status: tc.status, CompletedAt: &base}}}, nil
			}, save: func(c context.Context, v int64, r store.ArchiveRetention) (store.ArchiveRetention, error) {
				saves++
				if c != ctx || v != 7 || r.Version != 7 || r.Members[0].Version != 19 {
					t.Fatal("lost observed facts")
				}
				if tc.status != "done" && r.ExpiresAt != nil {
					t.Fatal("cached deadline survived reopening")
				}
				if tc.fail == "save" {
					return store.ArchiveRetention{}, failure
				}
				r.Version = 8
				return r, nil
			}}
			scope := expiryScopeStub{target: target, retention: dao, expire: func(c context.Context, v int64, at time.Time) error {
				expires++
				if c != ctx || v != 8 || !at.Equal(tc.now) || at.Location() != time.UTC {
					t.Fatal("expiry did not use refreshed version and clock")
				}
				if tc.fail == "expire" {
					return failure
				}
				return nil
			}}
			got, err := ExpireArchive(ctx, scope, tc.now)
			if got != tc.want || (tc.fail != "" && !errors.Is(err, failure)) || (tc.fail == "" && err != nil) {
				t.Fatalf("expiry=%v %v", got, err)
			}
			wantSaves := 1
			if tc.fail == "read" {
				wantSaves = 0
			}
			wantExpires := 0
			if tc.want || tc.fail == "expire" {
				wantExpires = 1
			}
			if reads != 1 || saves != wantSaves || expires != wantExpires {
				t.Fatalf("calls %d/%d/%d", reads, saves, expires)
			}
		})
	}
}

func TestExpireArchiveDoesNotReviveOrRepeatFinishedCleanup(t *testing.T) {
	at := time.Now()
	for _, cleaned := range []bool{false, true} {
		target := store.ArchiveCleanupTarget{ExpiredAt: &at}
		if cleaned {
			target.CleanedAt = &at
		}
		got, err := ExpireArchive(t.Context(), expiryScopeStub{target: target}, at)
		if err != nil || got == cleaned {
			t.Fatalf("finished=%v expiry=%v %v", cleaned, got, err)
		}
	}
}
