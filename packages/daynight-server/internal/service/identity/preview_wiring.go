package identity

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

// NewWithPreviewSSO assembles the existing main-site identity and preview use cases.
func NewWithPreviewSSO(writer store.IdentityWriter, client *uniauth.Client, callbackURL string, preview *PreviewSSO) *Identity {
	identity := New(writer, client, callbackURL)
	identity.preview = preview
	return identity
}

func (s *Identity) PreviewSSO() *PreviewSSO { return s.preview }
