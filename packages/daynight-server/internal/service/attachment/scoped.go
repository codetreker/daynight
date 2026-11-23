package attachment

import (
	"context"
	"errors"
	"io"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// AuthorizationReader retrieves current authority for the original credential
// after waiting for the target gate, before an attachment is opened.
type AuthorizationReader func(context.Context, model.CredentialAuthorization) (model.CredentialAuthorization, error)

// ScopedAttachments keeps explicit policy admission separate from legacy
// assembly while sharing the same file gates and upload capacity.
type ScopedAttachments struct {
	base    *Attachments
	current AuthorizationReader
}

func NewScopedAttachments(base *Attachments, current AuthorizationReader) *ScopedAttachments {
	return &ScopedAttachments{base: base, current: current}
}

func (s *ScopedAttachments) authorized(auth model.CredentialAuthorization, fresh bool, operations ...scopepolicy.Operation) (*Attachments, error) {
	if err := auth.Validate(); err != nil {
		return nil, err
	}
	bound := *s.base
	bound.admit = func(ctx context.Context) error {
		current := auth
		if fresh && (auth.Profile == model.ScopedPATProfile || auth.Profile == model.ScopedMCPProfile) {
			if s.current == nil {
				return errors.New("current attachment credential authorization unavailable")
			}
			var err error
			current, err = s.current(ctx, auth)
			if err != nil {
				return err
			}
			if current.Principal != auth.Principal || current.Profile != auth.Profile {
				return model.Unauthenticated(nil)
			}
		}
		return scopeadmission.Require(current, operations...)
	}
	return &bound, nil
}

func (s *ScopedAttachments) List(ctx context.Context, auth model.CredentialAuthorization, projectID, taskID string, request model.PageRequest) (attachmentcore.Page, error) {
	bound, err := s.authorized(auth, false, scopepolicy.AttachmentRead)
	if err != nil {
		return attachmentcore.Page{}, err
	}
	return bound.List(ctx, auth.Principal, projectID, taskID, request)
}

// Put returns full metadata, including the original creation time on overwrite,
// so admission requires permission to read that existing resource as well.
func (s *ScopedAttachments) Put(ctx context.Context, auth model.CredentialAuthorization, projectID, taskID, path, contentType string, content io.Reader) (model.Attachment, bool, error) {
	bound, err := s.authorized(auth, false, scopepolicy.AttachmentUpload, scopepolicy.AttachmentRead)
	if err != nil {
		return model.Attachment{}, false, err
	}
	return bound.Put(ctx, auth.Principal, projectID, taskID, path, contentType, content)
}

func (s *ScopedAttachments) PutRetained(ctx context.Context, auth model.CredentialAuthorization, projectID, taskID, path, contentType string, content io.Reader) (model.Attachment, bool, io.Closer, error) {
	bound, err := s.authorized(auth, false, scopepolicy.AttachmentUpload, scopepolicy.AttachmentRead)
	if err != nil {
		return model.Attachment{}, false, nil, err
	}
	return bound.PutRetained(ctx, auth.Principal, projectID, taskID, path, contentType, content)
}

func (s *ScopedAttachments) Open(ctx context.Context, auth model.CredentialAuthorization, projectID, taskID, path string) (model.Attachment, filestorage.Object, error) {
	bound, err := s.authorized(auth, true, scopepolicy.AttachmentRead)
	if err != nil {
		return model.Attachment{}, filestorage.Object{}, err
	}
	return bound.Open(ctx, auth.Principal, projectID, taskID, path)
}

func (s *ScopedAttachments) Delete(ctx context.Context, auth model.CredentialAuthorization, projectID, taskID, path string) error {
	bound, err := s.authorized(auth, false, scopepolicy.AttachmentDelete)
	if err != nil {
		return err
	}
	return bound.Delete(ctx, auth.Principal, projectID, taskID, path)
}
