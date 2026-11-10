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

func strictSessionHTTPOperations(t *testing.T) sessionhttp.Operations {
	return sessionhttp.Operations{
		GetImageOccurrence: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.ImageOccurrenceStatus, error) {
			unexpectedHTTPCall(t, "Session.GetImageOccurrence")
			panic("unexpected Session.GetImageOccurrence")
		},
		RetryImageOccurrence: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.ImageOccurrenceRetryReceipt, error) {
			unexpectedHTTPCall(t, "Session.RetryImageOccurrence")
			panic("unexpected Session.RetryImageOccurrence")
		},
		BeginHistoryLedgerReserved: func(a0 context.Context, a1 string, a2 string, a3 string, a4 sessioncore.ActiveHistoryWriter, a5 io.Closer) (sessionhttp.ArchiveOperation, error) {
			unexpectedHTTPCall(t, "Session.BeginHistoryLedgerReserved")
			panic("unexpected Session.BeginHistoryLedgerReserved")
		},
		ArchivePreparation: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (sp.ArchivePrepareReceipt, error) {
			unexpectedHTTPCall(t, "Session.ArchivePreparation")
			panic("unexpected Session.ArchivePreparation")
		},
		ArchiveFileStatus: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.ArchiveFileReceipt, error) {
			unexpectedHTTPCall(t, "Session.ArchiveFileStatus")
			panic("unexpected Session.ArchiveFileStatus")
		},
		ArchiveTimelineContentReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 io.Closer) (sessionhttp.ArchiveContent, error) {
			unexpectedHTTPCall(t, "Session.ArchiveTimelineContentReserved")
			panic("unexpected Session.ArchiveTimelineContentReserved")
		},
		PrepareUpload: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.ImageUploadSpec) (sp.ImageUploadReceipt, bool, error) {
			unexpectedHTTPCall(t, "Session.PrepareUpload")
			panic("unexpected Session.PrepareUpload")
		},
		WriteUploadChunk: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 sp.ImageChunkWrite) (sp.ImageUploadReceipt, error) {
			unexpectedHTTPCall(t, "Session.WriteUploadChunk")
			panic("unexpected Session.WriteUploadChunk")
		},
		CompleteUpload: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 sp.ImageUploadComplete) (sp.ImageUploadReceipt, error) {
			unexpectedHTTPCall(t, "Session.CompleteUpload")
			panic("unexpected Session.CompleteUpload")
		},
		GetUpload: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.ImageUploadReceipt, error) {
			unexpectedHTTPCall(t, "Session.GetUpload")
			panic("unexpected Session.GetUpload")
		},
		ReleaseUpload: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.ImageUploadReceipt, error) {
			unexpectedHTTPCall(t, "Session.ReleaseUpload")
			panic("unexpected Session.ReleaseUpload")
		},
		ReadResource: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.ImageReadRequest) (sp.ImageReadChunk, error) {
			unexpectedHTTPCall(t, "Session.ReadResource")
			panic("unexpected Session.ReadResource")
		},
		ImageCapabilities: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.ImageCapabilities")
			panic("unexpected Session.ImageCapabilities")
		},
		TaskOperation: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sessioncore.TaskOperationResult, error) {
			unexpectedHTTPCall(t, "Session.TaskOperation")
			panic("unexpected Session.TaskOperation")
		},
		ArchiveContentReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 io.Closer) (sessionhttp.ArchiveContent, error) {
			unexpectedHTTPCall(t, "Session.ArchiveContentReserved")
			panic("unexpected Session.ArchiveContentReserved")
		},
		ArchiveStatus: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (sp.ArchiveStatus, error) {
			unexpectedHTTPCall(t, "Session.ArchiveStatus")
			panic("unexpected Session.ArchiveStatus")
		},
		AuthenticateController: func(a0 context.Context, a1 string) error {
			unexpectedHTTPCall(t, "Session.AuthenticateController")
			panic("unexpected Session.AuthenticateController")
		},
		BeginArchiveReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sessioncore.ArchiveMode, a6 io.Closer) (sessionhttp.ArchiveOperation, error) {
			unexpectedHTTPCall(t, "Session.BeginArchiveReserved")
			panic("unexpected Session.BeginArchiveReserved")
		},
		BindTerminalConnection: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Envelope, a6 string) error {
			unexpectedHTTPCall(t, "Session.BindTerminalConnection")
			panic("unexpected Session.BindTerminalConnection")
		},
		BrowserPoll: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.Snapshot, []map[string]any, string, error) {
			unexpectedHTTPCall(t, "Session.BrowserPoll")
			panic("unexpected Session.BrowserPoll")
		},
		Connect: func(a0 context.Context, a1 string, a2 sp.ControllerMessage, a3 string, a4 int) (sp.Snapshot, error) {
			unexpectedHTTPCall(t, "Session.Connect")
			panic("unexpected Session.Connect")
		},
		Current: func(a0 context.Context, a1 model.Principal, a2 string, a3 string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.Current")
			panic("unexpected Session.Current")
		},
		CurrentTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.CurrentTerminal")
			panic("unexpected Session.CurrentTerminal")
		},
		CurrentWithStartup: func(a0 context.Context, a1 model.Principal, a2 string, a3 string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.CurrentWithStartup")
			panic("unexpected Session.CurrentWithStartup")
		},
		Disconnect: func(a0 context.Context, a1 sp.ControllerFence) error {
			unexpectedHTTPCall(t, "Session.Disconnect")
			panic("unexpected Session.Disconnect")
		},
		DisconnectTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Envelope, a6 string) error {
			unexpectedHTTPCall(t, "Session.DisconnectTerminal")
			panic("unexpected Session.DisconnectTerminal")
		},
		DisconnectTerminalViewer: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 string, a7 string) error {
			unexpectedHTTPCall(t, "Session.DisconnectTerminalViewer")
			panic("unexpected Session.DisconnectTerminalViewer")
		},
		FinalizeTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.FinalizeTerminal")
			panic("unexpected Session.FinalizeTerminal")
		},
		Grant: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.Grant) (sessioncore.GrantResult, error) {
			unexpectedHTTPCall(t, "Session.Grant")
			panic("unexpected Session.Grant")
		},
		Handle: func(a0 context.Context, a1 sp.ControllerMessage) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.Handle")
			panic("unexpected Session.Handle")
		},
		HandleTerminalControl: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.HandleTerminalControl")
			panic("unexpected Session.HandleTerminalControl")
		},
		ListTest: func(a0 context.Context, a1 model.Principal, a2 string, a3 int, a4 bool) (sessioncore.TestListPage, error) {
			unexpectedHTTPCall(t, "Session.ListTest")
			panic("unexpected Session.ListTest")
		},
		Operation: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.Operation, error) {
			unexpectedHTTPCall(t, "Session.Operation")
			panic("unexpected Session.Operation")
		},
		Poll: func(a0 context.Context, a1 sp.ControllerFence) ([]map[string]any, error) {
			unexpectedHTTPCall(t, "Session.Poll")
			panic("unexpected Session.Poll")
		},
		PollTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Envelope, a6 string) ([]v2.Message, error) {
			unexpectedHTTPCall(t, "Session.PollTerminal")
			panic("unexpected Session.PollTerminal")
		},
		Register: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 sp.Registration) (sp.Snapshot, error) {
			unexpectedHTTPCall(t, "Session.Register")
			panic("unexpected Session.Register")
		},
		RegisterTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.RegisterTerminal")
			panic("unexpected Session.RegisterTerminal")
		},
		RegisterTest: func(a0 context.Context, a1 model.Principal, a2 sp.TestRegistration) (sp.Snapshot, error) {
			unexpectedHTTPCall(t, "Session.RegisterTest")
			panic("unexpected Session.RegisterTest")
		},
		Resource: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) ([]byte, sp.Resource, error) {
			unexpectedHTTPCall(t, "Session.Resource")
			panic("unexpected Session.Resource")
		},
		SourceSeq: func(a0 context.Context, a1 sp.ControllerFence) (int64, error) {
			unexpectedHTTPCall(t, "Session.SourceSeq")
			panic("unexpected Session.SourceSeq")
		},
		StopTest: func(a0 context.Context, a1 model.Principal, a2 string, a3 sp.TestStop) (sp.Snapshot, error) {
			unexpectedHTTPCall(t, "Session.StopTest")
			panic("unexpected Session.StopTest")
		},
		Submit: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.Command) (sp.Operation, error) {
			unexpectedHTTPCall(t, "Session.Submit")
			panic("unexpected Session.Submit")
		},
		SubmitTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.SubmitTerminal")
			panic("unexpected Session.SubmitTerminal")
		},
		TerminalArchiveContentReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 io.Closer) (sessionhttp.ArchiveContent, error) {
			unexpectedHTTPCall(t, "Session.TerminalArchiveContentReserved")
			panic("unexpected Session.TerminalArchiveContentReserved")
		},
		TerminalArchiveState: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.TerminalArchiveState")
			panic("unexpected Session.TerminalArchiveState")
		},
		TerminalArchiveStatus: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.TerminalArchiveStatus")
			panic("unexpected Session.TerminalArchiveStatus")
		},
		TerminalAutomationRecovery: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.TerminalAutomationRecovery")
			panic("unexpected Session.TerminalAutomationRecovery")
		},
		TerminalHistory: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 int) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.TerminalHistory")
			panic("unexpected Session.TerminalHistory")
		},
		TerminalOperation: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.TerminalOperation")
			panic("unexpected Session.TerminalOperation")
		},
		TerminalReceipt: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.TerminalReceipt")
			panic("unexpected Session.TerminalReceipt")
		},
		TerminalRecordingEvidence: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.TerminalRecordingEvidence")
			panic("unexpected Session.TerminalRecordingEvidence")
		},
		TerminalState: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.TerminalState")
			panic("unexpected Session.TerminalState")
		},
		TestSnapshot: func(a0 context.Context, a1 model.Principal, a2 string) (sp.Snapshot, error) {
			unexpectedHTTPCall(t, "Session.TestSnapshot")
			panic("unexpected Session.TestSnapshot")
		},
		Timeline: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 string, a7 int) (map[string]any, error) {
			unexpectedHTTPCall(t, "Session.Timeline")
			panic("unexpected Session.Timeline")
		},
		TryReserveArchivePreflight: func() (io.Closer, error) {
			unexpectedHTTPCall(t, "Session.TryReserveArchivePreflight")
			panic("unexpected Session.TryReserveArchivePreflight")
		},
		UpdateArchive: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.ArchiveUpdate) (sp.ArchiveStatus, error) {
			unexpectedHTTPCall(t, "Session.UpdateArchive")
			panic("unexpected Session.UpdateArchive")
		},
		UpdateTerminalArchive: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.UpdateTerminalArchive")
			panic("unexpected Session.UpdateTerminalArchive")
		},
		UpdateTerminalLedger: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.UpdateTerminalLedger")
			panic("unexpected Session.UpdateTerminalLedger")
		},
		UpdateTerminalRecording: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.UpdateTerminalRecording")
			panic("unexpected Session.UpdateTerminalRecording")
		},
		UpdateTerminalRecovery: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			unexpectedHTTPCall(t, "Session.UpdateTerminalRecovery")
			panic("unexpected Session.UpdateTerminalRecovery")
		},
	}
}

func forwardSessionHTTPOperations(calls *sessionhttp.Operations) sessionhttp.Operations {
	return sessionhttp.Operations{
		GetImageOccurrence: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.ImageOccurrenceStatus, error) {
			return calls.GetImageOccurrence(a0, a1, a2, a3, a4, a5)
		},
		RetryImageOccurrence: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.ImageOccurrenceRetryReceipt, error) {
			return calls.RetryImageOccurrence(a0, a1, a2, a3, a4, a5)
		},
		BeginHistoryLedgerReserved: func(a0 context.Context, a1 string, a2 string, a3 string, a4 sessioncore.ActiveHistoryWriter, a5 io.Closer) (sessionhttp.ArchiveOperation, error) {
			return calls.BeginHistoryLedgerReserved(a0, a1, a2, a3, a4, a5)
		},
		ArchivePreparation: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (sp.ArchivePrepareReceipt, error) {
			return calls.ArchivePreparation(a0, a1, a2, a3, a4)
		},
		ArchiveFileStatus: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.ArchiveFileReceipt, error) {
			return calls.ArchiveFileStatus(a0, a1, a2, a3, a4, a5)
		},
		ArchiveTimelineContentReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 io.Closer) (sessionhttp.ArchiveContent, error) {
			return calls.ArchiveTimelineContentReserved(a0, a1, a2, a3, a4, a5, a6)
		},
		PrepareUpload: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.ImageUploadSpec) (sp.ImageUploadReceipt, bool, error) {
			return calls.PrepareUpload(a0, a1, a2, a3, a4, a5)
		},
		WriteUploadChunk: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 sp.ImageChunkWrite) (sp.ImageUploadReceipt, error) {
			return calls.WriteUploadChunk(a0, a1, a2, a3, a4, a5, a6)
		},
		CompleteUpload: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 sp.ImageUploadComplete) (sp.ImageUploadReceipt, error) {
			return calls.CompleteUpload(a0, a1, a2, a3, a4, a5, a6)
		},
		GetUpload: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.ImageUploadReceipt, error) {
			return calls.GetUpload(a0, a1, a2, a3, a4, a5)
		},
		ReleaseUpload: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.ImageUploadReceipt, error) {
			return calls.ReleaseUpload(a0, a1, a2, a3, a4, a5)
		},
		ReadResource: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.ImageReadRequest) (sp.ImageReadChunk, error) {
			return calls.ReadResource(a0, a1, a2, a3, a4, a5)
		},
		ImageCapabilities: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (map[string]any, error) {
			return calls.ImageCapabilities(a0, a1, a2, a3, a4)
		},
		TaskOperation: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sessioncore.TaskOperationResult, error) {
			return calls.TaskOperation(a0, a1, a2, a3, a4, a5)
		},
		ArchiveContentReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 io.Closer) (sessionhttp.ArchiveContent, error) {
			return calls.ArchiveContentReserved(a0, a1, a2, a3, a4, a5)
		},
		ArchiveStatus: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (sp.ArchiveStatus, error) {
			return calls.ArchiveStatus(a0, a1, a2, a3, a4)
		},
		AuthenticateController: func(a0 context.Context, a1 string) error { return calls.AuthenticateController(a0, a1) },
		BeginArchiveReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sessioncore.ArchiveMode, a6 io.Closer) (sessionhttp.ArchiveOperation, error) {
			return calls.BeginArchiveReserved(a0, a1, a2, a3, a4, a5, a6)
		},
		BindTerminalConnection: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Envelope, a6 string) error {
			return calls.BindTerminalConnection(a0, a1, a2, a3, a4, a5, a6)
		},
		BrowserPoll: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.Snapshot, []map[string]any, string, error) {
			return calls.BrowserPoll(a0, a1, a2, a3, a4, a5)
		},
		Connect: func(a0 context.Context, a1 string, a2 sp.ControllerMessage, a3 string, a4 int) (sp.Snapshot, error) {
			return calls.Connect(a0, a1, a2, a3, a4)
		},
		Current: func(a0 context.Context, a1 model.Principal, a2 string, a3 string) (map[string]any, error) {
			return calls.Current(a0, a1, a2, a3)
		},
		CurrentTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string) (map[string]any, error) {
			return calls.CurrentTerminal(a0, a1, a2, a3)
		},
		CurrentWithStartup: func(a0 context.Context, a1 model.Principal, a2 string, a3 string) (map[string]any, error) {
			return calls.CurrentWithStartup(a0, a1, a2, a3)
		},
		Disconnect: func(a0 context.Context, a1 sp.ControllerFence) error { return calls.Disconnect(a0, a1) },
		DisconnectTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Envelope, a6 string) error {
			return calls.DisconnectTerminal(a0, a1, a2, a3, a4, a5, a6)
		},
		DisconnectTerminalViewer: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 string, a7 string) error {
			return calls.DisconnectTerminalViewer(a0, a1, a2, a3, a4, a5, a6, a7)
		},
		FinalizeTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			return calls.FinalizeTerminal(a0, a1, a2, a3, a4, a5, a6)
		},
		Grant: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.Grant) (sessioncore.GrantResult, error) {
			return calls.Grant(a0, a1, a2, a3, a4, a5)
		},
		Handle: func(a0 context.Context, a1 sp.ControllerMessage) (map[string]any, error) { return calls.Handle(a0, a1) },
		HandleTerminalControl: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			return calls.HandleTerminalControl(a0, a1, a2, a3, a4, a5, a6)
		},
		ListTest: func(a0 context.Context, a1 model.Principal, a2 string, a3 int, a4 bool) (sessioncore.TestListPage, error) {
			return calls.ListTest(a0, a1, a2, a3, a4)
		},
		Operation: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.Operation, error) {
			return calls.Operation(a0, a1, a2, a3, a4, a5)
		},
		Poll: func(a0 context.Context, a1 sp.ControllerFence) ([]map[string]any, error) { return calls.Poll(a0, a1) },
		PollTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Envelope, a6 string) ([]v2.Message, error) {
			return calls.PollTerminal(a0, a1, a2, a3, a4, a5, a6)
		},
		Register: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 sp.Registration) (sp.Snapshot, error) {
			return calls.Register(a0, a1, a2, a3, a4)
		},
		RegisterTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 v2.Message) (v2.Message, error) {
			return calls.RegisterTerminal(a0, a1, a2, a3, a4)
		},
		RegisterTest: func(a0 context.Context, a1 model.Principal, a2 sp.TestRegistration) (sp.Snapshot, error) {
			return calls.RegisterTest(a0, a1, a2)
		},
		Resource: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) ([]byte, sp.Resource, error) {
			return calls.Resource(a0, a1, a2, a3, a4, a5)
		},
		SourceSeq: func(a0 context.Context, a1 sp.ControllerFence) (int64, error) { return calls.SourceSeq(a0, a1) },
		StopTest: func(a0 context.Context, a1 model.Principal, a2 string, a3 sp.TestStop) (sp.Snapshot, error) {
			return calls.StopTest(a0, a1, a2, a3)
		},
		Submit: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.Command) (sp.Operation, error) {
			return calls.Submit(a0, a1, a2, a3, a4, a5)
		},
		SubmitTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			return calls.SubmitTerminal(a0, a1, a2, a3, a4, a5, a6)
		},
		TerminalArchiveContentReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 io.Closer) (sessionhttp.ArchiveContent, error) {
			return calls.TerminalArchiveContentReserved(a0, a1, a2, a3, a4, a5)
		},
		TerminalArchiveState: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (map[string]any, error) {
			return calls.TerminalArchiveState(a0, a1, a2, a3, a4)
		},
		TerminalArchiveStatus: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (v2.Message, error) {
			return calls.TerminalArchiveStatus(a0, a1, a2, a3, a4)
		},
		TerminalAutomationRecovery: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (v2.Message, error) {
			return calls.TerminalAutomationRecovery(a0, a1, a2, a3, a4, a5)
		},
		TerminalHistory: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 int) (map[string]any, error) {
			return calls.TerminalHistory(a0, a1, a2, a3, a4, a5)
		},
		TerminalOperation: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (v2.Message, error) {
			return calls.TerminalOperation(a0, a1, a2, a3, a4, a5)
		},
		TerminalReceipt: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (v2.Message, error) {
			return calls.TerminalReceipt(a0, a1, a2, a3, a4)
		},
		TerminalRecordingEvidence: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 string) (map[string]any, error) {
			return calls.TerminalRecordingEvidence(a0, a1, a2, a3, a4, a5, a6)
		},
		TerminalState: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (map[string]any, error) {
			return calls.TerminalState(a0, a1, a2, a3, a4)
		},
		TestSnapshot: func(a0 context.Context, a1 model.Principal, a2 string) (sp.Snapshot, error) {
			return calls.TestSnapshot(a0, a1, a2)
		},
		Timeline: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 string, a7 int) (map[string]any, error) {
			return calls.Timeline(a0, a1, a2, a3, a4, a5, a6, a7)
		},
		TryReserveArchivePreflight: func() (io.Closer, error) { return calls.TryReserveArchivePreflight() },
		UpdateArchive: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.ArchiveUpdate) (sp.ArchiveStatus, error) {
			return calls.UpdateArchive(a0, a1, a2, a3, a4, a5)
		},
		UpdateTerminalArchive: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Message) (v2.Message, error) {
			return calls.UpdateTerminalArchive(a0, a1, a2, a3, a4, a5)
		},
		UpdateTerminalLedger: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			return calls.UpdateTerminalLedger(a0, a1, a2, a3, a4, a5, a6)
		},
		UpdateTerminalRecording: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			return calls.UpdateTerminalRecording(a0, a1, a2, a3, a4, a5, a6)
		},
		UpdateTerminalRecovery: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			return calls.UpdateTerminalRecovery(a0, a1, a2, a3, a4, a5, a6)
		},
	}
}
