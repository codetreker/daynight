package tag

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/tag"
)

// ScopedTags accepts the authenticated policy snapshot explicitly. It shares the
// catalog transaction and visibility rules with Tags, without changing legacy
// assembly or treating a missing policy as an unrestricted credential.
type ScopedTags struct{ store database }

func NewScoped(db database) *ScopedTags { return &ScopedTags{store: db} }

func (s *ScopedTags) authorized(auth model.CredentialAuthorization) *Tags {
	return &Tags{store: s.store, admit: func(operation scopepolicy.Operation) error {
		return core.RequireAuthorization(auth, operation)
	}}
}

func (s *ScopedTags) Get(ctx context.Context, auth model.CredentialAuthorization, projectID, id string) (Item, error) {
	return s.authorized(auth).Get(ctx, auth.Principal, projectID, id)
}

func (s *ScopedTags) List(ctx context.Context, auth model.CredentialAuthorization, projectID string, input ListInput) (Page, error) {
	return s.authorized(auth).List(ctx, auth.Principal, projectID, input)
}

func (s *ScopedTags) Resolve(ctx context.Context, auth model.CredentialAuthorization, projectID string, ids []string) ([]model.TagReference, error) {
	return s.authorized(auth).Resolve(ctx, auth.Principal, projectID, ids)
}

func (s *ScopedTags) ResolveColors(ctx context.Context, auth model.CredentialAuthorization, projectID string, ids []string, catalogEpoch *string) (ColorPage, error) {
	return s.authorized(auth).ResolveColors(ctx, auth.Principal, projectID, ids, catalogEpoch)
}

func (s *ScopedTags) Create(ctx context.Context, auth model.CredentialAuthorization, projectID, name string, color *string) (WriteResult, error) {
	return s.authorized(auth).Create(ctx, auth.Principal, projectID, name, color)
}

func (s *ScopedTags) Update(ctx context.Context, auth model.CredentialAuthorization, projectID, id string, version int64, name, color *string) (WriteResult, error) {
	return s.authorized(auth).Update(ctx, auth.Principal, projectID, id, version, name, color)
}

func (s *ScopedTags) Rename(ctx context.Context, auth model.CredentialAuthorization, projectID, id string, version int64, name string) (WriteResult, error) {
	return s.authorized(auth).Rename(ctx, auth.Principal, projectID, id, version, name)
}

func (s *ScopedTags) Delete(ctx context.Context, auth model.CredentialAuthorization, projectID, id string, version int64, confirm bool) (WriteResult, error) {
	return s.authorized(auth).Delete(ctx, auth.Principal, projectID, id, version, confirm)
}
