package model

import "time"

// UsageSubjectKind identifies the persisted credential receiving usage metadata.
type UsageSubjectKind string

const (
	UsageSubjectPAT        UsageSubjectKind = "pat"
	UsageSubjectOAuthGrant UsageSubjectKind = "oauth_grant"
)

// CredentialUsageEvent identifies a successful use and its UTC microsecond time.
// SubjectID is the PAT ID or the OAuth grant ID, respectively.
type CredentialUsageEvent struct {
	Kind      UsageSubjectKind
	UserID    string
	SubjectID string
	At        time.Time
}
