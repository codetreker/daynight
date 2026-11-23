package usage

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// CurrentUsageAuthorization is supplied by the usage transaction when scoped
// credentials are enabled. It reads the same actor's current policy in the
// transaction that performs the existing credential recheck.
type CurrentUsageAuthorization interface {
	CurrentUsageAuthorization(context.Context, model.Principal, time.Time) (model.CredentialAuthorization, error)
}

// ProducerAuthorization reads the current authorization of the exact principal
// through the supplied usage transaction or snapshot. A write must lock the
// credential through commit and validate its expiry after acquiring the lock.
type ProducerAuthorization func(context.Context, store.UsageScope, model.Principal, time.Time, bool) (model.CredentialAuthorization, error)

// NewScoped protects producer operations while retaining the legacy assembly.
func NewScoped(database store.UsageStore, options Options, current ProducerAuthorization) (*Service, error) {
	if current == nil {
		return nil, fmt.Errorf("usage producer authorization is required")
	}
	s, err := New(database, options)
	if err != nil {
		return nil, err
	}
	s.producerAuthorization = current
	return s, nil
}

func (s *Service) requireProducer(ctx context.Context, scope store.UsageScope, p model.Principal, now time.Time, write bool) error {
	if s.producerAuthorization == nil {
		return nil
	}
	auth, err := s.producerAuthorization(ctx, scope, p, now, write)
	if err != nil {
		return err
	}
	if auth.Principal != p || (p.Kind == model.PATCredential && auth.Profile != model.ScopedPATProfile) {
		return fmt.Errorf("usage producer authorization changed identity or profile")
	}
	return scopeadmission.Require(auth, scopepolicy.SessionProduce)
}

type usageAuthorizationKey struct{}

func usageContext(ctx context.Context, auth model.CredentialAuthorization) (context.Context, error) {
	if err := auth.Validate(); err != nil {
		return ctx, err
	}
	return context.WithValue(ctx, usageAuthorizationKey{}, auth), nil
}

func (s *Service) recheckUsageScope(ctx context.Context, scope store.UsageScope, p model.Principal, now time.Time) error {
	auth, ok := ctx.Value(usageAuthorizationKey{}).(model.CredentialAuthorization)
	if !ok {
		return nil
	}
	if err := scopeadmission.Require(auth, scopepolicy.UsageRead); err != nil {
		return err
	}
	if auth.Policy == nil {
		return nil
	}
	var current model.CredentialAuthorization
	var err error
	if s.producerAuthorization != nil {
		current, err = s.producerAuthorization(ctx, scope, p, now, false)
	} else {
		reader, ok := scope.(CurrentUsageAuthorization)
		if !ok {
			return fmt.Errorf("usage transaction cannot recheck scoped credential")
		}
		current, err = reader.CurrentUsageAuthorization(ctx, p, now)
	}
	if err != nil {
		return err
	}
	if current.Principal != p || current.Profile != auth.Profile {
		return fmt.Errorf("usage credential authorization changed identity or profile")
	}
	return scopeadmission.Require(current, scopepolicy.UsageRead)
}

// TaskSummariesAuthorized admits user-visible usage, including the batch POST.
func (s *Service) TaskSummariesAuthorized(ctx context.Context, auth model.CredentialAuthorization, project string, ids []string) (Summaries, error) {
	ctx, err := usageContext(ctx, auth)
	if err != nil {
		return Summaries{}, err
	}
	return s.TaskSummaries(ctx, auth.Principal, project, ids)
}

func (s *Service) TestSummaryAuthorized(ctx context.Context, auth model.CredentialAuthorization, id string) (model.UsageSummary, error) {
	ctx, err := usageContext(ctx, auth)
	if err != nil {
		return model.UsageSummary{}, err
	}
	return s.TestSummary(ctx, auth.Principal, id)
}

func (s *Service) RecordsAuthorized(ctx context.Context, auth model.CredentialAuthorization, project, task, sessionID string, input PageRequest) (RecordsPage, error) {
	ctx, err := usageContext(ctx, auth)
	if err != nil {
		return RecordsPage{}, err
	}
	return s.Records(ctx, auth.Principal, project, task, sessionID, input)
}

func (s *Service) AggregateAuthorized(ctx context.Context, auth model.CredentialAuthorization, project, kind, id, token string) (Aggregate, error) {
	ctx, err := usageContext(ctx, auth)
	if err != nil {
		return Aggregate{}, err
	}
	return s.Aggregate(ctx, auth.Principal, project, kind, id, token)
}
