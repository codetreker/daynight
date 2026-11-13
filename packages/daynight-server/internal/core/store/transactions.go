package store

// Transactions collects the persistence capabilities assembled by the backend.
type Transactions interface {
	SnapshotReader
	WebhookTransactions
	ProjectWriter
	ProjectCreationWriter
	TeamWriter
	IdentityWriter
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
	AssistantTaskWriter
}
