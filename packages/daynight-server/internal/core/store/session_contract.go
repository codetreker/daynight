package store

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

// ErrSessionProjectNotFound identifies a tombstoned project in scoped Session access.
var ErrSessionProjectNotFound = errors.New("session project not found")

// SessionWriter binds all Session and Bot operations to one transaction. The
// scope and its DAOs are valid only until the callback returns.
type SessionWriter interface {
	WriteSession(context.Context, func(SessionScope) error) (Completion, error)
}

type SessionScope interface {
	SessionDAO() SessionDAO
	BotDAO() BotWriteDAO
}

// SessionRecord contains only durable ledger state; transient content remains
// owned by the Session engine.
type SessionRecord struct {
	BotID                                               *string
	ServerInstance                                      *string
	FirstInputBlocked                                   bool
	DrainTimelineSeq                                    *int64
	Snapshot                                            sp.Snapshot
	Owner, Parent, ConnectionParent                     string
	Registration, StopProof                             []byte
	SourceEpoch                                         *string
	SourceEpochs                                        []string
	SourceSeq, OperationSeq                             int64
	GrantHash                                           []byte
	GrantExpiry, ConnectionExpiry, LastSeen, DrainUntil *time.Time
	GrantKind                                           string
	Consumed                                            bool
}

type SessionLocation struct {
	ProjectID, TaskID, SessionID string
}

// SessionRegistration contains the immutable registration and initial snapshot.
type SessionRegistration struct {
	Location                                                              SessionLocation
	ClaimID, OwnerID, RegistrationID, TestExecutionID, ParentCredentialID string
	BotID                                                                 *string
	Registration                                                          []byte
	Snapshot                                                              sp.Snapshot
}

type SessionGrant struct {
	SessionID                string
	Hash                     []byte
	ExpiresAt                time.Time
	Kind, ParentCredentialID string
}

type SessionOperation struct {
	SessionID, OperationID string
	Command                sp.Command
	Receipt                sp.Operation
	Actor                  model.Principal
	Hash                   []byte
	Epoch                  *int64
	Seq                    int64
	Deadline               time.Time
}

type TerminalOperation struct {
	SessionID, OperationID string
	Command                []byte
	Result                 v2.OperationResult
	Actor                  model.Principal
	Hash                   []byte
	Epoch                  *int64
	Seq                    int64
	Deadline               time.Time
}

type TerminalRegistration struct {
	SessionID, ProjectID, TaskID, ClaimID, OwnerID, RegistrationID string
	Registration, State                                            []byte
	LastSeen                                                       time.Time
	ServerInstance                                                 string
}

type BotSession struct {
	ID, Owner, Scope, Backend string
}

type BotSessionStop struct {
	Snapshot    sp.Snapshot
	Consumed    bool
	SourceEpoch *string
}

type TestSessionListItem struct {
	Snapshot             sp.Snapshot
	CreatedAt, UpdatedAt time.Time
	LastSeen, DrainUntil *time.Time
}

type SessionTask struct {
	Worker        *model.WorkerClaim
	Type          model.TaskType
	Deleted       bool
	Status        string
	StartupReport *sp.StartupReport
}

// ArchiveMetadata is an unlocked snapshot used only to select an archive permit.
// The actual archive operation must recheck all authority under its normal locks.
type ArchiveMetadata struct {
	Owner, Parent, Project, Task, Backend                string
	Test, TaskExists, TaskDeleted, ProjectLive, BotValid bool
}

// SessionDAO methods operate on the transaction supplied by SessionWriter.
// Callers acquire credential, Task and Bot locks before related Session locks.
type SessionDAO interface {
	LockCredential(context.Context, model.Principal, time.Time) error
	LockOAuthCredential(context.Context, model.Principal, []OAuthBinding, time.Time) error
	ReadOAuthCredential(context.Context, model.Principal, []OAuthBinding, time.Time) error
	ReadCredential(context.Context, model.Principal, time.Time) error
	ArchiveMetadata(context.Context, string) (ArchiveMetadata, error)
	ProjectAccess(context.Context, string, string) (model.ProjectAccess, error)
	LockTask(context.Context, string, string) (SessionTask, error)
	SessionBotID(context.Context, string) (*string, error)
	LockSession(context.Context, string) (SessionRecord, error)
	SaveSession(context.Context, SessionRecord) error
	LockTaskRegistration(context.Context, string, string) (SessionTask, error)
	LockTestOwner(context.Context, string) error
	FindTaskRegistration(context.Context, string, string, string, string) (string, error)
	FindTestRegistration(context.Context, string, string, string) (string, *string, error)
	InsertTaskSession(context.Context, SessionRegistration) error
	InsertTestSession(context.Context, SessionRegistration) error
	InsertBotSession(context.Context, SessionRegistration) (bool, error)
	SessionLocation(context.Context, string) (SessionLocation, error)
	SessionLocationByGrant(context.Context, []byte) (SessionLocation, error)
	CurrentTaskSession(context.Context, string, string, string) (string, error)
	SetSessionGrant(context.Context, SessionGrant) error
	SetSessionGenerationStop(context.Context, string, []byte) error
	SetTestSessionStop(context.Context, string, []byte) error
	ConnectSession(context.Context, string, string, time.Time, *time.Time) error
	TouchSession(context.Context, string, time.Time) error
	DisconnectSession(context.Context, string) error
	LockBotSessions(context.Context, string) ([]BotSession, error)
	RevokeBotSessions(context.Context, string) error
	LockBotSessionStop(context.Context, string, string, string) (BotSessionStop, error)
	DeleteBotSession(context.Context, string, string) error
	RedactDeletedBot(context.Context, string) error
	SessionOperation(context.Context, string, string) (SessionOperation, error)
	InsertSessionOperation(context.Context, SessionOperation) error
	SetSessionOperationReceipt(context.Context, sp.Operation) error
	SetSessionOperationEpoch(context.Context, string, string, int64) error
	HasOtherFirstInput(context.Context, string, string) (bool, error)
	HasInteractionResponse(context.Context, string, string, string) (bool, error)
	PendingSessionOperationCount(context.Context, string) (int, error)
	AcceptedSessionOperations(context.Context, string) ([]string, error)
	StoppingTestOperations(context.Context, string) ([]string, error)
	UnreconciledSessionOperations(context.Context, string, int64) ([]string, error)
	UnreconciledSessionOperationCount(context.Context, string, int64) (int, error)
	LockArchiveTask(context.Context, string, string) (SessionTask, bool, error)
	SessionArchive(context.Context, string) (sp.ArchiveStatus, string, error)
	SetSessionArchiveState(context.Context, string, string, *string) error
	SetSessionArchiveReady(context.Context, string, string, int, string) error
	ListTestSessions(context.Context, string, time.Time, int, bool, time.Time, *time.Time, string) ([]TestSessionListItem, error)
	TerminalArchiveHistoryDAO
	LockTerminal(context.Context, string) ([]byte, error)
	SaveTerminal(context.Context, string, []byte, *time.Time, string) error
	FindTerminalRegistration(context.Context, string, string, string, string, string) (string, error)
	InsertTerminal(context.Context, TerminalRegistration) error
	InsertRecordingEvidence(context.Context, string, int64, string, int64, string) error
	TerminalOperation(context.Context, string, string) (TerminalOperation, error)
	InsertTerminalOperation(context.Context, TerminalOperation) error
	SetTerminalOperationResult(context.Context, string, v2.OperationResult) error
	InvalidateTerminalOperations(context.Context, string) error
	ExpireTerminalOperations(context.Context, string, time.Time) error
	QueuedTerminalOperation(context.Context, string) ([]string, error)
	TerminalViewerOperationPending(context.Context, string, string, string) (bool, error)
}
