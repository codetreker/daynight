package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestArchiveRetentionRules(t *testing.T) {
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	later := base.Add(48 * time.Hour)
	grace := base.Add(10 * 24 * time.Hour)
	done := store.ArchiveRetentionMember{TaskID: "task", Version: 2, Status: "done", CompletedAt: &base}
	cancelled := store.ArchiveRetentionMember{TaskID: "cancelled", Version: 3, Status: "cancelled", CancelledAt: &later}
	for _, tc := range []struct {
		name         string
		state        string
		first, grace *time.Time
		members      []store.ArchiveRetentionMember
		reason       string
		deadline     *time.Time
	}{
		{"independent", "ready", &base, nil, []store.ArchiveRetentionMember{done}, "scheduled", retentionTime(base.Add(7 * 24 * time.Hour))},
		{"cancelled chain", "ready", &base, nil, []store.ArchiveRetentionMember{done, cancelled}, "scheduled", retentionTime(later.Add(7 * 24 * time.Hour))},
		{"late archive", "ready", &later, nil, []store.ArchiveRetentionMember{done}, "scheduled", retentionTime(later.Add(7 * 24 * time.Hour))},
		{"reopened chain", "ready", &base, nil, []store.ArchiveRetentionMember{done, {TaskID: "other", Version: 4, Status: "todo", CompletedAt: &later}}, "chain_unfinished", nil},
		{"unknown terminal", "ready", &base, nil, []store.ArchiveRetentionMember{{TaskID: "task", Version: 2, Status: "done"}}, "terminal_time_unknown", nil},
		{"unknown cancelled", "ready", &base, nil, []store.ArchiveRetentionMember{{TaskID: "task", Version: 2, Status: "cancelled", CompletedAt: &base}}, "terminal_time_unknown", nil},
		{"unknown success", "ready", nil, nil, []store.ArchiveRetentionMember{done}, "archive_time_unknown", nil},
		{"legacy grace", "ready", nil, &grace, []store.ArchiveRetentionMember{done}, "legacy_grace", &grace},
		{"legacy recent terminal", "ready", nil, retentionTime(base), []store.ArchiveRetentionMember{cancelled}, "legacy_grace", retentionTime(later.Add(7 * 24 * time.Hour))},
		{"new archive with grace", "ready", &base, &grace, []store.ArchiveRetentionMember{done}, "scheduled", &grace},
		{"pending", "pending", &base, nil, nil, "archive_unavailable", nil},
		{"failed", "failed", &base, nil, nil, "archive_unavailable", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			facts := store.ArchiveRetentionFacts{State: tc.state, Members: tc.members, Archive: store.ArchiveRetention{SessionID: "session", Version: 5, FirstSucceededAt: tc.first, GraceUntil: tc.grace, ExpiresAt: &base}}
			got, err := CalculateArchiveRetention(facts)
			if err != nil || got.Reason != tc.reason || !reflect.DeepEqual(got.ExpiresAt, tc.deadline) || got.FirstSucceededAt != tc.first || got.GraceUntil != tc.grace || got.Version != 5 || !reflect.DeepEqual(got.Members, tc.members) {
				t.Fatalf("retention: %+v, %v; want %s, %v", got, err, tc.reason, tc.deadline)
			}
		})
	}
	for _, member := range []store.ArchiveRetentionMember{{TaskID: "task", Version: 1, Status: "invalid"}, {TaskID: "task", Status: "done"}, {Version: 1, Status: "done"}} {
		if _, err := CalculateArchiveRetention(store.ArchiveRetentionFacts{State: "ready", Members: []store.ArchiveRetentionMember{member}}); err == nil {
			t.Fatal("accepted invalid persisted member")
		}
	}
	if _, err := CalculateArchiveRetention(store.ArchiveRetentionFacts{State: "ready"}); err == nil {
		t.Fatal("accepted absent chain")
	}
	expired := store.ArchiveRetention{SessionID: "session", Version: 3, ExpiredAt: &base, ExpiresAt: &base, Reason: "expired"}
	if got, err := CalculateArchiveRetention(store.ArchiveRetentionFacts{State: "ready", Archive: expired}); err != nil || !reflect.DeepEqual(got, expired) {
		t.Fatalf("revived expired archive: %+v %v", got, err)
	}
}

type archiveSuccessDAO struct {
	*archiveNativeAdoptionDAO
	record func(context.Context, string, time.Time) error
}

func (d *archiveSuccessDAO) RecordSessionArchiveSuccess(ctx context.Context, id string, at time.Time) error {
	return d.record(ctx, id, at)
}

func TestArchivePublicationRecordsSuccessInOriginalScope(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success and retry", true: "record failure"}[fail], func(t *testing.T) {
			op, base, r, manifest := unifiedArchiveNativeAdoptionFixture(t)
			clock := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
			op.execution.now = func() time.Time { return clock }
			failure := errors.New("success recording failed")
			var scopes []int
			d := &archiveSuccessDAO{archiveNativeAdoptionDAO: base, record: func(ctx context.Context, id string, at time.Time) error {
				if id != op.id || !at.Equal(clock) || base.currentScope == 0 || len(base.readyScopes) == 0 || base.readyScopes[len(base.readyScopes)-1] != base.currentScope {
					t.Fatal("first success escaped publication transaction")
				}
				scopes = append(scopes, base.currentScope)
				if fail {
					return failure
				}
				return nil
			}}
			op.execution.archiveRun = func(ctx context.Context, p model.Principal, project, task, id string, finalize bool, work func(*Access) error) error {
				if p != op.principal || project != op.project || task != op.task || id != op.id || !finalize {
					t.Fatal("wrong archive scope")
				}
				base.scope++
				base.currentScope = base.scope
				defer func() { base.currentScope = 0 }()
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			for attempt := range 2 {
				out, err := op.PutArchiveManifest(t.Context(), encode(manifest))
				if fail {
					if !errors.Is(err, failure) || out.State == "ready" || len(base.commitScopes) != 0 || len(scopes) != 1 {
						t.Fatalf("publication continued: %+v %v", out, err)
					}
					return
				}
				if err != nil || out.State != "ready" || len(scopes) != attempt+1 || base.commitScopes[attempt] != scopes[attempt] {
					t.Fatalf("publication scope mismatch: %+v %v", out, err)
				}
				clock = clock.Add(24 * time.Hour)
			}
		})
	}
}

func retentionTime(v time.Time) *time.Time { return &v }

type retentionDAOStub struct {
	read func(context.Context, string, string, string) (store.ArchiveRetentionFacts, error)
	save func(context.Context, int64, store.ArchiveRetention) (store.ArchiveRetention, error)
}

func (d retentionDAOStub) ArchiveRetentionFacts(ctx context.Context, p, t, s string) (store.ArchiveRetentionFacts, error) {
	return d.read(ctx, p, t, s)
}
func (d retentionDAOStub) SaveArchiveRetention(ctx context.Context, v int64, r store.ArchiveRetention) (store.ArchiveRetention, error) {
	return d.save(ctx, v, r)
}

func TestRefreshArchiveRetentionPreservesScopeVersionAndErrors(t *testing.T) {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	failure := errors.New("storage failed")
	for _, stage := range []string{"success", "read", "save", "invalid", "expired"} {
		t.Run(stage, func(t *testing.T) {
			ctx := t.Context()
			reads, saves := 0, 0
			dao := retentionDAOStub{read: func(c context.Context, p, task, id string) (store.ArchiveRetentionFacts, error) {
				reads++
				if c != ctx || p != "project" || task != "task" || id != "session" {
					t.Fatal("wrong retention scope")
				}
				if stage == "read" {
					return store.ArchiveRetentionFacts{}, failure
				}
				f := store.ArchiveRetentionFacts{State: "ready", Archive: store.ArchiveRetention{SessionID: id, Version: 7, FirstSucceededAt: &now}, Members: []store.ArchiveRetentionMember{{TaskID: task, Version: 2, Status: "done", CompletedAt: &now}}}
				if stage == "invalid" {
					f.Members = nil
				}
				if stage == "expired" {
					f.Archive.ExpiredAt = &now
				}
				return f, nil
			}, save: func(c context.Context, v int64, r store.ArchiveRetention) (store.ArchiveRetention, error) {
				saves++
				if c != ctx || v != 7 || r.Version != 7 || r.SessionID != "session" || r.ExpiresAt == nil || !r.ExpiresAt.Equal(now.Add(ArchiveRetentionPeriod)) || r.Members[0].Version != 2 {
					t.Fatalf("wrong save candidate: %+v", r)
				}
				if stage == "save" {
					return store.ArchiveRetention{}, failure
				}
				r.Version = 8
				return r, nil
			}}
			got, err := RefreshArchiveRetention(ctx, dao, "project", "task", "session")
			if reads != 1 {
				t.Fatal("read count", reads)
			}
			if stage == "success" {
				if err != nil || got.Version != 8 || saves != 1 {
					t.Fatalf("result %+v %v saves=%d", got, err, saves)
				}
				return
			}
			if stage == "expired" {
				if err != nil || saves != 0 || got.ExpiredAt == nil {
					t.Fatal("expired archive changed")
				}
				return
			}
			if err == nil {
				t.Fatal("lost failure")
			}
			if stage != "invalid" && !errors.Is(err, failure) {
				t.Fatal("lost cause", err)
			}
			if stage != "save" && saves != 0 {
				t.Fatal("saved failed calculation")
			}
		})
	}
}
