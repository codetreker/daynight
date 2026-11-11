package server

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"testing"
	"time"
)

type sessionHTTPRejectedDAO struct{ t *testing.T }

func (d sessionHTTPRejectedDAO) LockOAuthCredential(context.Context, model.Principal, string, string, time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.LockOAuthCredential")
	panic("unconfigured SessionDAO.LockOAuthCredential")
}

func (d sessionHTTPRejectedDAO) LockCredential(a0 context.Context, a1 model.Principal, a2 time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.LockCredential")
	panic("unconfigured SessionDAO.LockCredential")
}

func (d sessionHTTPRejectedDAO) ReadCredential(a0 context.Context, a1 model.Principal, a2 time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.ReadCredential")
	panic("unconfigured SessionDAO.ReadCredential")
}

func (d sessionHTTPRejectedDAO) ArchiveMetadata(a0 context.Context, a1 string) (store.ArchiveMetadata, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.ArchiveMetadata")
	panic("unconfigured SessionDAO.ArchiveMetadata")
}

func (d sessionHTTPRejectedDAO) ProjectAccess(a0 context.Context, a1 string, a2 string) (model.ProjectAccess, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.ProjectAccess")
	panic("unconfigured SessionDAO.ProjectAccess")
}

func (d sessionHTTPRejectedDAO) LockTask(a0 context.Context, a1 string, a2 string) (store.SessionTask, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockTask")
	panic("unconfigured SessionDAO.LockTask")
}

func (d sessionHTTPRejectedDAO) SessionBotID(a0 context.Context, a1 string) (*string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.SessionBotID")
	panic("unconfigured SessionDAO.SessionBotID")
}

func (d sessionHTTPRejectedDAO) LockSession(a0 context.Context, a1 string) (store.SessionRecord, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockSession")
	panic("unconfigured SessionDAO.LockSession")
}

func (d sessionHTTPRejectedDAO) SaveSession(a0 context.Context, a1 store.SessionRecord) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SaveSession")
	panic("unconfigured SessionDAO.SaveSession")
}

func (d sessionHTTPRejectedDAO) LockTaskRegistration(a0 context.Context, a1 string, a2 string) (store.SessionTask, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockTaskRegistration")
	panic("unconfigured SessionDAO.LockTaskRegistration")
}

func (d sessionHTTPRejectedDAO) LockTestOwner(a0 context.Context, a1 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.LockTestOwner")
	panic("unconfigured SessionDAO.LockTestOwner")
}

func (d sessionHTTPRejectedDAO) FindTaskRegistration(a0 context.Context, a1 string, a2 string, a3 string, a4 string) (string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.FindTaskRegistration")
	panic("unconfigured SessionDAO.FindTaskRegistration")
}

func (d sessionHTTPRejectedDAO) FindTestRegistration(a0 context.Context, a1 string, a2 string, a3 string) (string, *string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.FindTestRegistration")
	panic("unconfigured SessionDAO.FindTestRegistration")
}

func (d sessionHTTPRejectedDAO) InsertTaskSession(a0 context.Context, a1 store.SessionRegistration) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertTaskSession")
	panic("unconfigured SessionDAO.InsertTaskSession")
}

func (d sessionHTTPRejectedDAO) InsertTestSession(a0 context.Context, a1 store.SessionRegistration) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertTestSession")
	panic("unconfigured SessionDAO.InsertTestSession")
}

func (d sessionHTTPRejectedDAO) InsertBotSession(a0 context.Context, a1 store.SessionRegistration) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertBotSession")
	panic("unconfigured SessionDAO.InsertBotSession")
}

func (d sessionHTTPRejectedDAO) SessionLocation(a0 context.Context, a1 string) (store.SessionLocation, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.SessionLocation")
	panic("unconfigured SessionDAO.SessionLocation")
}

func (d sessionHTTPRejectedDAO) SessionLocationByGrant(a0 context.Context, a1 []byte) (store.SessionLocation, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.SessionLocationByGrant")
	panic("unconfigured SessionDAO.SessionLocationByGrant")
}

func (d sessionHTTPRejectedDAO) CurrentTaskSession(a0 context.Context, a1 string, a2 string, a3 string) (string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.CurrentTaskSession")
	panic("unconfigured SessionDAO.CurrentTaskSession")
}

func (d sessionHTTPRejectedDAO) SetSessionGrant(a0 context.Context, a1 store.SessionGrant) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionGrant")
	panic("unconfigured SessionDAO.SetSessionGrant")
}

func (d sessionHTTPRejectedDAO) SetSessionGenerationStop(a0 context.Context, a1 string, a2 []byte) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionGenerationStop")
	panic("unconfigured SessionDAO.SetSessionGenerationStop")
}

func (d sessionHTTPRejectedDAO) SetTestSessionStop(a0 context.Context, a1 string, a2 []byte) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetTestSessionStop")
	panic("unconfigured SessionDAO.SetTestSessionStop")
}

func (d sessionHTTPRejectedDAO) ConnectSession(a0 context.Context, a1 string, a2 string, a3 time.Time, a4 *time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.ConnectSession")
	panic("unconfigured SessionDAO.ConnectSession")
}

func (d sessionHTTPRejectedDAO) TouchSession(a0 context.Context, a1 string, a2 time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.TouchSession")
	panic("unconfigured SessionDAO.TouchSession")
}

func (d sessionHTTPRejectedDAO) DisconnectSession(a0 context.Context, a1 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.DisconnectSession")
	panic("unconfigured SessionDAO.DisconnectSession")
}

func (d sessionHTTPRejectedDAO) LockBotSessions(a0 context.Context, a1 string) ([]store.BotSession, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockBotSessions")
	panic("unconfigured SessionDAO.LockBotSessions")
}

func (d sessionHTTPRejectedDAO) RevokeBotSessions(a0 context.Context, a1 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.RevokeBotSessions")
	panic("unconfigured SessionDAO.RevokeBotSessions")
}

func (d sessionHTTPRejectedDAO) LockBotSessionStop(a0 context.Context, a1 string, a2 string, a3 string) (store.BotSessionStop, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockBotSessionStop")
	panic("unconfigured SessionDAO.LockBotSessionStop")
}

func (d sessionHTTPRejectedDAO) DeleteBotSession(a0 context.Context, a1 string, a2 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.DeleteBotSession")
	panic("unconfigured SessionDAO.DeleteBotSession")
}

func (d sessionHTTPRejectedDAO) RedactDeletedBot(a0 context.Context, a1 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.RedactDeletedBot")
	panic("unconfigured SessionDAO.RedactDeletedBot")
}

func (d sessionHTTPRejectedDAO) SessionOperation(a0 context.Context, a1 string, a2 string) (store.SessionOperation, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.SessionOperation")
	panic("unconfigured SessionDAO.SessionOperation")
}

func (d sessionHTTPRejectedDAO) InsertSessionOperation(a0 context.Context, a1 store.SessionOperation) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertSessionOperation")
	panic("unconfigured SessionDAO.InsertSessionOperation")
}

func (d sessionHTTPRejectedDAO) SetSessionOperationReceipt(a0 context.Context, a1 sp.Operation) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionOperationReceipt")
	panic("unconfigured SessionDAO.SetSessionOperationReceipt")
}

func (d sessionHTTPRejectedDAO) SetSessionOperationEpoch(a0 context.Context, a1 string, a2 string, a3 int64) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionOperationEpoch")
	panic("unconfigured SessionDAO.SetSessionOperationEpoch")
}

func (d sessionHTTPRejectedDAO) HasOtherFirstInput(a0 context.Context, a1 string, a2 string) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.HasOtherFirstInput")
	panic("unconfigured SessionDAO.HasOtherFirstInput")
}

func (d sessionHTTPRejectedDAO) HasInteractionResponse(a0 context.Context, a1 string, a2 string, a3 string) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.HasInteractionResponse")
	panic("unconfigured SessionDAO.HasInteractionResponse")
}

func (d sessionHTTPRejectedDAO) PendingSessionOperationCount(a0 context.Context, a1 string) (int, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.PendingSessionOperationCount")
	panic("unconfigured SessionDAO.PendingSessionOperationCount")
}

func (d sessionHTTPRejectedDAO) AcceptedSessionOperations(a0 context.Context, a1 string) ([]string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.AcceptedSessionOperations")
	panic("unconfigured SessionDAO.AcceptedSessionOperations")
}

func (d sessionHTTPRejectedDAO) StoppingTestOperations(a0 context.Context, a1 string) ([]string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.StoppingTestOperations")
	panic("unconfigured SessionDAO.StoppingTestOperations")
}

func (d sessionHTTPRejectedDAO) UnreconciledSessionOperations(a0 context.Context, a1 string, a2 int64) ([]string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.UnreconciledSessionOperations")
	panic("unconfigured SessionDAO.UnreconciledSessionOperations")
}

func (d sessionHTTPRejectedDAO) UnreconciledSessionOperationCount(a0 context.Context, a1 string, a2 int64) (int, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.UnreconciledSessionOperationCount")
	panic("unconfigured SessionDAO.UnreconciledSessionOperationCount")
}

func (d sessionHTTPRejectedDAO) LockArchiveTask(a0 context.Context, a1 string, a2 string) (store.SessionTask, bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockArchiveTask")
	panic("unconfigured SessionDAO.LockArchiveTask")
}

func (d sessionHTTPRejectedDAO) SessionArchive(a0 context.Context, a1 string) (sp.ArchiveStatus, string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.SessionArchive")
	panic("unconfigured SessionDAO.SessionArchive")
}

func (d sessionHTTPRejectedDAO) SetSessionArchiveState(a0 context.Context, a1 string, a2 string, a3 *string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionArchiveState")
	panic("unconfigured SessionDAO.SetSessionArchiveState")
}

func (d sessionHTTPRejectedDAO) SetSessionArchiveReady(a0 context.Context, a1 string, a2 string, a3 int, a4 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionArchiveReady")
	panic("unconfigured SessionDAO.SetSessionArchiveReady")
}

func (d sessionHTTPRejectedDAO) ListTestSessions(a0 context.Context, a1 string, a2 time.Time, a3 int, a4 bool, a5 time.Time, a6 *time.Time, a7 string) ([]store.TestSessionListItem, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.ListTestSessions")
	panic("unconfigured SessionDAO.ListTestSessions")
}

func (d sessionHTTPRejectedDAO) LockTerminal(a0 context.Context, a1 string) ([]byte, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockTerminal")
	panic("unconfigured SessionDAO.LockTerminal")
}

func (d sessionHTTPRejectedDAO) SaveTerminal(a0 context.Context, a1 string, a2 []byte, a3 *time.Time, a4 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SaveTerminal")
	panic("unconfigured SessionDAO.SaveTerminal")
}

func (d sessionHTTPRejectedDAO) FindTerminalRegistration(a0 context.Context, a1 string, a2 string, a3 string, a4 string, a5 string) (string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.FindTerminalRegistration")
	panic("unconfigured SessionDAO.FindTerminalRegistration")
}

func (d sessionHTTPRejectedDAO) InsertTerminal(a0 context.Context, a1 store.TerminalRegistration) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertTerminal")
	panic("unconfigured SessionDAO.InsertTerminal")
}

func (d sessionHTTPRejectedDAO) InsertRecordingEvidence(a0 context.Context, a1 string, a2 int64, a3 string, a4 int64, a5 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertRecordingEvidence")
	panic("unconfigured SessionDAO.InsertRecordingEvidence")
}

func (d sessionHTTPRejectedDAO) TerminalOperation(a0 context.Context, a1 string, a2 string) (store.TerminalOperation, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalOperation")
	panic("unconfigured SessionDAO.TerminalOperation")
}

func (d sessionHTTPRejectedDAO) InsertTerminalOperation(a0 context.Context, a1 store.TerminalOperation) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertTerminalOperation")
	panic("unconfigured SessionDAO.InsertTerminalOperation")
}

func (d sessionHTTPRejectedDAO) SetTerminalOperationResult(a0 context.Context, a1 string, a2 v2.OperationResult) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetTerminalOperationResult")
	panic("unconfigured SessionDAO.SetTerminalOperationResult")
}

func (d sessionHTTPRejectedDAO) InvalidateTerminalOperations(a0 context.Context, a1 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InvalidateTerminalOperations")
	panic("unconfigured SessionDAO.InvalidateTerminalOperations")
}

func (d sessionHTTPRejectedDAO) ExpireTerminalOperations(a0 context.Context, a1 string, a2 time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.ExpireTerminalOperations")
	panic("unconfigured SessionDAO.ExpireTerminalOperations")
}

func (d sessionHTTPRejectedDAO) QueuedTerminalOperation(a0 context.Context, a1 string) ([]string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.QueuedTerminalOperation")
	panic("unconfigured SessionDAO.QueuedTerminalOperation")
}

func (d sessionHTTPRejectedDAO) TerminalViewerOperationPending(a0 context.Context, a1 string, a2 string, a3 string) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalViewerOperationPending")
	panic("unconfigured SessionDAO.TerminalViewerOperationPending")
}

func (d sessionHTTPRejectedDAO) TerminalArchive(a0 context.Context, a1 string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalArchive")
	panic("unconfigured SessionDAO.TerminalArchive")
}

func (d sessionHTTPRejectedDAO) SaveTerminalReceipt(a0 context.Context, a1 string, a2 v2.Receipt, a3 *string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SaveTerminalReceipt")
	panic("unconfigured SessionDAO.SaveTerminalReceipt")
}

func (d sessionHTTPRejectedDAO) SaveTerminalArchiveStatus(a0 context.Context, a1 string, a2 v2.ArchiveStatus) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SaveTerminalArchiveStatus")
	panic("unconfigured SessionDAO.SaveTerminalArchiveStatus")
}

func (d sessionHTTPRejectedDAO) CurrentTerminalSession(a0 context.Context, a1 string, a2 string, a3 string) (string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.CurrentTerminalSession")
	panic("unconfigured SessionDAO.CurrentTerminalSession")
}

func (d sessionHTTPRejectedDAO) TerminalHistory(a0 context.Context, a1 string, a2 string, a3 *time.Time, a4 *string, a5 int) ([]store.TerminalHistoryRow, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalHistory")
	panic("unconfigured SessionDAO.TerminalHistory")
}

func (d sessionHTTPRejectedDAO) TerminalRecordingEvidence(a0 context.Context, a1 string, a2 int64, a3 string) (string, string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalRecordingEvidence")
	panic("unconfigured SessionDAO.TerminalRecordingEvidence")
}

func (d sessionHTTPRejectedDAO) TerminalAutomationAllowed(a0 context.Context, a1 string) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalAutomationAllowed")
	panic("unconfigured SessionDAO.TerminalAutomationAllowed")
}

func (d sessionHTTPRejectedDAO) TerminalInputPending(a0 context.Context, a1 string) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalInputPending")
	panic("unconfigured SessionDAO.TerminalInputPending")
}

var _ store.SessionDAO = sessionHTTPRejectedDAO{}

type sessionHTTPRejectedBotDAO struct{ t *testing.T }

func (d sessionHTTPRejectedBotDAO) Credential(context.Context, model.Principal) error {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.Credential")
	panic("unconfigured BotDAO.Credential")
}

func (d sessionHTTPRejectedBotDAO) Worker(context.Context, string, string) error {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.Worker")
	panic("unconfigured BotDAO.Worker")
}

func (d sessionHTTPRejectedBotDAO) LockCreation(context.Context, string) error {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.LockCreation")
	panic("unconfigured BotDAO.LockCreation")
}

func (d sessionHTTPRejectedBotDAO) Bot(context.Context, string) (model.Bot, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.Bot")
	panic("unconfigured BotDAO.Bot")
}

func (d sessionHTTPRejectedBotDAO) BotDefaults(context.Context, string) (model.BotDefaultsInput, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BotDefaults")
	panic("unconfigured BotDAO.BotDefaults")
}

func (d sessionHTTPRejectedBotDAO) InsertBot(context.Context, model.Bot) error {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.InsertBot")
	panic("unconfigured BotDAO.InsertBot")
}

func (d sessionHTTPRejectedBotDAO) SaveBotDeletion(context.Context, string, *model.BotDeletion) (model.Bot, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.SaveBotDeletion")
	panic("unconfigured BotDAO.SaveBotDeletion")
}

func (d sessionHTTPRejectedBotDAO) BindBotSession(context.Context, string, int64, string, model.BotRoleConfiguration) (model.Bot, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BindBotSession")
	panic("unconfigured BotDAO.BindBotSession")
}

func (d sessionHTTPRejectedBotDAO) SetBotStartup(context.Context, string, int64, model.BotStartupResult) (model.Bot, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.SetBotStartup")
	panic("unconfigured BotDAO.SetBotStartup")
}

func (d sessionHTTPRejectedBotDAO) CommitBotPreferences(context.Context, string) error {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.CommitBotPreferences")
	panic("unconfigured BotDAO.CommitBotPreferences")
}

func (d sessionHTTPRejectedBotDAO) BotPreferredWorker(context.Context, string) (*string, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BotPreferredWorker")
	panic("unconfigured BotDAO.BotPreferredWorker")
}

func (d sessionHTTPRejectedBotDAO) BotCreationCandidate(context.Context, string, string) (model.BotDefaultsInput, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BotCreationCandidate")
	panic("unconfigured BotDAO.BotCreationCandidate")
}

func (d sessionHTTPRejectedBotDAO) BotCreationCandidates(context.Context, string) (model.BotDefaultsInput, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BotCreationCandidates")
	panic("unconfigured BotDAO.BotCreationCandidates")
}

func (d sessionHTTPRejectedBotDAO) BotCreationWorker(context.Context, string, string) (model.BotDefaultsInput, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BotCreationWorker")
	panic("unconfigured BotDAO.BotCreationWorker")
}

var _ store.BotWriteDAO = sessionHTTPRejectedBotDAO{}
