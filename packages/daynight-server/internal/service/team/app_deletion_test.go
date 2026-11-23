package team

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/google/uuid"
)

type appTeamDeletionPlan struct {
	t             *testing.T
	principal     model.Principal
	team          model.Team
	grants        []store.GitHubTeamRetirementGrant
	ctx           context.Context
	failure       string
	cause         error
	completion    store.Completion
	completionErr error
	skipCallback  bool
	writes        int
	callbacks     int
	mutations     []string
}

type appTeamDeletionStore struct {
	store.TeamWriter
	store.SnapshotReader
	p *appTeamDeletionPlan
}

func (s appTeamDeletionStore) WriteGitHubTeamDeletion(ctx context.Context, id string, operation func(store.GitHubTeamDeletionScope) error) (store.Completion, error) {
	p := s.p
	p.writes++
	if id != p.team.ID || ctx.Value(appTeamContextKey{}) != p.principal.UserID {
		p.t.Errorf("write scope lost Project identity or parent context: %q", id)
	}
	deadline, present := ctx.Deadline()
	if !present || time.Until(deadline) <= 0 {
		p.t.Error("write scope has no live deadline")
	}
	p.ctx = ctx
	if !p.skipCallback {
		p.callbacks++
		if err := operation(appTeamDeletionScope{p: p}); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
	}
	return p.completion, p.completionErr
}

type appTeamContextKey struct{}
type appTeamDeletionScope struct{ p *appTeamDeletionPlan }

func (s appTeamDeletionScope) TeamDAO() store.TeamWriteDAO { return appTeamDeletionDAO{p: s.p} }
func (s appTeamDeletionScope) GitHubDAO() store.GitHubTeamRetirementDAO {
	return appTeamRetirementDAO{p: s.p}
}
func (s appTeamDeletionScope) EligibilityDAO() store.WebhookEligibilityDAO {
	return appTeamEligibilityDAO{p: s.p}
}

func (p *appTeamDeletionPlan) check(ctx context.Context, operation string) error {
	p.t.Helper()
	if ctx != p.ctx {
		p.t.Errorf("%s received a different transaction context", operation)
	}
	if p.failure == operation {
		return p.cause
	}
	return nil
}

type appTeamDeletionDAO struct {
	store.TeamWriteDAO
	p *appTeamDeletionPlan
}

func (d appTeamDeletionDAO) Team(ctx context.Context, actor string) (model.Team, error) {
	if actor != d.p.principal.UserID {
		d.p.t.Error("Team authorization lost the actor")
	}
	return d.p.team, d.p.check(ctx, "Team read")
}
func (d appTeamDeletionDAO) HasProjects(ctx context.Context) (bool, error) {
	return false, d.p.check(ctx, "ownership read")
}
func (d appTeamDeletionDAO) Delete(ctx context.Context) error {
	d.p.mutations = append(d.p.mutations, "Team")
	return d.p.check(ctx, "Team delete")
}

type appTeamRetirementDAO struct{ p *appTeamDeletionPlan }

func (d appTeamRetirementDAO) LockGrants(ctx context.Context) ([]store.GitHubTeamRetirementGrant, error) {
	return d.p.grants, d.p.check(ctx, "grant locks")
}
func (d appTeamRetirementDAO) mutate(ctx context.Context, g store.GitHubTeamRetirementGrant, kind string) error {
	d.p.t.Helper()
	if g != d.p.grants[0] && g != d.p.grants[1] {
		d.p.t.Errorf("%s received a grant outside the scoped result: %+v", kind, g)
	}
	d.p.mutations = append(d.p.mutations, kind+":"+g.ID)
	return d.p.check(ctx, kind)
}
func (d appTeamRetirementDAO) StopGrant(ctx context.Context, g store.GitHubTeamRetirementGrant, decision store.GitHubStopDecision) error {
	if decision.Enabled || decision.SyncEnabled || decision.AccessState != "unknown" {
		d.p.t.Errorf("retirement retained connection activity: %+v", decision)
	}
	return d.mutate(ctx, g, "stop")
}
func (d appTeamRetirementDAO) RevokeGrant(ctx context.Context, g store.GitHubTeamRetirementGrant) error {
	return d.mutate(ctx, g, "revoke")
}
func (d appTeamRetirementDAO) AdvanceImpact(ctx context.Context, g store.GitHubTeamRetirementGrant) error {
	return d.mutate(ctx, g, "impact")
}

type appTeamEligibilityDAO struct {
	store.WebhookEligibilityDAO
	p *appTeamDeletionPlan
}

func (d appTeamEligibilityDAO) LockAffected(ctx context.Context, filter store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	if filter != (store.WebhookEligibilityFilter{TeamID: d.p.team.ID, TeamOwner: true}) {
		d.p.t.Errorf("eligibility refresh selected another owner: %+v", filter)
	}
	d.p.mutations = append(d.p.mutations, "eligibility")
	return nil, d.p.check(ctx, "eligibility")
}

func newAppTeamDeletionPlan(t *testing.T) (*AppTeams, *appTeamDeletionPlan) {
	t.Helper()
	name := "Ordinary Team"
	p := &appTeamDeletionPlan{
		t: t, principal: model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()},
		team:   model.Team{TeamRef: model.TeamRef{ID: uuid.NewString(), Kind: "ordinary", Name: &name}, Version: 7, Membership: model.TeamMember{Role: model.ProjectAdmin}},
		grants: []store.GitHubTeamRetirementGrant{{ID: uuid.NewString(), AppID: uuid.NewString()}, {ID: uuid.NewString(), AppID: uuid.NewString()}},
		cause:  errors.New("controlled App Team retirement failure"), completion: store.Completion{Outcome: store.TransactionCommitted},
	}
	return NewAppTeams(appTeamDeletionStore{p: p}), p
}
func (p *appTeamDeletionPlan) input() core.ChangeTeam {
	return core.ChangeTeam{Name: *p.team.Name, Version: p.team.Version, ExpectedUserID: p.principal.UserID}
}
func (p *appTeamDeletionPlan) context() context.Context {
	return context.WithValue(p.t.Context(), appTeamContextKey{}, p.principal.UserID)
}

func TestAppTeamDeletionRetiresEveryScopedGrant(t *testing.T) {
	s, p := newAppTeamDeletionPlan(t)
	if err := s.Delete(p.context(), p.principal, p.team.ID, p.input()); err != nil {
		t.Fatal(err)
	}
	want := []string{"Team", "stop:" + p.grants[0].ID, "revoke:" + p.grants[0].ID, "impact:" + p.grants[0].ID, "stop:" + p.grants[1].ID, "revoke:" + p.grants[1].ID, "impact:" + p.grants[1].ID, "eligibility"}
	if p.writes != 1 || p.callbacks != 1 || !reflect.DeepEqual(p.mutations, want) {
		t.Fatalf("coordination: writes=%d callbacks=%d mutations=%v", p.writes, p.callbacks, p.mutations)
	}
}

func TestAppTeamDeletionPreservesFailureAndStopsCoordination(t *testing.T) {
	for _, failure := range []string{"grant locks", "Team read", "ownership read", "Team delete", "stop", "revoke", "impact", "eligibility"} {
		t.Run(failure, func(t *testing.T) {
			s, p := newAppTeamDeletionPlan(t)
			p.failure = failure
			err := s.Delete(p.context(), p.principal, p.team.ID, p.input())
			if !errors.Is(err, p.cause) || p.writes != 1 || p.callbacks != 1 {
				t.Fatalf("failure/replay: %v writes=%d callbacks=%d", err, p.writes, p.callbacks)
			}
			for _, mutation := range p.mutations {
				if failure != "eligibility" && (mutation == "stop:"+p.grants[1].ID || mutation == "eligibility") {
					t.Fatalf("continued after failed first grant: %v", p.mutations)
				}
			}
		})
	}
}

func TestAppTeamDeletionCompletionIsIndependentOfCallback(t *testing.T) {
	for _, scenario := range []struct {
		name            string
		outcome         store.TransactionOutcome
		callback, cause bool
	}{
		{name: "unknown after work", outcome: store.TransactionUnknown, callback: true, cause: true},
		{name: "rollback after work", outcome: store.TransactionNotCommitted, callback: true},
		{name: "store failure before work", outcome: store.TransactionNotCommitted, cause: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			s, p := newAppTeamDeletionPlan(t)
			p.completion.Outcome, p.skipCallback = scenario.outcome, !scenario.callback
			if scenario.cause {
				p.completionErr = p.cause
			}
			err := s.Delete(p.context(), p.principal, p.team.ID, p.input())
			if err == nil || scenario.cause && !errors.Is(err, p.cause) || p.writes != 1 {
				t.Fatalf("completion was lost or replayed: %v writes=%d", err, p.writes)
			}
			if !scenario.callback && (p.callbacks != 0 || len(p.mutations) != 0) {
				t.Fatal("store refusal executed work")
			}
		})
	}
}

func TestAppTeamDeletionValidationAvoidsStore(t *testing.T) {
	s, p := newAppTeamDeletionPlan(t)
	if err := s.Delete(p.context(), p.principal, "invalid", p.input()); err == nil || p.writes != 0 {
		t.Fatalf("invalid input: %v writes=%d", err, p.writes)
	}
}
