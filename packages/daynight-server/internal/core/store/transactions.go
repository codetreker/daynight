package store

// Transactions collects the persistence capabilities assembled by the backend.
type Transactions interface {
	SnapshotReader
	ProjectWriter
	ProjectCreationWriter
	TeamWriter
	IdentityWriter
	WorkerWriter
	BotWriter
	SessionWriter
	ThreadWriter
	AttachmentWriter
	AttachmentMutationWriter
	TaskSearchReader
}
