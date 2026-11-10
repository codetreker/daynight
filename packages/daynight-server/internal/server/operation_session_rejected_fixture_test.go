package server

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"io"
	"testing"
)

func rejectedOperationHTTPSessions(t *testing.T) sessionhttp.Operations {
	return sessionhttp.Operations{
		GetImageOccurrence: func(context.Context, model.Principal, string, string, string, string) (sp.ImageOccurrenceStatus, error) {
			unexpectedHTTPCall(t, "Session.GetImageOccurrence")
			panic("unreachable")
		},
		RetryImageOccurrence: func(context.Context, model.Principal, string, string, string, string) (sp.ImageOccurrenceRetryReceipt, error) {
			unexpectedHTTPCall(t, "Session.RetryImageOccurrence")
			panic("unreachable")
		},
		BeginHistoryLedgerReserved: func(context.Context, string, string, string, sessioncore.ActiveHistoryWriter, io.Closer) (sessionhttp.ArchiveOperation, error) {
			unexpectedHTTPCall(t, "Session.BeginHistoryLedgerReserved")
			panic("unreachable")
		},
		ArchivePreparation: func(context.Context, model.Principal, string, string, string) (sp.ArchivePrepareReceipt, error) {
			unexpectedHTTPCall(t, "Session.ArchivePreparation")
			panic("unreachable")
		},
		ArchiveFileStatus: func(context.Context, model.Principal, string, string, string, string) (sp.ArchiveFileReceipt, error) {
			unexpectedHTTPCall(t, "Session.ArchiveFileStatus")
			panic("unreachable")
		},
		ArchiveTimelineContentReserved: func(context.Context, model.Principal, string, string, string, string, io.Closer) (sessionhttp.ArchiveContent, error) {
			unexpectedHTTPCall(t, "Session.ArchiveTimelineContentReserved")
			panic("unreachable")
		},
		PrepareUpload: func(context.Context, model.Principal, string, string, string, sp.ImageUploadSpec) (sp.ImageUploadReceipt, bool, error) {
			unexpectedHTTPCall(t, "Session.PrepareUpload")
			panic("unreachable")
		},
		WriteUploadChunk: func(context.Context, model.Principal, string, string, string, string, sp.ImageChunkWrite) (sp.ImageUploadReceipt, error) {
			unexpectedHTTPCall(t, "Session.WriteUploadChunk")
			panic("unreachable")
		},
		CompleteUpload: func(context.Context, model.Principal, string, string, string, string, sp.ImageUploadComplete) (sp.ImageUploadReceipt, error) {
			unexpectedHTTPCall(t, "Session.CompleteUpload")
			panic("unreachable")
		},
		GetUpload: func(context.Context, model.Principal, string, string, string, string) (sp.ImageUploadReceipt, error) {
			unexpectedHTTPCall(t, "Session.GetUpload")
			panic("unreachable")
		},
		ReleaseUpload: func(context.Context, model.Principal, string, string, string, string) (sp.ImageUploadReceipt, error) {
			unexpectedHTTPCall(t, "Session.ReleaseUpload")
			panic("unreachable")
		},
		ReadResource: func(context.Context, model.Principal, string, string, string, sp.ImageReadRequest) (sp.ImageReadChunk, error) {
			unexpectedHTTPCall(t, "Session.ReadResource")
			panic("unreachable")
		},
		ImageCapabilities: func(context.Context, model.Principal, string, string, string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.ImageCapabilities")
			panic("unreachable")
		},
		TaskOperation: func(context.Context, model.Principal, string, string, string, string) (sessioncore.TaskOperationResult, error) {
			unexpectedHTTPCall(t, "Session.TaskOperation")
			panic("unreachable")
		},
		ArchiveContentReserved: func(context.Context, model.Principal, string, string, string, io.Closer) (sessionhttp.ArchiveContent, error) {
			unexpectedHTTPCall(t, "Session.ArchiveContentReserved")
			panic("unreachable")
		},
		ArchiveStatus: func(context.Context, model.Principal, string, string, string) (sp.ArchiveStatus, error) {
			unexpectedHTTPCall(t, "Session.ArchiveStatus")
			panic("unreachable")
		},
		AuthenticateController: func(context.Context, string) error {
			unexpectedHTTPCall(t, "Session.AuthenticateController")
			panic("unreachable")
		},
		BeginArchiveReserved: func(context.Context, model.Principal, string, string, string, sessioncore.ArchiveMode, io.Closer) (sessionhttp.ArchiveOperation, error) {
			unexpectedHTTPCall(t, "Session.BeginArchiveReserved")
			panic("unreachable")
		},
		BindTerminalConnection: func(context.Context, model.Principal, string, string, string, v2.Envelope, string) error {
			unexpectedHTTPCall(t, "Session.BindTerminalConnection")
			panic("unreachable")
		},
		BrowserPoll: func(context.Context, model.Principal, string, string, string, string) (sp.Snapshot, []map[string]any, string, error) {
			unexpectedHTTPCall(t, "Session.BrowserPoll")
			panic("unreachable")
		},
		Connect: func(context.Context, string, sp.ControllerMessage, string, int) (sp.Snapshot, error) {
			unexpectedHTTPCall(t, "Session.Connect")
			panic("unreachable")
		},
		Current: func(context.Context, model.Principal, string, string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.Current")
			panic("unreachable")
		},
		CurrentTerminal: func(context.Context, model.Principal, string, string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.CurrentTerminal")
			panic("unreachable")
		},
		CurrentWithStartup: func(context.Context, model.Principal, string, string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.CurrentWithStartup")
			panic("unreachable")
		},
		Disconnect: func(context.Context, sp.ControllerFence) error {
			unexpectedHTTPCall(t, "Session.Disconnect")
			panic("unreachable")
		},
		DisconnectTerminal: func(context.Context, model.Principal, string, string, string, v2.Envelope, string) error {
			unexpectedHTTPCall(t, "Session.DisconnectTerminal")
			panic("unreachable")
		},
		DisconnectTerminalViewer: func(context.Context, model.Principal, string, string, string, string, string, string) error {
			unexpectedHTTPCall(t, "Session.DisconnectTerminalViewer")
			panic("unreachable")
		},
		FinalizeTerminal: func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.FinalizeTerminal")
			panic("unreachable")
		},
		Grant: func(context.Context, model.Principal, string, string, string, sp.Grant) (sessioncore.GrantResult, error) {
			unexpectedHTTPCall(t, "Session.Grant")
			panic("unreachable")
		},
		Handle: func(context.Context, sp.ControllerMessage) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.Handle")
			panic("unreachable")
		},
		HandleTerminalControl: func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.HandleTerminalControl")
			panic("unreachable")
		},
		ListTest: func(context.Context, model.Principal, string, int, bool) (sessioncore.TestListPage, error) {
			unexpectedHTTPCall(t, "Session.ListTest")
			panic("unreachable")
		},
		Operation: func(context.Context, model.Principal, string, string, string, string) (sp.Operation, error) {
			unexpectedHTTPCall(t, "Session.Operation")
			panic("unreachable")
		},
		Poll: func(context.Context, sp.ControllerFence) ([]map[string]any, error) {
			unexpectedHTTPCall(t, "Session.Poll")
			panic("unreachable")
		},
		PollTerminal: func(context.Context, model.Principal, string, string, string, v2.Envelope, string) ([]v2.Message, error) {
			unexpectedHTTPCall(t, "Session.PollTerminal")
			panic("unreachable")
		},
		Register: func(context.Context, model.Principal, string, string, sp.Registration) (sp.Snapshot, error) {
			unexpectedHTTPCall(t, "Session.Register")
			panic("unreachable")
		},
		RegisterTerminal: func(context.Context, model.Principal, string, string, v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.RegisterTerminal")
			panic("unreachable")
		},
		RegisterTest: func(context.Context, model.Principal, sp.TestRegistration) (sp.Snapshot, error) {
			unexpectedHTTPCall(t, "Session.RegisterTest")
			panic("unreachable")
		},
		Resource: func(context.Context, model.Principal, string, string, string, string) ([]byte, sp.Resource, error) {
			unexpectedHTTPCall(t, "Session.Resource")
			panic("unreachable")
		},
		SourceSeq: func(context.Context, sp.ControllerFence) (int64, error) {
			unexpectedHTTPCall(t, "Session.SourceSeq")
			panic("unreachable")
		},
		StopTest: func(context.Context, model.Principal, string, sp.TestStop) (sp.Snapshot, error) {
			unexpectedHTTPCall(t, "Session.StopTest")
			panic("unreachable")
		},
		Submit: func(context.Context, model.Principal, string, string, string, sp.Command) (sp.Operation, error) {
			unexpectedHTTPCall(t, "Session.Submit")
			panic("unreachable")
		},
		SubmitTerminal: func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.SubmitTerminal")
			panic("unreachable")
		},
		TerminalArchiveContentReserved: func(context.Context, model.Principal, string, string, string, io.Closer) (sessionhttp.ArchiveContent, error) {
			unexpectedHTTPCall(t, "Session.TerminalArchiveContentReserved")
			panic("unreachable")
		},
		TerminalArchiveState: func(context.Context, model.Principal, string, string, string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.TerminalArchiveState")
			panic("unreachable")
		},
		TerminalArchiveStatus: func(context.Context, model.Principal, string, string, string) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.TerminalArchiveStatus")
			panic("unreachable")
		},
		TerminalAutomationRecovery: func(context.Context, model.Principal, string, string, string, string) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.TerminalAutomationRecovery")
			panic("unreachable")
		},
		TerminalHistory: func(context.Context, model.Principal, string, string, string, int) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.TerminalHistory")
			panic("unreachable")
		},
		TerminalOperation: func(context.Context, model.Principal, string, string, string, string) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.TerminalOperation")
			panic("unreachable")
		},
		TerminalReceipt: func(context.Context, model.Principal, string, string, string) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.TerminalReceipt")
			panic("unreachable")
		},
		TerminalRecordingEvidence: func(context.Context, model.Principal, string, string, string, string, string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.TerminalRecordingEvidence")
			panic("unreachable")
		},
		TerminalState: func(context.Context, model.Principal, string, string, string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.TerminalState")
			panic("unreachable")
		},
		TestSnapshot: func(context.Context, model.Principal, string) (sp.Snapshot, error) {
			unexpectedHTTPCall(t, "Session.TestSnapshot")
			panic("unreachable")
		},
		Timeline: func(context.Context, model.Principal, string, string, string, string, string, int) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.Timeline")
			panic("unreachable")
		},
		TryReserveArchivePreflight: func() (io.Closer, error) {
			unexpectedHTTPCall(t, "Session.TryReserveArchivePreflight")
			panic("unreachable")
		},
		UpdateArchive: func(context.Context, model.Principal, string, string, string, sp.ArchiveUpdate) (sp.ArchiveStatus, error) {
			unexpectedHTTPCall(t, "Session.UpdateArchive")
			panic("unreachable")
		},
		UpdateTerminalArchive: func(context.Context, model.Principal, string, string, string, v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.UpdateTerminalArchive")
			panic("unreachable")
		},
		UpdateTerminalLedger: func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.UpdateTerminalLedger")
			panic("unreachable")
		},
		UpdateTerminalRecording: func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.UpdateTerminalRecording")
			panic("unreachable")
		},
		UpdateTerminalRecovery: func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.UpdateTerminalRecovery")
			panic("unreachable")
		},
	}
}
