package usage

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type pageDAO struct {
	store.UsageDAO
	now      time.Time
	denied   bool
	revision string
	members  []store.UsageMember
	filters  []store.UsageFilter
}

func (d *pageDAO) Now(context.Context) (time.Time, error) { return d.now, nil }
func (d *pageDAO) Session(_ context.Context, id string) (store.UsageSession, error) {
	return store.UsageSession{ID: id, Scope: "test", OwnerID: "owner"}, nil
}
func (d *pageDAO) ProjectPresent(context.Context, string) (bool, error) { return true, nil }
func (d *pageDAO) ProjectAccess(_ context.Context, _ string, project string, _ bool) (model.ProjectAccess, error) {
	if d.denied {
		return model.ProjectAccess{}, errors.New("revoked")
	}
	return model.ProjectAccess{ProjectID: project, Role: model.ProjectAdmin, Ownership: model.ProjectOwnership{TeamID: "team", Version: 1}}, nil
}
func (d *pageDAO) PermissionEpoch(context.Context, string, string) (string, error) {
	return "epoch", nil
}
func (d *pageDAO) Tasks(_ context.Context, _ string, ids []string) ([]store.UsageMember, error) {
	return []store.UsageMember{{ID: ids[0]}}, nil
}
func (d *pageDAO) Members(context.Context, string, string, string, int) ([]store.UsageMember, error) {
	return d.members, nil
}
func (d *pageDAO) TaskMetrics(context.Context, store.UsageFilter) (map[string]model.UsageSummary, error) {
	return map[string]model.UsageSummary{}, nil
}
func (d *pageDAO) Metrics(context.Context, store.UsageFilter) (model.UsageSummary, error) {
	return emptySummary(), nil
}
func (d *pageDAO) Executions(context.Context, store.UsageFilter) ([]store.UsageExecution, error) {
	return nil, nil
}
func (d *pageDAO) Revision(context.Context, store.UsageFilter) (store.UsageRevision, error) {
	return store.UsageRevision{Hash: d.revision}, nil
}
func (d *pageDAO) Records(_ context.Context, f store.UsageFilter) ([]model.UsageRecord, error) {
	d.filters = append(d.filters, f)
	first := 1
	if f.AfterID != "" {
		first = 2
	}
	if f.AfterID == pageID(2) {
		first = 3
	}
	out := []model.UsageRecord{{ID: pageID(first), CreatedAt: time.Date(2026, 11, 20, 0, 0, first, 0, time.UTC)}}
	if first < 3 {
		out = append(out, model.UsageRecord{ID: pageID(first + 1), CreatedAt: time.Date(2026, 11, 20, 0, 0, first+1, 0, time.UTC)})
	}
	return out, nil
}
func pageID(n int) string { return fmt.Sprintf("10000000-0000-4000-8000-%012d", n) }

type pageScope struct{ dao *pageDAO }

func (s pageScope) UsageDAO() store.UsageDAO     { return s.dao }
func (s pageScope) SessionDAO() store.SessionDAO { return summarySessionDAO{} }
func pageService(t *testing.T, d *pageDAO) *Service {
	return newTestService(t, controlledStore{read: func(_ context.Context, f func(store.UsageScope) error) error { return f(pageScope{d}) }}, Options{})
}

func TestRecordsPaginationRechecksScopeAndKeepsExpiry(t *testing.T) {
	d := &pageDAO{now: time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC), revision: strings.Repeat("a", 64)}
	s := pageService(t, d)
	p := model.Principal{UserID: "owner", CredentialID: "credential"}
	for _, session := range []string{"", pageID(20)} {
		t.Run(session, func(t *testing.T) {
			input := PageRequest{Kind: "measurement", Limit: 1}
			var expiry, first string
			for i := 1; i <= 3; i++ {
				page, err := s.Records(t.Context(), p, "project", pageID(10), session, input)
				if err != nil || len(page.Items) != 1 || page.Items[0].ID != pageID(i) {
					t.Fatalf("page %d: %#v %v", i, page, err)
				}
				if (page.NextCursor == nil) != (i == 3) {
					t.Fatalf("page %d cursor: %#v", i, page.NextCursor)
				}
				if page.NextCursor != nil {
					c, err := s.decodeCursor(*page.NextCursor, d.now, true)
					if err != nil {
						t.Fatal(err)
					}
					if expiry == "" {
						first = *page.NextCursor
						expiry = c.ExpiresAt
					} else if expiry != c.ExpiresAt {
						t.Fatal("renewed expiry")
					}
					input.Cursor = *page.NextCursor
					d.now = d.now.Add(time.Second)
				}
			}
			f := d.filters[len(d.filters)-1]
			if f.Limit != 2 || f.Kind != "measurement" || f.SessionID != session || f.AfterID != pageID(2) {
				t.Fatalf("filter changed: %#v", f)
			}
			if session == "" && (f.ProjectID != "project" || len(f.TaskIDs) != 1 || f.TaskIDs[0] != pageID(10)) {
				t.Fatalf("scope changed: %#v", f)
			}
			input.Cursor = first
			d.revision = strings.Repeat("b", 64)
			_, err := s.Records(t.Context(), p, "project", pageID(10), session, input)
			code(t, err, "reset_required")
			d.revision = strings.Repeat("a", 64)
			input.Cursor = first + "." + strings.Repeat("A", 43)
			_, err = s.Records(t.Context(), p, "project", pageID(10), session, input)
			code(t, err, "reset_required")
			input.Cursor = first
			d.now, _ = time.Parse(time.RFC3339Nano, expiry)
			_, err = s.Records(t.Context(), p, "project", pageID(10), session, input)
			code(t, err, "cursor_expired")
			input.Cursor = "bad.cursor"
			if session == "" {
				d.denied = true
			} else {
				p.UserID = "other"
			}
			_, err = s.Records(t.Context(), p, "project", pageID(10), session, input)
			code(t, err, "resource_unavailable")
			d.denied = false
			p.UserID = "owner"
		})
	}
}

func TestAggregatePaginationRechecksMembershipAndExpiry(t *testing.T) {
	d := &pageDAO{now: time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)}
	for i := 1; i <= 201; i++ {
		d.members = append(d.members, store.UsageMember{ID: pageID(i), Title: "task"})
	}
	s := pageService(t, d)
	p := model.Principal{UserID: "owner", CredentialID: "credential"}
	for _, kind := range []string{"chain", "goal"} {
		t.Run(kind, func(t *testing.T) {
			cursor := ""
			var first string
			var expiry string
			for i, count := range []int{100, 100, 1} {
				page, err := s.Aggregate(t.Context(), p, "project", kind, pageID(1), cursor)
				if err != nil || len(page.MissingMembers) != count || page.MissingMembers[0].TaskID != pageID(i*100+1) {
					t.Fatalf("page %d: %#v %v", i, page, err)
				}
				if (page.NextMembersCursor == nil) != (i == 2) {
					t.Fatalf("page %d cursor: %#v", i, page.NextMembersCursor)
				}
				if page.NextMembersCursor != nil {
					cursor = *page.NextMembersCursor
					c, err := s.decodeCursor(cursor, d.now, false)
					if err != nil || !c.LastTime.IsZero() {
						t.Fatalf("aggregate cursor: %#v %v", c, err)
					}
					if first == "" {
						first = cursor
						expiry = c.ExpiresAt
					} else if expiry != c.ExpiresAt {
						t.Fatal("renewed expiry")
					}
					d.now = d.now.Add(time.Second)
				}
			}
			d.members[0].Title = "changed"
			_, err := s.Aggregate(t.Context(), p, "project", kind, pageID(1), first)
			code(t, err, "reset_required")
			d.members[0].Title = "task"
			d.denied = true
			_, err = s.Aggregate(t.Context(), p, "project", kind, pageID(1), "bad.cursor")
			code(t, err, "aggregate_scope_restricted")
			d.denied = false
		})
	}
}
