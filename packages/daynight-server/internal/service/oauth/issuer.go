package oauth

import (
	"context"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// APIIssuer issues credentials for the fixed application at the configured origin.
// Account creation and its independent transaction belong to the calling use case.
type APIIssuer struct {
	writer   store.CredentialFamilyWriter
	resource string
	now      func() time.Time
	issue    func(context.Context, store.CredentialFamilyDAO, string, string, time.Time) (core.IssuedFamily, error)
}

func NewAPIIssuer(writer store.CredentialFamilyWriter, publicOrigin string) (*APIIssuer, error) {
	if writer == nil || !core.ValidAPIOrigin(publicOrigin) {
		return nil, core.ErrInvalidAuthorization
	}
	return &APIIssuer{writer: writer, resource: publicOrigin + "/api/v1", now: time.Now, issue: core.IssueAPIFamily}, nil
}

// Issue releases secrets only after the family transaction confirms commit.
func (s *APIIssuer) Issue(ctx context.Context, userID string) (core.IssuedFamily, error) {
	var result core.IssuedFamily
	c, err := s.writer.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		var err error
		result, err = s.issue(ctx, scope.CredentialFamilyDAO(), userID, s.resource, s.now())
		return err
	})
	if err := completionError(c, err); err != nil {
		return core.IssuedFamily{}, err
	}
	return result, nil
}
