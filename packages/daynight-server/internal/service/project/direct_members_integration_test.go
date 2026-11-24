package project

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
)

func TestDirectMemberPersistedSources(t *testing.T) {
	f := newMembershipFixture(t)
	owner, member, admin, missing := f.user(t), f.user(t), f.user(t), uuid.NewString()
	team := newTestTeam(t, teamservice.NewTeams(f.database), owner, "Direct members")
	p, err := f.projects.Create(context.Background(), owner, core.CreateProject{ExpectedUserID: owner.UserID, Name: "Direct", RepoURL: "https://example.test/" + uuid.NewString(), TeamID: &team.ID})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	direct := NewDirectMembers(f.database, "https://example.test/api/v1")
	if _, err = f.database.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team.ID, admin.UserID); err != nil {
		t.Fatal(err)
	}
	before, err := direct.AddExistingMember(ctx, owner, p.ID, admin.UserID, owner.UserID)
	if err != nil || before.Added || before.Participant.DirectGrant != nil || before.Participant.EffectiveRole != model.ProjectAdmin || before.Participant.InheritedFrom == nil {
		t.Fatalf("inherited admin %+v %v", before, err)
	}
	added, err := direct.AddExistingMember(ctx, admin, p.ID, member.UserID, admin.UserID)
	if err != nil || !added.Added || added.Participant.DirectGrant == nil || added.Participant.EffectiveRole != model.ProjectMemberRole || added.Participant.InheritedFrom != nil {
		t.Fatalf("added %+v %v", added, err)
	}
	repeat, err := direct.AddExistingMember(ctx, owner, p.ID, member.UserID, owner.UserID)
	if err != nil || repeat.Added || !reflect.DeepEqual(repeat.Participant, added.Participant) {
		t.Fatalf("repeat %+v %v", repeat, err)
	}
	grant := added.Participant.DirectGrant
	elevated, err := f.memberships.SetRole(ctx, owner, p.ID, member.UserID, core.SetProjectMemberRole{Version: grant.Version, Role: model.ProjectAdmin, ExpectedUserID: owner.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.database.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, member.UserID); err != nil {
		t.Fatal(err)
	}
	both, err := direct.AddExistingMember(ctx, owner, p.ID, member.UserID, owner.UserID)
	if err != nil || both.Added || both.Participant.EffectiveRole != model.ProjectAdmin || both.Participant.InheritedFrom == nil || !reflect.DeepEqual(both.Participant.DirectGrant, &elevated) {
		t.Fatalf("both %+v %v", both, err)
	}
	_, err = direct.AddExistingMember(ctx, owner, p.ID, missing, owner.UserID)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "user_not_found" {
		t.Fatalf("missing user: %v", err)
	}
	var count int
	if err = f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM team_members WHERE team_id=$1`, team.ID).Scan(&count); err != nil || count != 3 {
		t.Fatalf("Team count %d %v", count, err)
	}
}

type heldDirectScope struct {
	store.ProjectDirectMemberScope
	reached chan struct{}
	release chan struct{}
	once    *sync.Once
}

func (s heldDirectScope) IdentityDAO() store.IdentityDAO {
	s.once.Do(func() { close(s.reached); <-s.release })
	return s.ProjectDirectMemberScope.IdentityDAO()
}

type heldDirectStore struct {
	*postgres.Store
	reached chan struct{}
	release chan struct{}
}

func (s heldDirectStore) WriteProjectDirectMember(ctx context.Context, id string, fn func(store.ProjectDirectMemberScope) error) (store.Completion, error) {
	return s.Store.WriteProjectDirectMember(ctx, id, func(scope store.ProjectDirectMemberScope) error {
		return fn(heldDirectScope{scope, s.reached, s.release, &sync.Once{}})
	})
}

func waitDirectLock(t *testing.T, ctx context.Context, db *postgres.Store, like string) {
	t.Helper()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		var count int
		if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE $1`, like).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("lock wait %q: %v", like, ctx.Err())
		case <-tick.C:
		}
	}
}

func TestDirectAndTeamJoinBothLockOrders(t *testing.T) {
	_, database, _, _ := projectService(t)
	for _, teamFirst := range []bool{true, false} {
		if !t.Run(map[bool]string{true: "team first", false: "direct first"}[teamFirst], func(t *testing.T) {
			f := membershipFixtureWithStore(t, database)
			owner, target := f.user(t), f.user(t)
			team := newTestTeam(t, teamservice.NewTeams(f.database), owner, "Lock ordering")
			p, err := f.projects.Create(context.Background(), owner, core.CreateProject{ExpectedUserID: owner.UserID, Name: "Lock ordering", RepoURL: "https://example.test/" + uuid.NewString(), TeamID: &team.ID})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			type result struct {
				value core.ExistingMemberResult
				err   error
			}
			addDone := make(chan result, 1)
			teamDone := make(chan error, 1)
			reached, release := make(chan struct{}), make(chan struct{})
			var workers sync.WaitGroup
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
				cancel()
				workers.Wait()
			}()
			if teamFirst {
				workers.Add(1)
				go func() {
					defer workers.Done()
					tx, err := f.database.Pool.Begin(ctx)
					if err != nil {
						teamDone <- err
						return
					}
					defer tx.Rollback(context.Background())
					if _, err = tx.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, team.ID); err != nil {
						teamDone <- err
						return
					}
					if _, err = tx.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, target.UserID); err != nil {
						teamDone <- err
						return
					}
					close(reached)
					<-release
					teamDone <- tx.Commit(ctx)
				}()
				select {
				case <-reached:
				case err := <-teamDone:
					t.Fatalf("team setup: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				workers.Add(1)
				go func() {
					defer workers.Done()
					v, e := NewDirectMembers(f.database, "https://example.test/api/v1").AddExistingMember(ctx, owner, p.ID, target.UserID, owner.UserID)
					addDone <- result{v, e}
				}()
				waitDirectLock(t, ctx, f.database, "SELECT id::text FROM teams WHERE id=% FOR SHARE%")
			} else {
				workers.Add(1)
				go func() {
					defer workers.Done()
					v, e := NewDirectMembers(heldDirectStore{f.database, reached, release}, "https://example.test/api/v1").AddExistingMember(ctx, owner, p.ID, target.UserID, owner.UserID)
					addDone <- result{v, e}
				}()
				select {
				case <-reached:
				case result := <-addDone:
					t.Fatalf("direct setup: %v", result.err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				workers.Add(1)
				go func() {
					defer workers.Done()
					_, e := f.database.WriteTeam(ctx, team.ID, func(scope store.TeamWriteScope) error {
						_, e := scope.TeamDAO().AddMember(ctx, target.UserID, model.ProjectMemberRole)
						return e
					})
					teamDone <- e
				}()
				waitDirectLock(t, ctx, f.database, "SELECT id::text FROM teams WHERE id=% FOR UPDATE%")
			}
			close(release)
			a := <-addDone
			if e := <-teamDone; e != nil {
				t.Fatal(e)
			}
			if a.err != nil || a.value.Added == teamFirst {
				t.Fatalf("result %+v %v", a.value, a.err)
			}
			got, err := NewDirectMembers(f.database, "https://example.test/api/v1").AddExistingMember(ctx, owner, p.ID, target.UserID, owner.UserID)
			if err != nil || got.Added || got.Participant.InheritedFrom == nil || (got.Participant.DirectGrant != nil) == teamFirst {
				t.Fatalf("final %+v %v", got, err)
			}
		}) {
			return
		}
	}
}

func TestDirectMemberEligibilityFailureRollsBack(t *testing.T) {
	f := newMembershipFixture(t)
	owner, target := f.user(t), f.user(t)
	p := f.project(t, owner, "Rollback")
	ctx := context.Background()
	if _, err := f.database.Pool.Exec(ctx, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,now(),now())`, uuid.NewString(), uuid.NewString(), p.ID, target.UserID); err != nil {
		t.Fatal(err)
	}
	fail := errors.New("eligibility failure")
	s := NewDirectMembers(failedEligibilityStore{f.database, fail}, "https://example.test/api/v1")
	_, err := s.AddExistingMember(ctx, owner, p.ID, target.UserID, owner.UserID)
	if !errors.Is(err, fail) {
		t.Fatalf("error %v", err)
	}
	var n int
	if err = f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, p.ID, target.UserID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("grant count %d %v", n, err)
	}
	var state string
	var epoch int64
	if err = f.database.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE project_id=$1 AND owner_id=$2`, p.ID, target.UserID).Scan(&state, &epoch); err != nil || state != "active" || epoch != 1 {
		t.Fatalf("eligibility state=%s epoch=%d: %v", state, epoch, err)
	}
}

type failedEligibilityDAO struct {
	store.WebhookEligibilityDAO
	err error
}

func (d failedEligibilityDAO) LockAffected(ctx context.Context, filter store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	if _, err := d.WebhookEligibilityDAO.LockAffected(ctx, filter); err != nil {
		return nil, err
	}
	return nil, d.err
}

type failedEligibilityScope struct {
	store.ProjectDirectMemberScope
	err error
}

func (s failedEligibilityScope) EligibilityDAO() store.WebhookEligibilityDAO {
	return failedEligibilityDAO{s.ProjectDirectMemberScope.EligibilityDAO(), s.err}
}

type failedEligibilityStore struct {
	*postgres.Store
	err error
}

func (s failedEligibilityStore) WriteProjectDirectMember(ctx context.Context, id string, fn func(store.ProjectDirectMemberScope) error) (store.Completion, error) {
	return s.Store.WriteProjectDirectMember(ctx, id, func(scope store.ProjectDirectMemberScope) error { return fn(failedEligibilityScope{scope, s.err}) })
}

type lostDirectReceipt struct {
	*postgres.Store
	failure error
}

func (s lostDirectReceipt) WriteProjectDirectMember(ctx context.Context, id string, fn func(store.ProjectDirectMemberScope) error) (store.Completion, error) {
	c, err := s.Store.WriteProjectDirectMember(ctx, id, fn)
	if err != nil || c.Outcome != store.TransactionCommitted {
		return c, err
	}
	return store.Completion{Outcome: store.TransactionUnknown}, s.failure
}
func TestDirectMemberLostCommitReceipt(t *testing.T) {
	f := newMembershipFixture(t)
	owner, target := f.user(t), f.user(t)
	p := f.project(t, owner, "Lost receipt")
	ctx := context.Background()
	lost := errors.New("commit response lost")
	txerr := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: lost}
	svc := NewDirectMembers(lostDirectReceipt{f.database, txerr}, "https://example.test/api/v1")
	got, err := svc.AddExistingMember(ctx, owner, p.ID, target.UserID, owner.UserID)
	if !reflect.DeepEqual(got, core.ExistingMemberResult{}) || !errors.Is(err, lost) {
		t.Fatalf("result %+v error %v", got, err)
	}
	var failure *store.TransactionError
	if !errors.As(err, &failure) || !failure.CommitAttempted || failure.Outcome != store.TransactionUnknown {
		t.Fatalf("lost outcome %v", err)
	}
	var role string
	var version int64
	if err = f.database.Pool.QueryRow(ctx, `SELECT role,version FROM project_grants WHERE project_id=$1 AND user_id=$2`, p.ID, target.UserID).Scan(&role, &version); err != nil || role != "member" || version < 1 {
		t.Fatalf("persisted %s %d: %v", role, version, err)
	}
}
