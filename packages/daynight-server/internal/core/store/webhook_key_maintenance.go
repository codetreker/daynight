package store

import "context"

// WebhookCiphertext is a snapshot of one encrypted record and its AAD identity.
// A replacement is accepted only while both the envelope and identity match.
type WebhookCiphertext struct {
	Kind, ID, EndpointID, OwnerKind, OwnerID, RecordID string
	Version                                            int
	MasterKeyID                                        string
	Nonce, Ciphertext                                  []byte
}

// WebhookKeyMaintenance scans and conditionally replaces retained ciphertexts.
// Scans are bounded; concurrent writers may invalidate a candidate at any time.
type WebhookKeyMaintenance interface {
	WebhookMasterReferences
	WebhookCiphertexts(context.Context, string, *WebhookCiphertext, int) ([]WebhookCiphertext, error)
	CompareAndSwapWebhookCiphertext(context.Context, WebhookCiphertext, WebhookCiphertext) (bool, error)
}

// WebhookRecoveryReader permits comparison with a separately restored snapshot.
type WebhookRecoveryReader interface {
	OpenWebhookRecoverySnapshot(context.Context) (WebhookRecoverySnapshot, error)
}

// WebhookRecoveryIdentity identifies a PostgreSQL database independently of
// its connection string, host alias, pool or search path.
type WebhookRecoveryIdentity struct {
	ClusterID   string
	DatabaseOID uint32
}

// WebhookRecoverySnapshot pins all reads and the identity check to one
// repeatable-read, read-only database transaction.
type WebhookRecoverySnapshot interface {
	WebhookMasterKeyIDs(context.Context) ([]string, error)
	WebhookCiphertexts(context.Context, string, *WebhookCiphertext, int) ([]WebhookCiphertext, error)
	WebhookCiphertextByID(context.Context, string, string) (*WebhookCiphertext, error)
	RecoveryIdentity(context.Context) (WebhookRecoveryIdentity, error)
	Close(context.Context) error
}
