package store

import "context"

// App lifecycle scopes retain the existing resource locks and bind every DAO
// to one transaction. Their callers decide when a resource must be retired.
type GitHubProjectTransferScope interface {
	ProjectGoalDependencyDAO() ProjectGoalDependencyDAO
	ProjectDAO() ProjectWriteDAO
	GitHubDAO() GitHubProjectRetirementDAO
	EligibilityDAO() WebhookEligibilityDAO
}

type GitHubProjectDeletionScope interface {
	ProjectGoalDependencyDAO() ProjectGoalDependencyDAO
	ProjectDAO() ProjectDeletionDAO
	GitHubDAO() GitHubProjectRetirementDAO
	EligibilityDAO() WebhookEligibilityDAO
	SessionDAO() ProjectSessionRetirementDAO
}

type GitHubProjectLifecycleStore interface {
	WriteGitHubProjectTransfer(context.Context, string, func(GitHubProjectTransferScope) error) (Completion, error)
	WriteGitHubProjectDeletion(context.Context, string, func(GitHubProjectDeletionScope) error) (Completion, error)
}

type GitHubProjectRetirementDAO interface {
	// LockBinding acquires App/grant locks before the connection and returns
	// its current App ID after any concurrent App cleanup has completed.
	LockBinding(context.Context) (*string, error)
	Stop(context.Context, GitHubStopDecision) error
	AdvanceImpact(context.Context) error
}

type GitHubTeamRetirementGrant struct{ ID, AppID string }

type GitHubTeamRetirementDAO interface {
	// LockGrants locks every candidate App in UUID order, then reads current
	// grants in a new statement. No Project root is acquired.
	LockGrants(context.Context) ([]GitHubTeamRetirementGrant, error)
	StopGrant(context.Context, GitHubTeamRetirementGrant, GitHubStopDecision) error
	RevokeGrant(context.Context, GitHubTeamRetirementGrant) error
	AdvanceImpact(context.Context, GitHubTeamRetirementGrant) error
}

type GitHubTeamDeletionScope interface {
	TeamDAO() TeamWriteDAO
	GitHubDAO() GitHubTeamRetirementDAO
	EligibilityDAO() WebhookEligibilityDAO
}

type GitHubTeamDeletionStore interface {
	WriteGitHubTeamDeletion(context.Context, string, func(GitHubTeamDeletionScope) error) (Completion, error)
}
