package webhook

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
)

type heldConfigurationScope struct {
	store.WebhookWriteScope
	held, release chan struct{}
}

func (s heldConfigurationScope) LockConfigurationSources(ctx context.Context, o wm.Owner, actor string, ids []string) error {
	if err := s.WebhookWriteScope.LockConfigurationSources(ctx, o, actor, ids); err != nil {
		return err
	}
	close(s.held)
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type heldConfigurationStore struct {
	store.WebhookTransactions
	held, release chan struct{}
}

func (s heldConfigurationStore) WriteWebhook(ctx context.Context, o wm.Owner, id string, work func(store.WebhookWriteScope) error) (store.Completion, error) {
	return s.WebhookTransactions.WriteWebhook(ctx, o, id, func(sc store.WebhookWriteScope) error { return work(heldConfigurationScope{sc, s.held, s.release}) })
}

type heldProjectCommitStore struct {
	*postgres.Store
	held, release chan struct{}
}

func (s heldProjectCommitStore) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.Store.WriteProject(ctx, id, func(sc store.ProjectWriteScope) error {
		if err := work(sc); err != nil {
			return err
		}
		close(s.held)
		select {
		case <-s.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

func seedInterleavingProject(t *testing.T, f *fixture, admin, target model.Principal) (string, int64) {
	t.Helper()
	team, project := uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'subscription team')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, admin.UserID}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'subscription project','https://example.test/a/b')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err := f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member') RETURNING version`, project, target.UserID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	return project, version
}
func subscribedCreate(p model.Principal, project string) Mutation {
	m := createMutation(p, "subscriptions", "https://receiver.example/path")
	m.Subscriptions = []corewebhook.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created"}}}
	return m
}
func unblock(t *testing.T, c chan struct{}) {
	t.Helper()
	select {
	case <-c:
	default:
		close(c)
	}
}
func waitHeld(t *testing.T, ctx context.Context, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
func waitError(t *testing.T, ctx context.Context, c <-chan error) {
	t.Helper()
	select {
	case err := <-c:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

// A06: enrollment holds the real Project root through insertion; the actual
// grant removal waits there and then observes the newly committed subscription.
func TestSubscriptionEnrollmentBeforeGrantRevocation(t *testing.T) {
	f := newFixture(t, true)
	admin, target := f.principal(t), f.principal(t)
	project, version := seedInterleavingProject(t, f, admin, target)
	aux := f.auxiliaryPool(t)
	var blocker int32
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	held, release := make(chan struct{}), make(chan struct{})
	defer unblock(t, release)
	svc := &Service{DB: heldConfigurationStore{f.db, held, release}, ConfigurationExpansionAvailable: true}
	owner := Owner{Kind: "personal", ID: target.UserID}
	result := make(chan mutationOutcome, 1)
	go func() {
		r, err := svc.Mutate(f.ctx, target, owner, subscribedCreate(target, project))
		result <- mutationOutcome{r, err}
	}()
	waitHeld(t, f.ctx, held)
	memberships := projectservice.NewMemberships(&postgres.Store{Pool: aux})
	removal := make(chan error, 1)
	go func() {
		_, err := memberships.RemoveGrant(f.ctx, admin, project, target.UserID, coreproject.RemoveProjectMember{Version: version, ExpectedUserID: admin.UserID})
		removal <- err
	}()
	waitBlocked(t, f.ctx, aux, blocker)
	unblock(t, release)
	done := waitOutcome(t, f.ctx, result)
	if done.err != nil {
		t.Fatal(done.err)
	}
	waitError(t, f.ctx, removal)
	var count int
	var state string
	var epoch int64
	if err := aux.QueryRow(f.ctx, `SELECT count(*),min(authorization_state),min(authorization_epoch) FROM webhook_subscriptions WHERE owner_id=$1 AND project_id=$2 AND deleted_at IS NULL`, target.UserID, project).Scan(&count, &state, &epoch); err != nil || count != 1 || state != "confirmation_required" || epoch != 2 {
		t.Fatalf("enrollment/revoke state count=%d state=%s epoch=%d err=%v", count, state, epoch, err)
	}
	t.Logf("T02-A06 blocker=%d count=%d state=%s epoch=%d", blocker, count, state, epoch)
}

// A07: an uncommitted real grant removal holds the Project root while the
// configuration transaction pre-reads access. The locked recheck must refuse.
func TestSubscriptionGrantRevocationBeforeEnrollment(t *testing.T) {
	f := newFixture(t, true)
	admin, target := f.principal(t), f.principal(t)
	project, version := seedInterleavingProject(t, f, admin, target)
	aux := f.auxiliaryPool(t)
	var blocker int32
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	held, release := make(chan struct{}), make(chan struct{})
	defer unblock(t, release)
	memberships := projectservice.NewMemberships(heldProjectCommitStore{f.db, held, release})
	removal := make(chan error, 1)
	go func() {
		_, err := memberships.RemoveGrant(f.ctx, admin, project, target.UserID, coreproject.RemoveProjectMember{Version: version, ExpectedUserID: admin.UserID})
		removal <- err
	}()
	waitHeld(t, f.ctx, held)
	svc := &Service{DB: &postgres.Store{Pool: aux}, ConfigurationExpansionAvailable: true}
	owner := Owner{Kind: "personal", ID: target.UserID}
	result := make(chan mutationOutcome, 1)
	go func() {
		r, err := svc.Mutate(f.ctx, target, owner, subscribedCreate(target, project))
		result <- mutationOutcome{r, err}
	}()
	waitBlocked(t, f.ctx, aux, blocker)
	unblock(t, release)
	waitError(t, f.ctx, removal)
	done := waitOutcome(t, f.ctx, result)
	expectFault(t, done.err, "forbidden")
	var endpoints, subscriptions, receipts int
	if err := aux.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_subscriptions WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1)`, target.UserID).Scan(&endpoints, &subscriptions, &receipts); err != nil || endpoints != 0 || subscriptions != 0 || receipts != 0 {
		t.Fatalf("revoke/enrollment effects endpoints=%d subscriptions=%d receipts=%d err=%v", endpoints, subscriptions, receipts, err)
	}
	t.Logf("T02-A07 blocker=%d forbidden endpoints=%d subscriptions=%d receipts=%d", blocker, endpoints, subscriptions, receipts)
}

type heldPlanningWriter struct {
	store.WebhookWriter
	held, release chan struct{}
}

func (w heldPlanningWriter) Endpoint(ctx context.Context, owner wm.Owner, id string) (wm.Endpoint, error) {
	endpoint, err := w.WebhookWriter.Endpoint(ctx, owner, id)
	if err != nil {
		return endpoint, err
	}
	close(w.held)
	select {
	case <-w.release:
		return endpoint, nil
	case <-ctx.Done():
		return wm.Endpoint{}, ctx.Err()
	}
}

type heldPlanningScope struct {
	store.WebhookWriteScope
	held, release chan struct{}
}

func (s heldPlanningScope) WebhookWriter() store.WebhookWriter {
	return heldPlanningWriter{s.WebhookWriteScope.WebhookWriter(), s.held, s.release}
}

type heldPlanningStore struct {
	store.WebhookTransactions
	held, release chan struct{}
}

func (s heldPlanningStore) WriteWebhook(ctx context.Context, owner wm.Owner, id string, work func(store.WebhookWriteScope) error) (store.Completion, error) {
	return s.WebhookTransactions.WriteWebhook(ctx, owner, id, func(sc store.WebhookWriteScope) error { return work(heldPlanningScope{sc, s.held, s.release}) })
}

// A15: pause after a real v3 planning read, commit a v4 removal and submit a
// guessed v4 intent. The stale plan must not acquire sources or add a binding.
func TestSubscriptionPlanningVersionCannotPredictConcurrentEdit(t *testing.T) {
	f := newFixture(t, true)
	admin, target := f.principal(t), f.principal(t)
	project, _ := seedInterleavingProject(t, f, admin, target)
	owner := Owner{Kind: "personal", ID: target.UserID}
	initial := subscribedCreate(target, project)
	initial.Subscriptions[0].EventTypes = append(initial.Subscriptions[0].EventTypes, "task.deleted")
	created, err := f.svc.Mutate(f.ctx, target, owner, initial)
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, created)
	endpoint := ep["id"].(string)
	for i, name := range []string{"version two", "version three"} {
		change := mutation(target, "endpoint.update", endpoint, int64(i+1))
		change.Name = &name
		if _, err = f.svc.Mutate(f.ctx, target, owner, change); err != nil {
			t.Fatal(err)
		}
	}
	var subID string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL`, endpoint).Scan(&subID); err != nil {
		t.Fatal(err)
	}
	held, release := make(chan struct{}), make(chan struct{})
	defer unblock(t, release)
	planned := &Service{DB: heldPlanningStore{f.db, held, release}, ConfigurationExpansionAvailable: true}
	guessed := mutation(target, "endpoint.update", endpoint, 4)
	guessed.HasSubscriptions = true
	guessed.Subscriptions = []corewebhook.SubscriptionInput{{ID: &subID, ProjectID: project, EventTypes: []string{"task.created", "task.deleted"}}}
	outcome := make(chan mutationOutcome, 1)
	go func() { r, err := planned.Mutate(f.ctx, target, owner, guessed); outcome <- mutationOutcome{r, err} }()
	waitHeld(t, f.ctx, held)
	aux := f.auxiliaryPool(t)
	live := &Service{DB: &postgres.Store{Pool: aux}, ConfigurationExpansionAvailable: true}
	change := mutation(target, "endpoint.update", endpoint, 3)
	change.HasSubscriptions = true
	change.Subscriptions = []corewebhook.SubscriptionInput{{ID: &subID, ProjectID: project, EventTypes: []string{"task.created"}}}
	if _, err = live.Mutate(f.ctx, target, owner, change); err != nil {
		t.Fatal(err)
	}
	unblock(t, release)
	done := waitOutcome(t, f.ctx, outcome)
	expectFault(t, done.err, "version_conflict")
	var version int64
	var active, retired, receipts, guessedReceipts int
	if err = aux.QueryRow(f.ctx, `SELECT (SELECT config_version FROM webhook_endpoints WHERE id=$1), (SELECT count(*) FROM webhook_bindings WHERE subscription_id=$2 AND deleted_at IS NULL), (SELECT count(*) FROM webhook_bindings WHERE subscription_id=$2 AND deleted_at IS NOT NULL), (SELECT count(*) FROM webhook_operations WHERE owner_kind='personal' AND owner_id=$3), (SELECT count(*) FROM webhook_operations WHERE owner_kind='personal' AND owner_id=$3 AND operation_id=$4)`, endpoint, subID, target.UserID, guessed.OperationID).Scan(&version, &active, &retired, &receipts, &guessedReceipts); err != nil || version != 4 || active != 1 || retired != 1 || receipts != 4 || guessedReceipts != 0 {
		t.Fatalf("planning conflict: version=%d active=%d retired=%d receipts=%d guessed=%d err=%v", version, active, retired, receipts, guessedReceipts, err)
	}
	t.Logf("T02-A15 planned=3 caller=4 current=%d active=%d retired=%d guessedReceipts=%d", version, active, retired, guessedReceipts)
}

type heldTeamCommitStore struct {
	*postgres.Store
	held, release chan struct{}
}

func (s heldTeamCommitStore) WriteTeam(ctx context.Context, id string, work func(store.TeamWriteScope) error) (store.Completion, error) {
	return s.Store.WriteTeam(ctx, id, func(scope store.TeamWriteScope) error {
		if err := work(scope); err != nil {
			return err
		}
		close(s.held)
		select {
		case <-s.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}
func teamOf(t *testing.T, f *fixture, project string) string {
	t.Helper()
	var id string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, project).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
func createActiveSubscription(t *testing.T, f *fixture, target model.Principal, project string) string {
	t.Helper()
	owner := Owner{Kind: "personal", ID: target.UserID}
	result, err := f.svc.Mutate(f.ctx, target, owner, subscribedCreate(target, project))
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, result)
	var id string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL`, ep["id"]).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
func assertSubscription(t *testing.T, ctx context.Context, db *postgres.Store, id, state string, epoch int64) {
	t.Helper()
	var actual string
	var n int64
	if err := db.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, id).Scan(&actual, &n); err != nil || actual != state || n != epoch {
		t.Fatalf("subscription state=%s epoch=%d err=%v", actual, n, err)
	}
}
func teamInvitation(t *testing.T, f *fixture, admin model.Principal, team string) string {
	t.Helper()
	result, err := teamservice.NewTeams(f.db).CreateInvitation(f.ctx, admin, team, admin.UserID)
	if err != nil {
		t.Fatal(err)
	}
	return result.Secret
}

// A04: membership is added and the subscription is fenced before a direct
// grant removal; the post-wait read must observe the newly committed member.
func TestSubscriptionMembershipBeforeGrantRemoval(t *testing.T) {
	f := newFixture(t, true)
	admin, target := f.principal(t), f.principal(t)
	project, version := seedInterleavingProject(t, f, admin, target)
	team := teamOf(t, f, project)
	id := createActiveSubscription(t, f, target, project)
	secret := teamInvitation(t, f, admin, team)
	aux := f.auxiliaryPool(t)
	observer := &postgres.Store{Pool: aux}
	var blocker int32
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	held, release := make(chan struct{}), make(chan struct{})
	defer unblock(t, release)
	teams := teamservice.NewTeams(heldTeamCommitStore{f.db, held, release})
	addition := make(chan error, 1)
	go func() { _, err := teams.AcceptInvitation(f.ctx, target, secret, target.UserID); addition <- err }()
	waitHeld(t, f.ctx, held)
	membership := projectservice.NewMemberships(observer)
	removal := make(chan error, 1)
	go func() {
		_, err := membership.RemoveGrant(f.ctx, admin, project, target.UserID, coreproject.RemoveProjectMember{Version: version, ExpectedUserID: admin.UserID})
		removal <- err
	}()
	waitBlocked(t, f.ctx, aux, blocker)
	unblock(t, release)
	waitError(t, f.ctx, addition)
	waitError(t, f.ctx, removal)
	assertSubscription(t, f.ctx, observer, id, "active", 1)
	var membershipPresent, grantPresent bool
	if err := aux.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2),EXISTS(SELECT 1 FROM project_grants WHERE project_id=$3 AND user_id=$2)`, team, target.UserID, project).Scan(&membershipPresent, &grantPresent); err != nil || !membershipPresent || grantPresent {
		t.Fatalf("membership=%t grant=%t err=%v", membershipPresent, grantPresent, err)
	}
	t.Logf("T02-A04 blocker=%d membership=%t grant=%t epoch=1", blocker, membershipPresent, grantPresent)
}

// A05: both source directions leave a committed gap. The second operation is
// held before commit so an independent connection can observe that gap.
func TestSubscriptionAuthorizationGapBothDirections(t *testing.T) {
	for _, direction := range []string{"grant_then_member", "member_then_grant"} {
		t.Run(direction, func(t *testing.T) {
			f := newFixture(t, true)
			admin, target := f.principal(t), f.principal(t)
			project, grantVersion := seedInterleavingProject(t, f, admin, target)
			team := teamOf(t, f, project)
			if direction == "member_then_grant" {
				if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team, target.UserID); err != nil {
					t.Fatal(err)
				}
				if _, err := f.db.Pool.Exec(f.ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project, target.UserID); err != nil {
					t.Fatal(err)
				}
			}
			id := createActiveSubscription(t, f, target, project)
			secret := ""
			var memberVersion int64
			if direction == "grant_then_member" {
				secret = teamInvitation(t, f, admin, team)
			} else if err := f.db.Pool.QueryRow(f.ctx, `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, team, target.UserID).Scan(&memberVersion); err != nil {
				t.Fatal(err)
			}
			aux := f.auxiliaryPool(t)
			observer := &postgres.Store{Pool: aux}
			var blocker int32
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
				t.Fatal(err)
			}
			firstHeld, firstRelease, secondHeld, secondRelease := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
			defer unblock(t, firstRelease)
			defer unblock(t, secondRelease)
			firstDone, secondDone := make(chan error, 1), make(chan error, 1)
			if direction == "grant_then_member" {
				first := projectservice.NewMemberships(heldProjectCommitStore{f.db, firstHeld, firstRelease})
				go func() {
					_, err := first.RemoveGrant(f.ctx, admin, project, target.UserID, coreproject.RemoveProjectMember{Version: grantVersion, ExpectedUserID: admin.UserID})
					firstDone <- err
				}()
				waitHeld(t, f.ctx, firstHeld)
				second := teamservice.NewTeams(heldTeamCommitStore{observer, secondHeld, secondRelease})
				go func() { _, err := second.AcceptInvitation(f.ctx, target, secret, target.UserID); secondDone <- err }()
			} else {
				first := teamservice.NewTeams(heldTeamCommitStore{f.db, firstHeld, firstRelease})
				go func() {
					_, err := first.RemoveMember(f.ctx, admin, team, target.UserID, coreteam.ChangeTeamMember{Version: memberVersion, ExpectedUserID: admin.UserID})
					firstDone <- err
				}()
				waitHeld(t, f.ctx, firstHeld)
				second := projectservice.NewMemberships(heldProjectCommitStore{observer, secondHeld, secondRelease})
				go func() {
					_, err := second.SetGrant(f.ctx, admin, project, target.UserID, coreproject.SetProjectGrant{Role: model.ProjectMemberRole, ExpectedUserID: admin.UserID})
					secondDone <- err
				}()
			}
			waitBlocked(t, f.ctx, aux, blocker)
			unblock(t, firstRelease)
			waitError(t, f.ctx, firstDone)
			waitHeld(t, f.ctx, secondHeld)
			var access bool
			if err := aux.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2) OR EXISTS(SELECT 1 FROM project_grants WHERE project_id=$3 AND user_id=$2)`, team, target.UserID, project).Scan(&access); err != nil || access {
				t.Fatalf("committed access gap: access=%t err=%v", access, err)
			}
			assertSubscription(t, f.ctx, observer, id, "confirmation_required", 2)
			unblock(t, secondRelease)
			waitError(t, f.ctx, secondDone)
			assertSubscription(t, f.ctx, observer, id, "confirmation_required", 2)
			if err := aux.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2) OR EXISTS(SELECT 1 FROM project_grants WHERE project_id=$3 AND user_id=$2)`, team, target.UserID, project).Scan(&access); err != nil || !access {
				t.Fatalf("restored access: access=%t err=%v", access, err)
			}
			t.Logf("T02-A05 direction=%s blocker=%d gap=true finalAccess=%t state=confirmation_required epoch=2", direction, blocker, access)
		})
	}
}
