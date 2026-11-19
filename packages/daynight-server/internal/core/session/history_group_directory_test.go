package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const directoryProject = "11111111-1111-4111-8111-111111111111"
const directoryTask = "22222222-2222-4222-8222-222222222222"
const directoryOther = "33333333-3333-4333-8333-333333333333"

type directoryRuleDAO struct {
	t         *testing.T
	fence     func(context.Context, string) (string, error)
	groups    func(context.Context, string, *store.HistoryGroupPosition, int) ([]store.HistoryDirectoryGroup, error)
	members   func(context.Context, string, string, string, int) ([]store.HistoryDirectoryMember, error)
	sessions  func(context.Context, string, string, *store.Position, int) ([]store.HistoryDirectorySession, error)
	retention func(context.Context, string, string) ([]store.ArchiveRetentionMember, error)
}

func (d directoryRuleDAO) Fence(c context.Context, p string) (string, error) {
	if d.fence == nil {
		d.t.Fatal("unexpected fence read")
	}
	return d.fence(c, p)
}
func (d directoryRuleDAO) Groups(c context.Context, p string, a *store.HistoryGroupPosition, n int) ([]store.HistoryDirectoryGroup, error) {
	if d.groups == nil {
		d.t.Fatal("unexpected groups read")
	}
	return d.groups(c, p, a, n)
}
func (d directoryRuleDAO) Members(c context.Context, p, g, a string, n int) ([]store.HistoryDirectoryMember, error) {
	if d.members == nil {
		d.t.Fatal("unexpected members read")
	}
	return d.members(c, p, g, a, n)
}
func (d directoryRuleDAO) Sessions(c context.Context, p, id string, a *store.Position, n int) ([]store.HistoryDirectorySession, error) {
	if d.sessions == nil {
		d.t.Fatal("unexpected sessions read")
	}
	return d.sessions(c, p, id, a, n)
}
func (d directoryRuleDAO) RetentionMembers(c context.Context, p, id string) ([]store.ArchiveRetentionMember, error) {
	if d.retention == nil {
		d.t.Fatal("unexpected retention read")
	}
	return d.retention(c, p, id)
}

type directoryRuleScope struct {
	store.HistoryDirectoryScope
	dao      store.HistoryDirectoryDAO
	task     store.TaskReader
	observed func(context.Context) (time.Time, error)
}

func (s directoryRuleScope) HistoryDirectoryDAO() store.HistoryDirectoryDAO  { return s.dao }
func (s directoryRuleScope) TaskDAO() store.TaskReader                       { return s.task }
func (s directoryRuleScope) ObservedAt(c context.Context) (time.Time, error) { return s.observed(c) }

type directoryTaskReader struct {
	store.TaskReader
	read func(context.Context, string, string) (model.Task, error)
}

func (r directoryTaskReader) Task(c context.Context, p, id string) (model.Task, error) {
	return r.read(c, p, id)
}

func directoryFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("error %v, want %s", err, code)
	}
}
func directoryToken(c historyDirectoryCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func TestHistoryDirectoryRejectsInvalidRequestsAndForeignCursorsBeforeReading(t *testing.T) {
	valid := HistoryDirectoryRequest{Kind: "groups", Limit: 1}
	for _, q := range []HistoryDirectoryRequest{{Kind: "other", Limit: 1}, {Kind: "groups", Limit: 0}, {Kind: "groups", Limit: 201}, {Kind: "groups", Target: directoryTask, Limit: 1}, {Kind: "members", Target: "bad", Limit: 1}, {Kind: "sessions", Target: directoryTask, Limit: 1, Cursor: strings.Repeat("a", 4097)}} {
		if _, err := ReadHistoryDirectory(t.Context(), nil, directoryProject, "actor", q); err == nil {
			t.Fatalf("accepted %#v", q)
		}
	}
	if _, err := ReadHistoryDirectory(t.Context(), nil, "bad", "actor", valid); err == nil {
		t.Fatal("invalid Project accepted")
	}
	base := historyDirectoryCursor{Version: 1, Project: directoryProject, User: "actor", Kind: "groups", Fence: "1", ID: directoryTask}
	for _, mutate := range []func(*historyDirectoryCursor){func(c *historyDirectoryCursor) { c.Version = 2 }, func(c *historyDirectoryCursor) { c.Project = directoryOther }, func(c *historyDirectoryCursor) { c.User = "other" }, func(c *historyDirectoryCursor) { c.Kind = "members" }, func(c *historyDirectoryCursor) { c.Target = directoryTask }, func(c *historyDirectoryCursor) { c.Fence = "" }, func(c *historyDirectoryCursor) { c.ID = "bad" }} {
		c := base
		mutate(&c)
		q := valid
		q.Cursor = directoryToken(c)
		_, err := ReadHistoryDirectory(t.Context(), nil, directoryProject, "actor", q)
		directoryFault(t, err, "invalid_cursor")
	}
	for _, token := range []string{"!", base64.RawURLEncoding.EncodeToString([]byte("{"))} {
		q := valid
		q.Cursor = token
		_, err := ReadHistoryDirectory(t.Context(), nil, directoryProject, "actor", q)
		directoryFault(t, err, "invalid_cursor")
	}
	base.Kind, base.Target = "sessions", directoryTask
	_, err := ReadHistoryDirectory(t.Context(), nil, directoryProject, "actor", HistoryDirectoryRequest{Kind: "sessions", Target: directoryTask, Limit: 1, Cursor: directoryToken(base)})
	directoryFault(t, err, "invalid_cursor")
}

func TestHistoryDirectoryGroupsPreserveOrderAndResetChangedSnapshot(t *testing.T) {
	at := time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)
	calls := 0
	fence := "1"
	dao := directoryRuleDAO{t: t, fence: func(c context.Context, p string) (string, error) {
		if c != t.Context() || p != directoryProject {
			t.Fatal("fence identity/context")
		}
		return fence, nil
	}}
	dao.groups = func(c context.Context, p string, a *store.HistoryGroupPosition, n int) ([]store.HistoryDirectoryGroup, error) {
		calls++
		if c != t.Context() || p != directoryProject || n != 2 {
			t.Fatal("group query inputs")
		}
		if calls == 1 {
			if a != nil {
				t.Fatal("first-page position")
			}
			return []store.HistoryDirectoryGroup{{ID: directoryTask, MemberCount: 2, EndedAt: &at, TimeState: "ended"}, {ID: directoryOther, MemberCount: 1, TimeState: "unknown"}}, nil
		}
		if a == nil || a.ID != directoryTask || a.EndedAt == nil || !a.EndedAt.Equal(at) {
			t.Fatalf("position %#v", a)
		}
		return []store.HistoryDirectoryGroup{{ID: directoryOther, MemberCount: 1, TimeState: "unknown"}}, nil
	}
	scope := directoryRuleScope{dao: dao, observed: func(c context.Context) (time.Time, error) { return at, nil }}
	q := HistoryDirectoryRequest{Kind: "groups", Limit: 1}
	first, err := ReadHistoryDirectory(t.Context(), scope, directoryProject, "actor", q)
	if err != nil || first.NextCursor == nil || !first.ObservedAt.Equal(at) {
		t.Fatalf("first %#v %v", first, err)
	}
	items := first.Items.([]HistoryDirectoryGroup)
	if len(items) != 1 || items[0].ID != directoryTask || items[0].Kind != "chain" {
		t.Fatalf("first items %#v", items)
	}
	q.Cursor = *first.NextCursor
	second, err := ReadHistoryDirectory(t.Context(), scope, directoryProject, "actor", q)
	if err != nil || second.NextCursor != nil {
		t.Fatalf("second %#v %v", second, err)
	}
	items = second.Items.([]HistoryDirectoryGroup)
	if len(items) != 1 || items[0].ID != directoryOther || items[0].Kind != "task" || items[0].EndedAt != nil || items[0].TimeState != "unknown" {
		t.Fatalf("second items %#v", items)
	}
	fence = "2"
	_, err = ReadHistoryDirectory(t.Context(), scope, directoryProject, "actor", q)
	directoryFault(t, err, "reset_required")
	if calls != 2 {
		t.Fatal("changed graph queried a page")
	}
}

func TestHistoryDirectoryMembersPreserveTerminalTimeKnowledge(t *testing.T) {
	at := time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		status               string
		completed, cancelled *time.Time
		state                string
		at                   *time.Time
	}{{"done", &at, nil, "ended", &at}, {"cancelled", nil, &at, "ended", &at}, {"done", nil, &at, "unknown", nil}, {"cancelled", &at, nil, "unknown", nil}, {"in_progress", &at, &at, "unfinished", nil}} {
		got, state := historyMemberTime(store.ArchiveRetentionMember{Status: test.status, CompletedAt: test.completed, CancelledAt: test.cancelled})
		if state != test.state || !reflect.DeepEqual(got, test.at) {
			t.Fatalf("%s: %v %s", test.status, got, state)
		}
	}
	calls := 0
	dao := directoryRuleDAO{t: t, fence: func(context.Context, string) (string, error) { return "1", nil }, members: func(c context.Context, p, g, after string, n int) ([]store.HistoryDirectoryMember, error) {
		calls++
		if c != t.Context() || p != directoryProject || g != directoryTask || n != 2 {
			t.Fatal("member inputs")
		}
		if calls == 1 {
			if after != "" {
				t.Fatal("first member position")
			}
			return []store.HistoryDirectoryMember{{ArchiveRetentionMember: store.ArchiveRetentionMember{TaskID: directoryTask, Status: "done", CompletedAt: &at}, Title: "first"}, {ArchiveRetentionMember: store.ArchiveRetentionMember{TaskID: directoryOther, Status: "todo"}, Title: "second"}}, nil
		}
		if after != directoryTask {
			t.Fatal("member continuation position")
		}
		return []store.HistoryDirectoryMember{}, nil
	}}
	scope := directoryRuleScope{dao: dao, observed: func(context.Context) (time.Time, error) { return at, nil }}
	q := HistoryDirectoryRequest{Kind: "members", Target: directoryTask, Limit: 1}
	first, err := ReadHistoryDirectory(t.Context(), scope, directoryProject, "actor", q)
	if err != nil || first.NextCursor == nil {
		t.Fatalf("first %#v %v", first, err)
	}
	items := first.Items.([]HistoryDirectoryMember)
	if len(items) != 1 || items[0].Title != "first" || items[0].TaskID != directoryTask || items[0].TimeState != "ended" {
		t.Fatalf("members %#v", items)
	}
	q.Cursor = *first.NextCursor
	last, err := ReadHistoryDirectory(t.Context(), scope, directoryProject, "actor", q)
	if err != nil || last.NextCursor != nil || len(last.Items.([]HistoryDirectoryMember)) != 0 {
		t.Fatalf("last %#v %v", last, err)
	}
}

func TestHistoryDirectorySessionPageNeverRebindsOldClaim(t *testing.T) {
	at := time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)
	state := "ready"
	oldClaim := "old-claim"
	newClaim := directoryProject
	old := store.HistoryDirectorySession{TerminalHistoryRow: store.TerminalHistoryRow{ID: directoryOther, Claim: oldClaim, Backend: "web", Created: at, Snapshot: []byte(`{"executionGeneration":"7"}`), State: &state}, Retention: &store.ArchiveRetention{FirstSucceededAt: &at}}
	current := old
	current.ID = directoryTask
	current.Claim = newClaim
	current.Created = at.Add(time.Second)
	calls := 0
	dao := directoryRuleDAO{t: t, fence: func(context.Context, string) (string, error) { return "1", nil }, retention: func(c context.Context, p, id string) ([]store.ArchiveRetentionMember, error) {
		if c != t.Context() || p != directoryProject || id != directoryTask {
			t.Fatal("retention inputs")
		}
		return []store.ArchiveRetentionMember{{TaskID: directoryTask, Version: 1, Status: "done", CompletedAt: &at}}, nil
	}}
	dao.sessions = func(c context.Context, p, id string, after *store.Position, n int) ([]store.HistoryDirectorySession, error) {
		calls++
		if c != t.Context() || p != directoryProject || id != directoryTask || n != 2 {
			t.Fatal("session inputs")
		}
		if calls == 1 {
			if after != nil {
				t.Fatal("first session position")
			}
			return []store.HistoryDirectorySession{current, old}, nil
		}
		if after == nil || after.ID != current.ID || !after.CreatedAt.Equal(current.Created) {
			t.Fatalf("session position %#v", after)
		}
		return []store.HistoryDirectorySession{old}, nil
	}
	scope := directoryRuleScope{dao: dao, observed: func(context.Context) (time.Time, error) { return at, nil }, task: directoryTaskReader{read: func(c context.Context, p, id string) (model.Task, error) {
		if c != t.Context() || p != directoryProject || id != directoryTask {
			t.Fatal("task inputs")
		}
		return model.Task{Type: model.TaskTypeTask, Properties: model.TaskProperties{"worker": json.RawMessage(`{"claimId":"11111111-1111-4111-8111-111111111111","state":"active","userId":"22222222-2222-4222-8222-222222222222","workerId":"33333333-3333-4333-8333-333333333333","machine":{"id":"33333333-3333-4333-8333-333333333333","name":"test"},"platform":"linux","agent":"codex","agentControlMode":"web","worktreeId":"33333333-3333-4333-8333-333333333333","phase":"executing","nativeSessionId":null,"claimedAt":"2026-11-19T00:00:00Z"}`)}}, nil
	}}}
	q := HistoryDirectoryRequest{Kind: "sessions", Target: directoryTask, Limit: 1}
	first, err := ReadHistoryDirectory(t.Context(), scope, directoryProject, "actor", q)
	if err != nil || first.NextCursor == nil {
		t.Fatalf("first %#v %v", first, err)
	}
	if !first.Items.([]HistoryDirectorySession)[0].CurrentBinding {
		t.Fatal("current binding absent")
	}
	q.Cursor = *first.NextCursor
	last, err := ReadHistoryDirectory(t.Context(), scope, directoryProject, "actor", q)
	if err != nil {
		t.Fatal(err)
	}
	item := last.Items.([]HistoryDirectorySession)[0]
	if item.SessionID != old.ID || item.ClaimID != oldClaim || item.CurrentBinding || item.ExecutionGeneration != "7" || last.NextCursor != nil {
		t.Fatalf("old claim changed %#v", item)
	}
}

func TestHistoryDirectoryStopsAtFailedRead(t *testing.T) {
	cause := errors.New("read failed")
	for _, stage := range []string{"fence", "observed", "groups", "members", "task", "goal", "retention", "sessions", "projection"} {
		t.Run(stage, func(t *testing.T) {
			dao := directoryRuleDAO{t: t, fence: func(context.Context, string) (string, error) {
				if stage == "fence" {
					return "", cause
				}
				return "1", nil
			}}
			scope := directoryRuleScope{dao: dao, observed: func(context.Context) (time.Time, error) {
				if stage == "observed" {
					return time.Time{}, cause
				}
				return time.Now(), nil
			}}
			q := HistoryDirectoryRequest{Kind: "groups", Limit: 1}
			if stage == "groups" {
				dao.groups = func(context.Context, string, *store.HistoryGroupPosition, int) ([]store.HistoryDirectoryGroup, error) {
					return nil, cause
				}
			}
			if stage == "members" {
				q.Kind, q.Target = "members", directoryTask
				dao.members = func(context.Context, string, string, string, int) ([]store.HistoryDirectoryMember, error) {
					return nil, cause
				}
			}
			if stage == "task" || stage == "goal" || stage == "retention" || stage == "sessions" || stage == "projection" {
				q.Kind, q.Target = "sessions", directoryTask
				scope.task = directoryTaskReader{read: func(context.Context, string, string) (model.Task, error) {
					if stage == "task" {
						return model.Task{}, cause
					}
					if stage == "goal" {
						return model.Task{Type: model.TaskTypeGoal}, nil
					}
					return model.Task{Type: model.TaskTypeTask}, nil
				}}
				dao.retention = func(context.Context, string, string) ([]store.ArchiveRetentionMember, error) {
					if stage == "retention" {
						return nil, cause
					}
					return nil, nil
				}
				dao.sessions = func(context.Context, string, string, *store.Position, int) ([]store.HistoryDirectorySession, error) {
					if stage == "sessions" {
						return nil, cause
					}
					return []store.HistoryDirectorySession{{TerminalHistoryRow: store.TerminalHistoryRow{Backend: "web", Snapshot: []byte("{")}}}, nil
				}
			}
			scope.dao = dao
			_, err := ReadHistoryDirectory(t.Context(), scope, directoryProject, "actor", q)
			if stage == "goal" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal(err)
				}
			} else if stage == "projection" {
				if err == nil {
					t.Fatal("invalid snapshot accepted")
				}
			} else if !errors.Is(err, cause) {
				t.Fatalf("lost cause %v", err)
			}
		})
	}
}

func TestHistoryDirectoryArchiveStatesAndCurrentRetentionFacts(t *testing.T) {
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	late := at.Add(24 * time.Hour)
	grace := late.Add(ArchiveRetentionPeriod)
	stale := at.Add(-ArchiveRetentionPeriod)
	ready, partial, failed := "ready", "partial", "failed"
	members := []store.ArchiveRetentionMember{{TaskID: directoryTask, Version: 1, Status: "done", CompletedAt: &at}, {TaskID: directoryOther, Version: 2, Status: "cancelled", CancelledAt: &late}}
	for _, test := range []struct {
		name, archive, retention, reason string
		change                           func(*store.HistoryDirectorySession, []store.ArchiveRetentionMember)
		deadline, ended, first, legacy   *time.Time
	}{
		{name: "ready chain", archive: "ready", retention: "scheduled", reason: "scheduled", deadline: &grace, ended: &late, first: &at},
		{name: "partial readable", archive: "partial", retention: "scheduled", reason: "scheduled", change: func(r *store.HistoryDirectorySession, _ []store.ArchiveRetentionMember) { r.Completeness = &partial }, deadline: &grace, ended: &late, first: &at},
		{name: "pending", archive: "pending", retention: "unknown", reason: "archive_unavailable", change: func(r *store.HistoryDirectorySession, _ []store.ArchiveRetentionMember) {
			r.State = nil
			r.Retention = nil
		}, ended: &late},
		{name: "failed", archive: "failed", retention: "unknown", reason: "archive_unavailable", change: func(r *store.HistoryDirectorySession, _ []store.ArchiveRetentionMember) {
			r.State = &failed
			r.Retention = nil
		}, ended: &late},
		{name: "unfinished chain", archive: "ready", retention: "waiting", reason: "chain_unfinished", change: func(_ *store.HistoryDirectorySession, m []store.ArchiveRetentionMember) { m[1].Status = "in_progress" }, first: &at},
		{name: "unknown terminal time", archive: "ready", retention: "unknown", reason: "terminal_time_unknown", change: func(_ *store.HistoryDirectorySession, m []store.ArchiveRetentionMember) { m[1].CancelledAt = nil }, first: &at},
		{name: "unknown archive time", archive: "ready", retention: "unknown", reason: "archive_time_unknown", change: func(r *store.HistoryDirectorySession, _ []store.ArchiveRetentionMember) { r.Retention = nil }, ended: &late},
		{name: "legacy grace", archive: "ready", retention: "scheduled", reason: "legacy_grace", change: func(r *store.HistoryDirectorySession, _ []store.ArchiveRetentionMember) {
			r.Retention.FirstSucceededAt = nil
			r.Retention.GraceUntil = &grace
		}, deadline: &grace, ended: &late, legacy: &late},
		{name: "expired remains expired after reopening", archive: "expired", retention: "expired", reason: "history_expired", change: func(r *store.HistoryDirectorySession, m []store.ArchiveRetentionMember) {
			r.Retention.ExpiredAt = &late
			r.Retention.ExpiresAt = &stale
			m[1].Status = "todo"
		}, deadline: &stale, first: &at},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := store.HistoryDirectorySession{TerminalHistoryRow: store.TerminalHistoryRow{ID: directoryOther, Claim: "original-claim", Backend: "web", Created: at, Snapshot: []byte(`{"executionGeneration":"5"}`), State: &ready}, Retention: &store.ArchiveRetention{SessionID: directoryOther, FirstSucceededAt: &at, ExpiresAt: &stale}}
			chain := append([]store.ArchiveRetentionMember(nil), members...)
			if test.change != nil {
				test.change(&r, chain)
			}
			out, err := projectHistorySession(r, chain, nil)
			if err != nil {
				t.Fatal(err)
			}
			if out.ArchiveState != test.archive || out.RetentionState != test.retention || out.RetentionReason != test.reason {
				t.Fatalf("states %#v", out)
			}
			if !reflect.DeepEqual(out.ExpiresAt, test.deadline) || !reflect.DeepEqual(out.ScopeEndedAt, test.ended) || !reflect.DeepEqual(out.FirstArchivedAt, test.first) || !reflect.DeepEqual(out.LegacyGraceStartedAt, test.legacy) {
				t.Fatalf("times %#v want deadline=%v ended=%v first=%v legacy=%v", out, test.deadline, test.ended, test.first, test.legacy)
			}
			if out.SessionID != directoryOther || out.ClaimID != "original-claim" || out.CurrentBinding || out.ExecutionGeneration != "5" {
				t.Fatalf("identity %#v", out)
			}
			if test.archive == "expired" && (out.ExpiredAt == nil || !out.ExpiredAt.Equal(late)) {
				t.Fatal("expiration tombstone lost")
			}
		})
	}
}

func TestHistoryDirectoryPreservesTerminalRecordingAndCorruptDataFailures(t *testing.T) {
	row := store.HistoryDirectorySession{TerminalHistoryRow: store.TerminalHistoryRow{ID: directoryTask, Claim: "original", Backend: "herdr", Terminal: []byte(`{"Envelope":{"executionGeneration":"3"},"Runs":[{"stoppedAt":"2026-11-01T00:00:00Z"}]}`)}}
	out, err := projectHistorySession(row, nil, &model.WorkerClaim{ClaimID: "original", AgentControlMode: model.AgentControlModeHerdr})
	if err != nil || out.ContentKind != "terminal_recording" || out.ExecutionGeneration != "3" || out.EndedAt == nil || *out.EndedAt != "2026-11-01T00:00:00Z" || !out.CurrentBinding || out.RetentionReason != "not_applicable" {
		t.Fatalf("terminal %#v %v", out, err)
	}
	row.Terminal = []byte(`{"Envelope":{"executionGeneration":"3"}}`)
	out, err = projectHistorySession(row, nil, nil)
	if err != nil || out.EndedAt != nil {
		t.Fatalf("unknown terminal end %#v %v", out, err)
	}
	row.Terminal = []byte("{")
	if _, err := projectHistorySession(row, nil, nil); err == nil {
		t.Fatal("corrupt terminal state accepted")
	}
	ready := "ready"
	row.Backend = "web"
	row.Snapshot = []byte(`{"executionGeneration":"1"}`)
	row.State = &ready
	if _, err := projectHistorySession(row, nil, nil); err == nil {
		t.Fatal("ready archive without chain accepted")
	}
}
