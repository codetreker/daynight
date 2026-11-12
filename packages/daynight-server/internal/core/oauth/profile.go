package oauth

import (
	"net/url"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const (
	APIScope         = "daynight:api"
	APIClientID      = "societas-bot"
	APIClientName    = "Societas Bot"
	APIAccessPrefix  = "dnapi_"
	APIRefreshPrefix = "dnapr_"
)

type credentialProfile struct {
	path, scope, clientID, accessPrefix, refreshPrefix string
	rolling                                            bool
}

var (
	mcpProfile = credentialProfile{path: "/mcp", scope: Scope, accessPrefix: model.OAuthAccessPrefix, refreshPrefix: RefreshPrefix}
	apiProfile = credentialProfile{path: "/api/v1", scope: APIScope, clientID: APIClientID, accessPrefix: APIAccessPrefix, refreshPrefix: APIRefreshPrefix, rolling: true}
)

func (p credentialProfile) validResource(resource string) bool {
	u, err := url.Parse(resource)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Hostname() != "" && u.User == nil && u.Path == p.path && u.EscapedPath() == p.path && u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && u.Opaque == "" && u.String() == resource
}

func (p credentialProfile) binding(resource string) store.OAuthBinding {
	return store.OAuthBinding{Resource: resource, Scope: p.scope, ClientID: p.clientID}
}

func profileForResource(resource string) (credentialProfile, bool) {
	for _, profile := range []credentialProfile{mcpProfile, apiProfile} {
		if profile.validResource(resource) {
			return profile, true
		}
	}
	return credentialProfile{}, false
}

// ValidAPIOrigin validates the configured public origin used for the API audience.
func ValidAPIOrigin(origin string) bool {
	u, err := url.Parse(origin)
	return err == nil && u.Path == "" && apiProfile.validResource(origin+"/api/v1")
}
