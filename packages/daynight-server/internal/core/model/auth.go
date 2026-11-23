package model

import (
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

type CredentialKind string

const (
	SessionCredential CredentialKind = "session"
	PATCredential     CredentialKind = "pat"
	OAuthCredential   CredentialKind = "oauth"
)

const OAuthAccessPrefix = "dnmcp_"

type Principal struct {
	UserID       string
	CredentialID string
	Kind         CredentialKind
}

// CredentialAuthorization keeps the current business-policy snapshot separate
// from the identity that may be persisted as an actor. Profile must be explicit;
// an absent scoped policy cannot be interpreted as a fixed-profile grant.
type CredentialAuthorization struct {
	Principal Principal
	Profile   CredentialPolicyProfile
	Policy    *scopepolicy.Policy
}

type CredentialPolicyProfile string

const (
	ScopedPATProfile CredentialPolicyProfile = "scoped_pat"
	ScopedMCPProfile CredentialPolicyProfile = "scoped_mcp"
	SessionProfile   CredentialPolicyProfile = "session"
	OAuthAPIProfile  CredentialPolicyProfile = "oauth_api"
)

// Validate rejects missing, mismatched and unrecognized policy profiles. The
// caller must establish the profile from the authenticated resource binding.
func (a CredentialAuthorization) Validate() error {
	if err := RequirePrincipal(a.Principal); err != nil {
		return err
	}
	switch a.Profile {
	case ScopedPATProfile:
		if a.Principal.Kind != PATCredential || a.Policy == nil || a.Policy.Kind() != scopepolicy.PAT || a.Policy.Version() < 1 {
			return fmt.Errorf("invalid PAT policy")
		}
	case ScopedMCPProfile:
		if a.Principal.Kind != OAuthCredential || a.Policy == nil || a.Policy.Kind() != scopepolicy.MCP || a.Policy.Version() < 1 {
			return fmt.Errorf("invalid MCP policy")
		}
	case SessionProfile:
		if a.Principal.Kind != SessionCredential || a.Policy != nil {
			return fmt.Errorf("invalid session policy")
		}
	case OAuthAPIProfile:
		if a.Principal.Kind != OAuthCredential || a.Policy != nil {
			return fmt.Errorf("invalid API OAuth policy")
		}
	default:
		return fmt.Errorf("invalid credential policy profile")
	}
	return nil
}

type User struct {
	ID            string
	UniAuthID     string
	Email         *string
	EmailVerified *bool
	Name          *string
	AvatarURL     *string
	CreatedAt     time.Time
	UpdatedAt     time.Time
	PersonalTeam  TeamRef
}

type ProfileField struct {
	Present bool
	Value   *string
}

type UserProfilePatch struct {
	Name      ProfileField
	AvatarURL ProfileField
}

type LoginTransaction struct {
	ID                 string
	StateHash          []byte
	BrowserBindingHash []byte
	ScopeHash          []byte
	Provider           string
	ReturnPath         string
	ExpiresAt          time.Time
}

type Session struct {
	LastUsedAt       *time.Time
	ID               string
	UserID           string
	TokenHash        []byte
	PreviewTokenHash []byte
	CreatedAt        time.Time
	ExpiresAt        time.Time
}

type PersonalAccessToken struct {
	// ScopePolicy is populated only when the scoped credential storage is enabled.
	ScopePolicy *scopepolicy.Policy
	ID          string
	UserID      string
	TokenHash   []byte
	Name        string
	CreatedAt   time.Time
	ExpiresAt   *time.Time
	LastUsedAt  *time.Time
	Description *string
}

// PreviewSSOLogin stores only hashes of transient SSO secrets.
type PreviewSSOLogin struct {
	ID        string
	ReturnURL string
	StateHash []byte
	CodeHash  []byte
	SessionID string
	ExpiresAt time.Time
}
