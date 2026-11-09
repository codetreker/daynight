package session_test

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"io"
)

func (b *routeBackend) wrappedCalls() sessionhttp.ServiceCallsForTest {
	return sessionhttp.ServiceCallsForTest{
		ArchiveContentReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 io.Closer) (sessionhttp.ArchiveContentForTest, error) {
			b.mu.Lock()
			fn := b.Funcs.ArchiveContentReserved
			b.mu.Unlock()
			if err := b.check("ArchiveContentReserved", fn != nil); err != nil {
				var result0 sessionhttp.ArchiveContentForTest
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		ArchiveStatus: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (sp.ArchiveStatus, error) {
			b.mu.Lock()
			fn := b.Funcs.ArchiveStatus
			b.mu.Unlock()
			if err := b.check("ArchiveStatus", fn != nil); err != nil {
				var result0 sp.ArchiveStatus
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4)
		},
		AuthenticateController: func(a0 context.Context, a1 string) error {
			b.mu.Lock()
			fn := b.Funcs.AuthenticateController
			b.mu.Unlock()
			if err := b.check("AuthenticateController", fn != nil); err != nil {
				return err
			}
			return fn(a0, a1)
		},
		BeginArchiveReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sessioncore.ArchiveMode, a6 io.Closer) (sessionhttp.ArchiveOperationForTest, error) {
			b.mu.Lock()
			fn := b.Funcs.BeginArchiveReserved
			b.mu.Unlock()
			if err := b.check("BeginArchiveReserved", fn != nil); err != nil {
				var result0 sessionhttp.ArchiveOperationForTest
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
		BindTerminalConnection: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Envelope, a6 string) error {
			b.mu.Lock()
			fn := b.Funcs.BindTerminalConnection
			b.mu.Unlock()
			if err := b.check("BindTerminalConnection", fn != nil); err != nil {
				return err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
		BrowserPoll: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.Snapshot, []map[string]any, string, error) {
			b.mu.Lock()
			fn := b.Funcs.BrowserPoll
			b.mu.Unlock()
			if err := b.check("BrowserPoll", fn != nil); err != nil {
				var result0 sp.Snapshot
				var result1 []map[string]any
				var result2 string
				return result0, result1, result2, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		Connect: func(a0 context.Context, a1 string, a2 sp.ControllerMessage, a3 string) (sp.Snapshot, error) {
			b.mu.Lock()
			fn := b.Funcs.Connect
			b.mu.Unlock()
			if err := b.check("Connect", fn != nil); err != nil {
				var result0 sp.Snapshot
				return result0, err
			}
			return fn(a0, a1, a2, a3)
		},
		Current: func(a0 context.Context, a1 model.Principal, a2 string, a3 string) (map[string]any, error) {
			b.mu.Lock()
			fn := b.Funcs.Current
			b.mu.Unlock()
			if err := b.check("Current", fn != nil); err != nil {
				var result0 map[string]any
				return result0, err
			}
			return fn(a0, a1, a2, a3)
		},
		CurrentTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string) (map[string]any, error) {
			b.mu.Lock()
			fn := b.Funcs.CurrentTerminal
			b.mu.Unlock()
			if err := b.check("CurrentTerminal", fn != nil); err != nil {
				var result0 map[string]any
				return result0, err
			}
			return fn(a0, a1, a2, a3)
		},
		CurrentWithStartup: func(a0 context.Context, a1 model.Principal, a2 string, a3 string) (map[string]any, error) {
			b.mu.Lock()
			fn := b.Funcs.CurrentWithStartup
			b.mu.Unlock()
			if err := b.check("CurrentWithStartup", fn != nil); err != nil {
				var result0 map[string]any
				return result0, err
			}
			return fn(a0, a1, a2, a3)
		},
		Disconnect: func(a0 context.Context, a1 sp.ControllerFence) error {
			b.mu.Lock()
			fn := b.Funcs.Disconnect
			b.mu.Unlock()
			if err := b.check("Disconnect", fn != nil); err != nil {
				return err
			}
			return fn(a0, a1)
		},
		DisconnectTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Envelope, a6 string) error {
			b.mu.Lock()
			fn := b.Funcs.DisconnectTerminal
			b.mu.Unlock()
			if err := b.check("DisconnectTerminal", fn != nil); err != nil {
				return err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
		DisconnectTerminalViewer: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 string, a7 string) error {
			b.mu.Lock()
			fn := b.Funcs.DisconnectTerminalViewer
			b.mu.Unlock()
			if err := b.check("DisconnectTerminalViewer", fn != nil); err != nil {
				return err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6, a7)
		},
		FinalizeTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.FinalizeTerminal
			b.mu.Unlock()
			if err := b.check("FinalizeTerminal", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
		Grant: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.Grant) (sessioncore.GrantResult, error) {
			b.mu.Lock()
			fn := b.Funcs.Grant
			b.mu.Unlock()
			if err := b.check("Grant", fn != nil); err != nil {
				var result0 sessioncore.GrantResult
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		Handle: func(a0 context.Context, a1 sp.ControllerMessage) (map[string]any, error) {
			b.mu.Lock()
			fn := b.Funcs.Handle
			b.mu.Unlock()
			if err := b.check("Handle", fn != nil); err != nil {
				var result0 map[string]any
				return result0, err
			}
			return fn(a0, a1)
		},
		HandleTerminalControl: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.HandleTerminalControl
			b.mu.Unlock()
			if err := b.check("HandleTerminalControl", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
		ListTest: func(a0 context.Context, a1 model.Principal, a2 string, a3 int, a4 bool) (sessioncore.TestListPage, error) {
			b.mu.Lock()
			fn := b.Funcs.ListTest
			b.mu.Unlock()
			if err := b.check("ListTest", fn != nil); err != nil {
				var result0 sessioncore.TestListPage
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4)
		},
		TaskOperation: func(a0 context.Context, a1 model.Principal, a2, a3, a4, a5 string) (sessioncore.TaskOperationResult, error) {
			b.mu.Lock()
			fn := b.Funcs.TaskOperation
			b.mu.Unlock()
			if err := b.check("TaskOperation", fn != nil); err != nil {
				return sessioncore.TaskOperationResult{}, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		Operation: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (sp.Operation, error) {
			b.mu.Lock()
			fn := b.Funcs.Operation
			b.mu.Unlock()
			if err := b.check("Operation", fn != nil); err != nil {
				var result0 sp.Operation
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		Poll: func(a0 context.Context, a1 sp.ControllerFence) ([]map[string]any, error) {
			b.mu.Lock()
			fn := b.Funcs.Poll
			b.mu.Unlock()
			if err := b.check("Poll", fn != nil); err != nil {
				var result0 []map[string]any
				return result0, err
			}
			return fn(a0, a1)
		},
		PollTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Envelope, a6 string) ([]v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.PollTerminal
			b.mu.Unlock()
			if err := b.check("PollTerminal", fn != nil); err != nil {
				var result0 []v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
		Register: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 sp.Registration) (sp.Snapshot, error) {
			b.mu.Lock()
			fn := b.Funcs.Register
			b.mu.Unlock()
			if err := b.check("Register", fn != nil); err != nil {
				var result0 sp.Snapshot
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4)
		},
		RegisterTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 v2.Message) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.RegisterTerminal
			b.mu.Unlock()
			if err := b.check("RegisterTerminal", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4)
		},
		RegisterTest: func(a0 context.Context, a1 model.Principal, a2 sp.TestRegistration) (sp.Snapshot, error) {
			b.mu.Lock()
			fn := b.Funcs.RegisterTest
			b.mu.Unlock()
			if err := b.check("RegisterTest", fn != nil); err != nil {
				var result0 sp.Snapshot
				return result0, err
			}
			return fn(a0, a1, a2)
		},
		Resource: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) ([]byte, sp.Resource, error) {
			b.mu.Lock()
			fn := b.Funcs.Resource
			b.mu.Unlock()
			if err := b.check("Resource", fn != nil); err != nil {
				var result0 []byte
				var result1 sp.Resource
				return result0, result1, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		SourceSeq: func(a0 context.Context, a1 sp.ControllerFence) (int64, error) {
			b.mu.Lock()
			fn := b.Funcs.SourceSeq
			b.mu.Unlock()
			if err := b.check("SourceSeq", fn != nil); err != nil {
				var result0 int64
				return result0, err
			}
			return fn(a0, a1)
		},
		StopTest: func(a0 context.Context, a1 model.Principal, a2 string, a3 sp.TestStop) (sp.Snapshot, error) {
			b.mu.Lock()
			fn := b.Funcs.StopTest
			b.mu.Unlock()
			if err := b.check("StopTest", fn != nil); err != nil {
				var result0 sp.Snapshot
				return result0, err
			}
			return fn(a0, a1, a2, a3)
		},
		Submit: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.Command) (sp.Operation, error) {
			b.mu.Lock()
			fn := b.Funcs.Submit
			b.mu.Unlock()
			if err := b.check("Submit", fn != nil); err != nil {
				var result0 sp.Operation
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		SubmitTerminal: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.SubmitTerminal
			b.mu.Unlock()
			if err := b.check("SubmitTerminal", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
		TerminalArchiveContentReserved: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 io.Closer) (sessionhttp.ArchiveContentForTest, error) {
			b.mu.Lock()
			fn := b.Funcs.TerminalArchiveContentReserved
			b.mu.Unlock()
			if err := b.check("TerminalArchiveContentReserved", fn != nil); err != nil {
				var result0 sessionhttp.ArchiveContentForTest
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		TerminalArchiveState: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (map[string]any, error) {
			b.mu.Lock()
			fn := b.Funcs.TerminalArchiveState
			b.mu.Unlock()
			if err := b.check("TerminalArchiveState", fn != nil); err != nil {
				var result0 map[string]any
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4)
		},
		TerminalArchiveStatus: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.TerminalArchiveStatus
			b.mu.Unlock()
			if err := b.check("TerminalArchiveStatus", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4)
		},
		TerminalAutomationRecovery: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.TerminalAutomationRecovery
			b.mu.Unlock()
			if err := b.check("TerminalAutomationRecovery", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		TerminalHistory: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 int) (map[string]any, error) {
			b.mu.Lock()
			fn := b.Funcs.TerminalHistory
			b.mu.Unlock()
			if err := b.check("TerminalHistory", fn != nil); err != nil {
				var result0 map[string]any
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		TerminalOperation: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.TerminalOperation
			b.mu.Unlock()
			if err := b.check("TerminalOperation", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		TerminalReceipt: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.TerminalReceipt
			b.mu.Unlock()
			if err := b.check("TerminalReceipt", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4)
		},
		TerminalRecordingEvidence: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 string) (map[string]any, error) {
			b.mu.Lock()
			fn := b.Funcs.TerminalRecordingEvidence
			b.mu.Unlock()
			if err := b.check("TerminalRecordingEvidence", fn != nil); err != nil {
				var result0 map[string]any
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
		TerminalState: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string) (map[string]any, error) {
			b.mu.Lock()
			fn := b.Funcs.TerminalState
			b.mu.Unlock()
			if err := b.check("TerminalState", fn != nil); err != nil {
				var result0 map[string]any
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4)
		},
		TestSnapshot: func(a0 context.Context, a1 model.Principal, a2 string) (sp.Snapshot, error) {
			b.mu.Lock()
			fn := b.Funcs.TestSnapshot
			b.mu.Unlock()
			if err := b.check("TestSnapshot", fn != nil); err != nil {
				var result0 sp.Snapshot
				return result0, err
			}
			return fn(a0, a1, a2)
		},
		Timeline: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 string, a7 int) (map[string]any, error) {
			b.mu.Lock()
			fn := b.Funcs.Timeline
			b.mu.Unlock()
			if err := b.check("Timeline", fn != nil); err != nil {
				var result0 map[string]any
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6, a7)
		},
		TryReserveArchivePreflight: func() (io.Closer, error) {
			b.mu.Lock()
			fn := b.Funcs.TryReserveArchivePreflight
			b.mu.Unlock()
			if err := b.check("TryReserveArchivePreflight", fn != nil); err != nil {
				var result0 io.Closer
				return result0, err
			}
			return fn()
		},
		UpdateArchive: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 sp.ArchiveUpdate) (sp.ArchiveStatus, error) {
			b.mu.Lock()
			fn := b.Funcs.UpdateArchive
			b.mu.Unlock()
			if err := b.check("UpdateArchive", fn != nil); err != nil {
				var result0 sp.ArchiveStatus
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		UpdateTerminalArchive: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 v2.Message) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.UpdateTerminalArchive
			b.mu.Unlock()
			if err := b.check("UpdateTerminalArchive", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5)
		},
		UpdateTerminalLedger: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.UpdateTerminalLedger
			b.mu.Unlock()
			if err := b.check("UpdateTerminalLedger", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
		UpdateTerminalRecording: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.UpdateTerminalRecording
			b.mu.Unlock()
			if err := b.check("UpdateTerminalRecording", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
		UpdateTerminalRecovery: func(a0 context.Context, a1 model.Principal, a2 string, a3 string, a4 string, a5 string, a6 v2.Message) (v2.Message, error) {
			b.mu.Lock()
			fn := b.Funcs.UpdateTerminalRecovery
			b.mu.Unlock()
			if err := b.check("UpdateTerminalRecovery", fn != nil); err != nil {
				var result0 v2.Message
				return result0, err
			}
			return fn(a0, a1, a2, a3, a4, a5, a6)
		},
	}
}
