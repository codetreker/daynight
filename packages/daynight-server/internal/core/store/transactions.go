package store

// Transactions collects the persistence capabilities assembled by the backend.
type Transactions interface {
	SnapshotReader
	TeamItemStore
	ProjectWriter
	ProjectCreationWriter
	TeamWriter
	IdentityWriter
	CredentialFamilyWriter
	GrantLifecycleWriter
	PrivateTransferWriter
	OAuthClientWriter
	AuthorizationWriter
	GrantLifecycleWriter
	WorkerWriter
	BotWriter
	SessionWriter
	ThreadWriter
	AttachmentWriter
	AttachmentMutationWriter
	TaskSearchReader
}
