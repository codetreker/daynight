package session_test

import (
	"context"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"time"
)

type routeDAO struct {
	backend                             *routeBackend
	scope                               *routeCallScope
	LockCredentialFn                    func(context.Context, model.Principal, time.Time) error
	ReadCredentialFn                    func(context.Context, model.Principal, time.Time) error
	ArchiveMetadataFn                   func(context.Context, string) (store.ArchiveMetadata, error)
	ProjectAccessFn                     func(context.Context, string, string) (model.ProjectAccess, error)
	LockTaskFn                          func(context.Context, string, string) (store.SessionTask, error)
	SessionBotIDFn                      func(context.Context, string) (*string, error)
	LockSessionFn                       func(context.Context, string) (store.SessionRecord, error)
	SaveSessionFn                       func(context.Context, store.SessionRecord) error
	LockTaskRegistrationFn              func(context.Context, string, string) error
	LockTestOwnerFn                     func(context.Context, string) error
	FindTaskRegistrationFn              func(context.Context, string, string, string, string) (string, error)
	FindTestRegistrationFn              func(context.Context, string, string, string) (string, *string, error)
	InsertTaskSessionFn                 func(context.Context, store.SessionRegistration) error
	InsertTestSessionFn                 func(context.Context, store.SessionRegistration) error
	InsertBotSessionFn                  func(context.Context, store.SessionRegistration) (bool, error)
	SessionLocationFn                   func(context.Context, string) (store.SessionLocation, error)
	SessionLocationByGrantFn            func(context.Context, []byte) (store.SessionLocation, error)
	CurrentTaskSessionFn                func(context.Context, string, string, string) (string, error)
	SetSessionGrantFn                   func(context.Context, store.SessionGrant) error
	SetSessionGenerationStopFn          func(context.Context, string, []byte) error
	SetTestSessionStopFn                func(context.Context, string, []byte) error
	ConnectSessionFn                    func(context.Context, string, string, time.Time, *time.Time) error
	TouchSessionFn                      func(context.Context, string, time.Time) error
	DisconnectSessionFn                 func(context.Context, string) error
	LockBotSessionsFn                   func(context.Context, string) ([]store.BotSession, error)
	RevokeBotSessionsFn                 func(context.Context, string) error
	LockBotSessionStopFn                func(context.Context, string, string, string) (store.BotSessionStop, error)
	DeleteBotSessionFn                  func(context.Context, string, string) error
	RedactDeletedBotFn                  func(context.Context, string) error
	SessionOperationFn                  func(context.Context, string, string) (store.SessionOperation, error)
	InsertSessionOperationFn            func(context.Context, store.SessionOperation) error
	SetSessionOperationReceiptFn        func(context.Context, sp.Operation) error
	SetSessionOperationEpochFn          func(context.Context, string, string, int64) error
	HasOtherFirstInputFn                func(context.Context, string, string) (bool, error)
	HasInteractionResponseFn            func(context.Context, string, string, string) (bool, error)
	PendingSessionOperationCountFn      func(context.Context, string) (int, error)
	AcceptedSessionOperationsFn         func(context.Context, string) ([]string, error)
	StoppingTestOperationsFn            func(context.Context, string) ([]string, error)
	UnreconciledSessionOperationsFn     func(context.Context, string, int64) ([]string, error)
	UnreconciledSessionOperationCountFn func(context.Context, string, int64) (int, error)
	LockArchiveTaskFn                   func(context.Context, string, string) (store.SessionTask, bool, error)
	SessionArchiveFn                    func(context.Context, string) (sp.ArchiveStatus, string, error)
	SetSessionArchiveStateFn            func(context.Context, string, string, *string) error
	SetSessionArchiveReadyFn            func(context.Context, string, string, int, string) error
	ListTestSessionsFn                  func(context.Context, string, time.Time, int, bool, time.Time, *time.Time, string) ([]store.TestSessionListItem, error)
	LockTerminalFn                      func(context.Context, string) ([]byte, error)
	SaveTerminalFn                      func(context.Context, string, []byte, *time.Time, string) error
	FindTerminalRegistrationFn          func(context.Context, string, string, string, string, string) (string, error)
	InsertTerminalFn                    func(context.Context, store.TerminalRegistration) error
	InsertRecordingEvidenceFn           func(context.Context, string, int64, string, int64, string) error
	TerminalOperationFn                 func(context.Context, string, string) (store.TerminalOperation, error)
	InsertTerminalOperationFn           func(context.Context, store.TerminalOperation) error
	SetTerminalOperationResultFn        func(context.Context, string, v2.OperationResult) error
	InvalidateTerminalOperationsFn      func(context.Context, string) error
	ExpireTerminalOperationsFn          func(context.Context, string, time.Time) error
	QueuedTerminalOperationFn           func(context.Context, string) ([]string, error)
	TerminalViewerOperationPendingFn    func(context.Context, string, string, string) (bool, error)
	TerminalArchiveFn                   func(context.Context, string) (v2.ArchiveStatus, *v2.Receipt, string, error)
	SaveTerminalReceiptFn               func(context.Context, string, v2.Receipt, *string) error
	SaveTerminalArchiveStatusFn         func(context.Context, string, v2.ArchiveStatus) error
	CurrentTerminalSessionFn            func(context.Context, string, string, string) (string, error)
	TerminalHistoryFn                   func(context.Context, string, string, *time.Time, *string, int) ([]store.TerminalHistoryRow, error)
	TerminalRecordingEvidenceFn         func(context.Context, string, int64, string) (string, string, error)
	TerminalAutomationAllowedFn         func(context.Context, string) (bool, error)
	TerminalInputPendingFn              func(context.Context, string) (bool, error)
}

func (d *routeDAO) LockCredential(a0 context.Context, a1 model.Principal, a2 time.Time) error {
	a0 = d.invoke(a0, "LockCredential", d.LockCredentialFn != nil)
	return d.LockCredentialFn(a0, a1, a2)
}

func (d *routeDAO) ReadCredential(a0 context.Context, a1 model.Principal, a2 time.Time) error {
	a0 = d.invoke(a0, "ReadCredential", d.ReadCredentialFn != nil)
	return d.ReadCredentialFn(a0, a1, a2)
}

func (d *routeDAO) ArchiveMetadata(a0 context.Context, a1 string) (store.ArchiveMetadata, error) {
	a0 = d.invoke(a0, "ArchiveMetadata", d.ArchiveMetadataFn != nil)
	return d.ArchiveMetadataFn(a0, a1)
}

func (d *routeDAO) ProjectAccess(a0 context.Context, a1 string, a2 string) (model.ProjectAccess, error) {
	a0 = d.invoke(a0, "ProjectAccess", d.ProjectAccessFn != nil)
	return d.ProjectAccessFn(a0, a1, a2)
}

func (d *routeDAO) LockTask(a0 context.Context, a1 string, a2 string) (store.SessionTask, error) {
	a0 = d.invoke(a0, "LockTask", d.LockTaskFn != nil)
	return d.LockTaskFn(a0, a1, a2)
}

func (d *routeDAO) SessionBotID(a0 context.Context, a1 string) (*string, error) {
	a0 = d.invoke(a0, "SessionBotID", d.SessionBotIDFn != nil)
	return d.SessionBotIDFn(a0, a1)
}

func (d *routeDAO) LockSession(a0 context.Context, a1 string) (store.SessionRecord, error) {
	a0 = d.invoke(a0, "LockSession", d.LockSessionFn != nil)
	return d.LockSessionFn(a0, a1)
}

func (d *routeDAO) SaveSession(a0 context.Context, a1 store.SessionRecord) error {
	a0 = d.invoke(a0, "SaveSession", d.SaveSessionFn != nil)
	return d.SaveSessionFn(a0, a1)
}

func (d *routeDAO) LockTaskRegistration(a0 context.Context, a1 string, a2 string) error {
	a0 = d.invoke(a0, "LockTaskRegistration", d.LockTaskRegistrationFn != nil)
	return d.LockTaskRegistrationFn(a0, a1, a2)
}

func (d *routeDAO) LockTestOwner(a0 context.Context, a1 string) error {
	a0 = d.invoke(a0, "LockTestOwner", d.LockTestOwnerFn != nil)
	return d.LockTestOwnerFn(a0, a1)
}

func (d *routeDAO) FindTaskRegistration(a0 context.Context, a1 string, a2 string, a3 string, a4 string) (string, error) {
	a0 = d.invoke(a0, "FindTaskRegistration", d.FindTaskRegistrationFn != nil)
	return d.FindTaskRegistrationFn(a0, a1, a2, a3, a4)
}

func (d *routeDAO) FindTestRegistration(a0 context.Context, a1 string, a2 string, a3 string) (string, *string, error) {
	a0 = d.invoke(a0, "FindTestRegistration", d.FindTestRegistrationFn != nil)
	return d.FindTestRegistrationFn(a0, a1, a2, a3)
}

func (d *routeDAO) InsertTaskSession(a0 context.Context, a1 store.SessionRegistration) error {
	a0 = d.invoke(a0, "InsertTaskSession", d.InsertTaskSessionFn != nil)
	return d.InsertTaskSessionFn(a0, a1)
}

func (d *routeDAO) InsertTestSession(a0 context.Context, a1 store.SessionRegistration) error {
	a0 = d.invoke(a0, "InsertTestSession", d.InsertTestSessionFn != nil)
	return d.InsertTestSessionFn(a0, a1)
}

func (d *routeDAO) InsertBotSession(a0 context.Context, a1 store.SessionRegistration) (bool, error) {
	a0 = d.invoke(a0, "InsertBotSession", d.InsertBotSessionFn != nil)
	return d.InsertBotSessionFn(a0, a1)
}

func (d *routeDAO) SessionLocation(a0 context.Context, a1 string) (store.SessionLocation, error) {
	a0 = d.invoke(a0, "SessionLocation", d.SessionLocationFn != nil)
	return d.SessionLocationFn(a0, a1)
}

func (d *routeDAO) SessionLocationByGrant(a0 context.Context, a1 []byte) (store.SessionLocation, error) {
	a0 = d.invoke(a0, "SessionLocationByGrant", d.SessionLocationByGrantFn != nil)
	return d.SessionLocationByGrantFn(a0, a1)
}

func (d *routeDAO) CurrentTaskSession(a0 context.Context, a1 string, a2 string, a3 string) (string, error) {
	a0 = d.invoke(a0, "CurrentTaskSession", d.CurrentTaskSessionFn != nil)
	return d.CurrentTaskSessionFn(a0, a1, a2, a3)
}

func (d *routeDAO) SetSessionGrant(a0 context.Context, a1 store.SessionGrant) error {
	a0 = d.invoke(a0, "SetSessionGrant", d.SetSessionGrantFn != nil)
	return d.SetSessionGrantFn(a0, a1)
}

func (d *routeDAO) SetSessionGenerationStop(a0 context.Context, a1 string, a2 []byte) error {
	a0 = d.invoke(a0, "SetSessionGenerationStop", d.SetSessionGenerationStopFn != nil)
	return d.SetSessionGenerationStopFn(a0, a1, a2)
}

func (d *routeDAO) SetTestSessionStop(a0 context.Context, a1 string, a2 []byte) error {
	a0 = d.invoke(a0, "SetTestSessionStop", d.SetTestSessionStopFn != nil)
	return d.SetTestSessionStopFn(a0, a1, a2)
}

func (d *routeDAO) ConnectSession(a0 context.Context, a1 string, a2 string, a3 time.Time, a4 *time.Time) error {
	a0 = d.invoke(a0, "ConnectSession", d.ConnectSessionFn != nil)
	return d.ConnectSessionFn(a0, a1, a2, a3, a4)
}

func (d *routeDAO) TouchSession(a0 context.Context, a1 string, a2 time.Time) error {
	a0 = d.invoke(a0, "TouchSession", d.TouchSessionFn != nil)
	return d.TouchSessionFn(a0, a1, a2)
}

func (d *routeDAO) DisconnectSession(a0 context.Context, a1 string) error {
	a0 = d.invoke(a0, "DisconnectSession", d.DisconnectSessionFn != nil)
	return d.DisconnectSessionFn(a0, a1)
}

func (d *routeDAO) LockBotSessions(a0 context.Context, a1 string) ([]store.BotSession, error) {
	a0 = d.invoke(a0, "LockBotSessions", d.LockBotSessionsFn != nil)
	return d.LockBotSessionsFn(a0, a1)
}

func (d *routeDAO) RevokeBotSessions(a0 context.Context, a1 string) error {
	a0 = d.invoke(a0, "RevokeBotSessions", d.RevokeBotSessionsFn != nil)
	return d.RevokeBotSessionsFn(a0, a1)
}

func (d *routeDAO) LockBotSessionStop(a0 context.Context, a1 string, a2 string, a3 string) (store.BotSessionStop, error) {
	a0 = d.invoke(a0, "LockBotSessionStop", d.LockBotSessionStopFn != nil)
	return d.LockBotSessionStopFn(a0, a1, a2, a3)
}

func (d *routeDAO) DeleteBotSession(a0 context.Context, a1 string, a2 string) error {
	a0 = d.invoke(a0, "DeleteBotSession", d.DeleteBotSessionFn != nil)
	return d.DeleteBotSessionFn(a0, a1, a2)
}

func (d *routeDAO) RedactDeletedBot(a0 context.Context, a1 string) error {
	a0 = d.invoke(a0, "RedactDeletedBot", d.RedactDeletedBotFn != nil)
	return d.RedactDeletedBotFn(a0, a1)
}

func (d *routeDAO) SessionOperation(a0 context.Context, a1 string, a2 string) (store.SessionOperation, error) {
	a0 = d.invoke(a0, "SessionOperation", d.SessionOperationFn != nil)
	return d.SessionOperationFn(a0, a1, a2)
}

func (d *routeDAO) InsertSessionOperation(a0 context.Context, a1 store.SessionOperation) error {
	a0 = d.invoke(a0, "InsertSessionOperation", d.InsertSessionOperationFn != nil)
	return d.InsertSessionOperationFn(a0, a1)
}

func (d *routeDAO) SetSessionOperationReceipt(a0 context.Context, a1 sp.Operation) error {
	a0 = d.invoke(a0, "SetSessionOperationReceipt", d.SetSessionOperationReceiptFn != nil)
	return d.SetSessionOperationReceiptFn(a0, a1)
}

func (d *routeDAO) SetSessionOperationEpoch(a0 context.Context, a1 string, a2 string, a3 int64) error {
	a0 = d.invoke(a0, "SetSessionOperationEpoch", d.SetSessionOperationEpochFn != nil)
	return d.SetSessionOperationEpochFn(a0, a1, a2, a3)
}

func (d *routeDAO) HasOtherFirstInput(a0 context.Context, a1 string, a2 string) (bool, error) {
	a0 = d.invoke(a0, "HasOtherFirstInput", d.HasOtherFirstInputFn != nil)
	return d.HasOtherFirstInputFn(a0, a1, a2)
}

func (d *routeDAO) HasInteractionResponse(a0 context.Context, a1 string, a2 string, a3 string) (bool, error) {
	a0 = d.invoke(a0, "HasInteractionResponse", d.HasInteractionResponseFn != nil)
	return d.HasInteractionResponseFn(a0, a1, a2, a3)
}

func (d *routeDAO) PendingSessionOperationCount(a0 context.Context, a1 string) (int, error) {
	a0 = d.invoke(a0, "PendingSessionOperationCount", d.PendingSessionOperationCountFn != nil)
	return d.PendingSessionOperationCountFn(a0, a1)
}

func (d *routeDAO) AcceptedSessionOperations(a0 context.Context, a1 string) ([]string, error) {
	a0 = d.invoke(a0, "AcceptedSessionOperations", d.AcceptedSessionOperationsFn != nil)
	return d.AcceptedSessionOperationsFn(a0, a1)
}

func (d *routeDAO) StoppingTestOperations(a0 context.Context, a1 string) ([]string, error) {
	a0 = d.invoke(a0, "StoppingTestOperations", d.StoppingTestOperationsFn != nil)
	return d.StoppingTestOperationsFn(a0, a1)
}

func (d *routeDAO) UnreconciledSessionOperations(a0 context.Context, a1 string, a2 int64) ([]string, error) {
	a0 = d.invoke(a0, "UnreconciledSessionOperations", d.UnreconciledSessionOperationsFn != nil)
	return d.UnreconciledSessionOperationsFn(a0, a1, a2)
}

func (d *routeDAO) UnreconciledSessionOperationCount(a0 context.Context, a1 string, a2 int64) (int, error) {
	a0 = d.invoke(a0, "UnreconciledSessionOperationCount", d.UnreconciledSessionOperationCountFn != nil)
	return d.UnreconciledSessionOperationCountFn(a0, a1, a2)
}

func (d *routeDAO) LockArchiveTask(a0 context.Context, a1 string, a2 string) (store.SessionTask, bool, error) {
	a0 = d.invoke(a0, "LockArchiveTask", d.LockArchiveTaskFn != nil)
	return d.LockArchiveTaskFn(a0, a1, a2)
}

func (d *routeDAO) SessionArchive(a0 context.Context, a1 string) (sp.ArchiveStatus, string, error) {
	a0 = d.invoke(a0, "SessionArchive", d.SessionArchiveFn != nil)
	return d.SessionArchiveFn(a0, a1)
}

func (d *routeDAO) SetSessionArchiveState(a0 context.Context, a1 string, a2 string, a3 *string) error {
	a0 = d.invoke(a0, "SetSessionArchiveState", d.SetSessionArchiveStateFn != nil)
	return d.SetSessionArchiveStateFn(a0, a1, a2, a3)
}

func (d *routeDAO) SetSessionArchiveReady(a0 context.Context, a1 string, a2 string, a3 int, a4 string) error {
	a0 = d.invoke(a0, "SetSessionArchiveReady", d.SetSessionArchiveReadyFn != nil)
	return d.SetSessionArchiveReadyFn(a0, a1, a2, a3, a4)
}

func (d *routeDAO) ListTestSessions(a0 context.Context, a1 string, a2 time.Time, a3 int, a4 bool, a5 time.Time, a6 *time.Time, a7 string) ([]store.TestSessionListItem, error) {
	a0 = d.invoke(a0, "ListTestSessions", d.ListTestSessionsFn != nil)
	return d.ListTestSessionsFn(a0, a1, a2, a3, a4, a5, a6, a7)
}

func (d *routeDAO) LockTerminal(a0 context.Context, a1 string) ([]byte, error) {
	a0 = d.invoke(a0, "LockTerminal", d.LockTerminalFn != nil)
	return d.LockTerminalFn(a0, a1)
}

func (d *routeDAO) SaveTerminal(a0 context.Context, a1 string, a2 []byte, a3 *time.Time, a4 string) error {
	a0 = d.invoke(a0, "SaveTerminal", d.SaveTerminalFn != nil)
	return d.SaveTerminalFn(a0, a1, a2, a3, a4)
}

func (d *routeDAO) FindTerminalRegistration(a0 context.Context, a1 string, a2 string, a3 string, a4 string, a5 string) (string, error) {
	a0 = d.invoke(a0, "FindTerminalRegistration", d.FindTerminalRegistrationFn != nil)
	return d.FindTerminalRegistrationFn(a0, a1, a2, a3, a4, a5)
}

func (d *routeDAO) InsertTerminal(a0 context.Context, a1 store.TerminalRegistration) error {
	a0 = d.invoke(a0, "InsertTerminal", d.InsertTerminalFn != nil)
	return d.InsertTerminalFn(a0, a1)
}

func (d *routeDAO) InsertRecordingEvidence(a0 context.Context, a1 string, a2 int64, a3 string, a4 int64, a5 string) error {
	a0 = d.invoke(a0, "InsertRecordingEvidence", d.InsertRecordingEvidenceFn != nil)
	return d.InsertRecordingEvidenceFn(a0, a1, a2, a3, a4, a5)
}

func (d *routeDAO) TerminalOperation(a0 context.Context, a1 string, a2 string) (store.TerminalOperation, error) {
	a0 = d.invoke(a0, "TerminalOperation", d.TerminalOperationFn != nil)
	return d.TerminalOperationFn(a0, a1, a2)
}

func (d *routeDAO) InsertTerminalOperation(a0 context.Context, a1 store.TerminalOperation) error {
	a0 = d.invoke(a0, "InsertTerminalOperation", d.InsertTerminalOperationFn != nil)
	return d.InsertTerminalOperationFn(a0, a1)
}

func (d *routeDAO) SetTerminalOperationResult(a0 context.Context, a1 string, a2 v2.OperationResult) error {
	a0 = d.invoke(a0, "SetTerminalOperationResult", d.SetTerminalOperationResultFn != nil)
	return d.SetTerminalOperationResultFn(a0, a1, a2)
}

func (d *routeDAO) InvalidateTerminalOperations(a0 context.Context, a1 string) error {
	a0 = d.invoke(a0, "InvalidateTerminalOperations", d.InvalidateTerminalOperationsFn != nil)
	return d.InvalidateTerminalOperationsFn(a0, a1)
}

func (d *routeDAO) ExpireTerminalOperations(a0 context.Context, a1 string, a2 time.Time) error {
	a0 = d.invoke(a0, "ExpireTerminalOperations", d.ExpireTerminalOperationsFn != nil)
	return d.ExpireTerminalOperationsFn(a0, a1, a2)
}

func (d *routeDAO) QueuedTerminalOperation(a0 context.Context, a1 string) ([]string, error) {
	a0 = d.invoke(a0, "QueuedTerminalOperation", d.QueuedTerminalOperationFn != nil)
	return d.QueuedTerminalOperationFn(a0, a1)
}

func (d *routeDAO) TerminalViewerOperationPending(a0 context.Context, a1 string, a2 string, a3 string) (bool, error) {
	a0 = d.invoke(a0, "TerminalViewerOperationPending", d.TerminalViewerOperationPendingFn != nil)
	return d.TerminalViewerOperationPendingFn(a0, a1, a2, a3)
}

func (d *routeDAO) TerminalArchive(a0 context.Context, a1 string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
	a0 = d.invoke(a0, "TerminalArchive", d.TerminalArchiveFn != nil)
	return d.TerminalArchiveFn(a0, a1)
}

func (d *routeDAO) SaveTerminalReceipt(a0 context.Context, a1 string, a2 v2.Receipt, a3 *string) error {
	a0 = d.invoke(a0, "SaveTerminalReceipt", d.SaveTerminalReceiptFn != nil)
	return d.SaveTerminalReceiptFn(a0, a1, a2, a3)
}

func (d *routeDAO) SaveTerminalArchiveStatus(a0 context.Context, a1 string, a2 v2.ArchiveStatus) error {
	a0 = d.invoke(a0, "SaveTerminalArchiveStatus", d.SaveTerminalArchiveStatusFn != nil)
	return d.SaveTerminalArchiveStatusFn(a0, a1, a2)
}

func (d *routeDAO) CurrentTerminalSession(a0 context.Context, a1 string, a2 string, a3 string) (string, error) {
	a0 = d.invoke(a0, "CurrentTerminalSession", d.CurrentTerminalSessionFn != nil)
	return d.CurrentTerminalSessionFn(a0, a1, a2, a3)
}

func (d *routeDAO) TerminalHistory(a0 context.Context, a1 string, a2 string, a3 *time.Time, a4 *string, a5 int) ([]store.TerminalHistoryRow, error) {
	a0 = d.invoke(a0, "TerminalHistory", d.TerminalHistoryFn != nil)
	return d.TerminalHistoryFn(a0, a1, a2, a3, a4, a5)
}

func (d *routeDAO) TerminalRecordingEvidence(a0 context.Context, a1 string, a2 int64, a3 string) (string, string, error) {
	a0 = d.invoke(a0, "TerminalRecordingEvidence", d.TerminalRecordingEvidenceFn != nil)
	return d.TerminalRecordingEvidenceFn(a0, a1, a2, a3)
}

func (d *routeDAO) TerminalAutomationAllowed(a0 context.Context, a1 string) (bool, error) {
	a0 = d.invoke(a0, "TerminalAutomationAllowed", d.TerminalAutomationAllowedFn != nil)
	return d.TerminalAutomationAllowedFn(a0, a1)
}

func (d *routeDAO) TerminalInputPending(a0 context.Context, a1 string) (bool, error) {
	a0 = d.invoke(a0, "TerminalInputPending", d.TerminalInputPendingFn != nil)
	return d.TerminalInputPendingFn(a0, a1)
}

func (d *routeDAO) invoke(ctx context.Context, name string, configured bool) context.Context {
	if d.scope == nil {
		d.backend.fail(fmt.Errorf("route DAO accessed outside callback: %s", name))
	}
	return d.scope.invoke(ctx, name, configured)
}
