package store

// Transactions collects the persistence capabilities assembled by the backend.
type Transactions interface {
	UsageStore
	SnapshotReader
	WebhookTransactions
	ProjectWriter
	ProjectDirectMemberWriter
	ProjectCreationWriter
	GitHubProjectLifecycleStore
	GitHubTeamDeletionStore
	TeamWriter
	IdentityWriter
	PreviewSSOWriter
	CredentialFamilyWriter
	CredentialUsageWriter
	GrantLifecycleWriter
	PrivateTransferWriter
	OAuthClientWriter
	AuthorizationWriter
	PromptSnapshotReader
	PromptWriter
	WorkerWriter
	BotWriter
	SessionWriter
	ThreadWriter
	AttachmentWriter
	AttachmentMutationWriter
	TaskSearchReader
	HistoryDirectoryReader
	AssistantTaskWriter
}
