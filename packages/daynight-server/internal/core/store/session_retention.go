package store

import (
	"context"
	"time"
)

// ArchiveRetentionMember is a current ordinary dependency-chain member. External
// dependencies and Goal membership do not extend the retention chain.
type ArchiveRetentionMember struct {
	TaskID                   string
	Version                  int64
	Status                   string
	CompletedAt, CancelledAt *time.Time
}

// ArchiveRetention is a cached decision, not authority to delete bytes. Consumers
// must refresh within their transaction before displaying or expiring an archive.
// Nil FirstSucceededAt explicitly preserves an unknown legacy success time.
type ArchiveRetention struct {
	SessionID                                          string
	FirstSucceededAt, GraceUntil, ExpiresAt, ExpiredAt *time.Time
	Reason                                             string
	Version                                            int64
	Members                                            []ArchiveRetentionMember
}

type ArchiveRetentionFacts struct {
	Archive ArchiveRetention
	State   string
	Members []ArchiveRetentionMember
}

// ArchiveRetentionDAO is valid only inside WriteArchiveRetention. Facts must
// lock the Session and retention record after the Project lock and return the
// complete current ordinary chain. Save compares the observed retention version.
// Facts returns not found for archives without a first-success or legacy-grace
// record; reading a pending archive must not manufacture a success record.
type ArchiveRetentionDAO interface {
	ArchiveRetentionFacts(context.Context, string, string, string) (ArchiveRetentionFacts, error)
	SaveArchiveRetention(context.Context, int64, ArchiveRetention) (ArchiveRetention, error)
}

// ArchiveRetentionWriter protects chain membership and terminal facts against
// Project writes until the callback commits. Consumers performing expiration
// must recheck archive/resources and mark expiration within that same scope;
// a returned deadline is never a standalone deletion permit.
// This scope exposes only retention data; cleanup must extend the same bound
// transaction with its resource and read-admission capabilities before expiring.
type ArchiveRetentionWriter interface {
	WriteArchiveRetention(context.Context, string, func(ArchiveRetentionDAO) error) (Completion, error)
}

// SessionArchiveRetentionDAO records success in the existing archive publication
// transaction. Duplicate receipts and legacy format conversion preserve the
// original record, including an unknown legacy timestamp and upgrade grace.
type SessionArchiveRetentionDAO interface {
	RecordSessionArchiveSuccess(context.Context, string, time.Time) error
}
