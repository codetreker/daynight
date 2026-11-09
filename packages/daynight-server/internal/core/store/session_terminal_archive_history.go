package store

import (
	"context"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

type TerminalHistoryRow struct {
	ID, Claim, Backend              string
	Created                         time.Time
	Snapshot, Terminal              []byte
	State, Hash, Size, Completeness *string
}

type TerminalArchiveHistoryDAO interface {
	TerminalArchive(context.Context, string) (v2.ArchiveStatus, *v2.Receipt, string, error)
	SaveTerminalReceipt(context.Context, string, v2.Receipt, *string) error
	SaveTerminalArchiveStatus(context.Context, string, v2.ArchiveStatus) error
	CurrentTerminalSession(context.Context, string, string, string) (string, error)
	TerminalHistory(context.Context, string, string, *time.Time, *string, int) ([]TerminalHistoryRow, error)
	TerminalRecordingEvidence(context.Context, string, int64, string) (string, string, error)
	TerminalAutomationAllowed(context.Context, string) (bool, error)
	TerminalInputPending(context.Context, string) (bool, error)
}
