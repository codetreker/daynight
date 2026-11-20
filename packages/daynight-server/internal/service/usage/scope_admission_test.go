package usage

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type scopedSummaryScope struct {
	summaryScope
	current model.CredentialAuthorization
	checks  *int
}

func (s scopedSummaryScope) CurrentUsageAuthorization(_ context.Context, p model.Principal, _ time.Time) (model.CredentialAuthorization, error) {
	*s.checks++
	if p != s.current.Principal {
		return model.CredentialAuthorization{}, errors.New("wrong principal")
	}
	return s.current, nil
}
func usageAuth(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}, Profile: model.ScopedPATProfile, Policy: &policy}
}
func TestUsageScopedReadsAndRecheck(t *testing.T) {
	id := "10000000-0000-4000-8000-000000000001"
	allowed := usageAuth(t, "usage:read")
	denied := usageAuth(t, "task:read")
	dao := &summaryDAO{now: time.Now().UTC(), tasks: []store.UsageMember{{ID: id}}}
	current, checks, reads := allowed, 0, 0
	s := newTestService(t, controlledStore{read: func(ctx context.Context, f func(store.UsageScope) error) error {
		reads++
		return f(scopedSummaryScope{summaryScope: summaryScope{dao}, current: current, checks: &checks})
	}}, Options{})
	if _, err := s.TaskSummariesAuthorized(t.Context(), allowed, "project", []string{id}); err != nil {
		t.Fatal(err)
	}
	if reads != 1 || checks != 1 || dao.metricsCalls != 1 {
		t.Fatalf("calls %d %d %d", reads, checks, dao.metricsCalls)
	}
	current = denied
	if _, err := s.TaskSummariesAuthorized(t.Context(), allowed, "project", []string{id}); err == nil {
		t.Fatal("revoked current policy admitted")
	}
	if checks != 2 || dao.metricsCalls != 1 {
		t.Fatal("read usage after revoked scope")
	}
	var f *model.Fault
	if _, err := s.TaskSummariesAuthorized(t.Context(), denied, "project", []string{id}); !errors.As(err, &f) || f.Code != "insufficient_scope" {
		t.Fatalf("scope refusal: %v", err)
	}
	if reads != 3 || checks != 2 || dao.metricsCalls != 1 {
		t.Fatal("denied call read usage")
	}
}
func TestUsageScopedReadFailsClosedWithoutTransactionPolicy(t *testing.T) {
	id := "10000000-0000-4000-8000-000000000001"
	dao := &summaryDAO{now: time.Now().UTC(), tasks: []store.UsageMember{{ID: id}}}
	s := newTestService(t, controlledStore{read: func(_ context.Context, f func(store.UsageScope) error) error { return f(summaryScope{dao}) }}, Options{})
	if _, err := s.TaskSummariesAuthorized(t.Context(), usageAuth(t, "usage:read"), "project", []string{id}); err == nil {
		t.Fatal("missing transactional policy admitted")
	}
	if dao.metricsCalls != 0 {
		t.Fatal("read usage without current policy")
	}
	fixed := model.CredentialAuthorization{Principal: model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}, Profile: model.SessionProfile}
	if _, err := s.TaskSummariesAuthorized(t.Context(), fixed, "project", []string{id}); err != nil {
		t.Fatal(err)
	}
}

type restrictedUsageDAO struct {
	*summaryDAO
	accessErr error
}

func (d *restrictedUsageDAO) ProjectAccess(ctx context.Context, user, project string, write bool) (model.ProjectAccess, error) {
	if d.accessErr != nil {
		return model.ProjectAccess{}, d.accessErr
	}
	return d.summaryDAO.ProjectAccess(ctx, user, project, write)
}
func (d *restrictedUsageDAO) ProjectPresent(context.Context, string) (bool, error) { return true, nil }
func (d *restrictedUsageDAO) Members(context.Context, string, string, string, int) ([]store.UsageMember, error) {
	return d.tasks, nil
}

type restrictedUsageScope struct {
	dao     *restrictedUsageDAO
	current model.CredentialAuthorization
	err     error
}

func (s restrictedUsageScope) UsageDAO() store.UsageDAO     { return s.dao }
func (s restrictedUsageScope) SessionDAO() store.SessionDAO { return summarySessionDAO{} }
func (s restrictedUsageScope) CurrentUsageAuthorization(context.Context, model.Principal, time.Time) (model.CredentialAuthorization, error) {
	return s.current, s.err
}

func TestUsageVisibilityAndAggregateScopeErrors(t *testing.T) {
	id := "10000000-0000-4000-8000-000000000001"
	allowed := usageAuth(t, "usage:read")
	denied := usageAuth(t, "task:read")
	dao := &restrictedUsageDAO{summaryDAO: &summaryDAO{now: time.Now().UTC(), tasks: []store.UsageMember{{ID: id}}}, accessErr: errors.New("hidden")}
	current := denied
	var readErr error
	s := newTestService(t, controlledStore{read: func(_ context.Context, f func(store.UsageScope) error) error {
		return f(restrictedUsageScope{dao: dao, current: current, err: readErr})
	}}, Options{})
	_, err := s.TaskSummariesAuthorized(t.Context(), denied, "project", []string{id})
	code(t, err, "resource_unavailable")
	dao.accessErr = nil
	dao.tasks = nil
	_, err = s.TaskSummariesAuthorized(t.Context(), denied, "project", []string{id})
	code(t, err, "resource_unavailable")
	dao.tasks = make([]store.UsageMember, 10001)
	_, err = s.AggregateAuthorized(t.Context(), denied, "project", "chain", id, "")
	var scopeFault *model.Fault
	if !errors.As(err, &scopeFault) || scopeFault.Code != "insufficient_scope" {
		t.Fatalf("aggregate size disclosed: %v", err)
	}
	dao.tasks = []store.UsageMember{{ID: id}}
	_, err = s.AggregateAuthorized(t.Context(), allowed, "project", "chain", id, "")
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
		t.Fatalf("revoked aggregate scope: %v", err)
	}
	readErr = errors.New("current policy read failed")
	_, err = s.AggregateAuthorized(t.Context(), allowed, "project", "chain", id, "")
	if !errors.Is(err, readErr) {
		t.Fatalf("policy read failure was masked: %v", err)
	}
	if dao.metricsCalls != 0 {
		t.Fatal("read usage before admission")
	}
}
