package session

import (
	"context"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

type archiveOperation interface {
	io.Closer
	PutArchive(context.Context, []byte) (sp.ArchiveStatus, error)
	PutTerminalArchive(context.Context, []byte) (v2.Message, error)
}

type archiveContent struct {
	Data []byte
	io.Closer
}

type serviceCalls struct {
	ArchiveContentReserved         func(context.Context, model.Principal, string, string, string, io.Closer) (archiveContent, error)
	ArchiveStatus                  func(context.Context, model.Principal, string, string, string) (sp.ArchiveStatus, error)
	AuthenticateController         func(context.Context, string) error
	BeginArchiveReserved           func(context.Context, model.Principal, string, string, string, sessioncore.ArchiveMode, io.Closer) (archiveOperation, error)
	BindTerminalConnection         func(context.Context, model.Principal, string, string, string, v2.Envelope, string) error
	BrowserPoll                    func(context.Context, model.Principal, string, string, string, string) (sp.Snapshot, []map[string]any, string, error)
	Connect                        func(context.Context, string, sp.ControllerMessage, string, int) (sp.Snapshot, error)
	Current                        func(context.Context, model.Principal, string, string) (map[string]any, error)
	CurrentTerminal                func(context.Context, model.Principal, string, string) (map[string]any, error)
	CurrentWithStartup             func(context.Context, model.Principal, string, string) (map[string]any, error)
	Disconnect                     func(context.Context, sp.ControllerFence) error
	DisconnectTerminal             func(context.Context, model.Principal, string, string, string, v2.Envelope, string) error
	DisconnectTerminalViewer       func(context.Context, model.Principal, string, string, string, string, string, string) error
	FinalizeTerminal               func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error)
	Grant                          func(context.Context, model.Principal, string, string, string, sp.Grant) (sessioncore.GrantResult, error)
	Handle                         func(context.Context, sp.ControllerMessage) (map[string]any, error)
	HandleTerminalControl          func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error)
	ListTest                       func(context.Context, model.Principal, string, int, bool) (sessioncore.TestListPage, error)
	Operation                      func(context.Context, model.Principal, string, string, string, string) (sp.Operation, error)
	Poll                           func(context.Context, sp.ControllerFence) ([]map[string]any, error)
	PollTerminal                   func(context.Context, model.Principal, string, string, string, v2.Envelope, string) ([]v2.Message, error)
	Register                       func(context.Context, model.Principal, string, string, sp.Registration) (sp.Snapshot, error)
	RegisterTerminal               func(context.Context, model.Principal, string, string, v2.Message) (v2.Message, error)
	RegisterTest                   func(context.Context, model.Principal, sp.TestRegistration) (sp.Snapshot, error)
	Resource                       func(context.Context, model.Principal, string, string, string, string) ([]byte, sp.Resource, error)
	SourceSeq                      func(context.Context, sp.ControllerFence) (int64, error)
	StopTest                       func(context.Context, model.Principal, string, sp.TestStop) (sp.Snapshot, error)
	Submit                         func(context.Context, model.Principal, string, string, string, sp.Command) (sp.Operation, error)
	SubmitTerminal                 func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error)
	TerminalArchiveContentReserved func(context.Context, model.Principal, string, string, string, io.Closer) (archiveContent, error)
	TerminalArchiveState           func(context.Context, model.Principal, string, string, string) (map[string]any, error)
	TerminalArchiveStatus          func(context.Context, model.Principal, string, string, string) (v2.Message, error)
	TerminalAutomationRecovery     func(context.Context, model.Principal, string, string, string, string) (v2.Message, error)
	TerminalHistory                func(context.Context, model.Principal, string, string, string, int) (map[string]any, error)
	TerminalOperation              func(context.Context, model.Principal, string, string, string, string) (v2.Message, error)
	TerminalReceipt                func(context.Context, model.Principal, string, string, string) (v2.Message, error)
	TerminalRecordingEvidence      func(context.Context, model.Principal, string, string, string, string, string) (map[string]any, error)
	TerminalState                  func(context.Context, model.Principal, string, string, string) (map[string]any, error)
	TestSnapshot                   func(context.Context, model.Principal, string) (sp.Snapshot, error)
	Timeline                       func(context.Context, model.Principal, string, string, string, string, string, int) (map[string]any, error)
	TryReserveArchivePreflight     func() (io.Closer, error)
	UpdateArchive                  func(context.Context, model.Principal, string, string, string, sp.ArchiveUpdate) (sp.ArchiveStatus, error)
	UpdateTerminalArchive          func(context.Context, model.Principal, string, string, string, v2.Message) (v2.Message, error)
	UpdateTerminalLedger           func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error)
	UpdateTerminalRecording        func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error)
	UpdateTerminalRecovery         func(context.Context, model.Principal, string, string, string, string, v2.Message) (v2.Message, error)
}

func callsFromService(service *sessionservice.Service) serviceCalls {
	if service == nil {
		return serviceCalls{}
	}
	return serviceCalls{
		ArchiveContentReserved:         archiveContentCall(service.ArchiveContentReserved),
		ArchiveStatus:                  service.ArchiveStatus,
		AuthenticateController:         service.AuthenticateController,
		BeginArchiveReserved:           archiveOperationCall(service.BeginArchiveReserved),
		BindTerminalConnection:         service.BindTerminalConnection,
		BrowserPoll:                    service.BrowserPoll,
		Connect:                        service.ConnectWithContentRead,
		Current:                        service.Current,
		CurrentTerminal:                service.CurrentTerminal,
		CurrentWithStartup:             service.CurrentWithStartup,
		Disconnect:                     service.Disconnect,
		DisconnectTerminal:             service.DisconnectTerminal,
		DisconnectTerminalViewer:       service.DisconnectTerminalViewer,
		FinalizeTerminal:               service.FinalizeTerminal,
		Grant:                          service.Grant,
		Handle:                         service.Handle,
		HandleTerminalControl:          service.HandleTerminalControl,
		ListTest:                       service.ListTest,
		Operation:                      service.Operation,
		Poll:                           service.Poll,
		PollTerminal:                   service.PollTerminal,
		Register:                       service.Register,
		RegisterTerminal:               service.RegisterTerminal,
		RegisterTest:                   service.RegisterTest,
		Resource:                       service.Resource,
		SourceSeq:                      service.SourceSeq,
		StopTest:                       service.StopTest,
		Submit:                         service.Submit,
		SubmitTerminal:                 service.SubmitTerminal,
		TerminalArchiveContentReserved: archiveContentCall(service.TerminalArchiveContentReserved),
		TerminalArchiveState:           service.TerminalArchiveState,
		TerminalArchiveStatus:          service.TerminalArchiveStatus,
		TerminalAutomationRecovery:     service.TerminalAutomationRecovery,
		TerminalHistory:                service.TerminalHistory,
		TerminalOperation:              service.TerminalOperation,
		TerminalReceipt:                service.TerminalReceipt,
		TerminalRecordingEvidence:      service.TerminalRecordingEvidence,
		TerminalState:                  service.TerminalState,
		TestSnapshot:                   service.TestSnapshot,
		Timeline:                       service.Timeline,
		TryReserveArchivePreflight:     archiveReservationCall(service.TryReserveArchivePreflight),
		UpdateArchive:                  service.UpdateArchive,
		UpdateTerminalArchive:          service.UpdateTerminalArchive,
		UpdateTerminalLedger:           service.UpdateTerminalLedger,
		UpdateTerminalRecording:        service.UpdateTerminalRecording,
		UpdateTerminalRecovery:         service.UpdateTerminalRecovery,
	}
}

func archiveReservationCall(reserve func() (*sessioncore.ArchivePreflightReservation, error)) func() (io.Closer, error) {
	return func() (io.Closer, error) { return reserve() }
}

func archiveOperationCall(begin func(context.Context, model.Principal, string, string, string, sessioncore.ArchiveMode, *sessioncore.ArchivePreflightReservation) (*sessioncore.ArchiveOperation, error)) func(context.Context, model.Principal, string, string, string, sessioncore.ArchiveMode, io.Closer) (archiveOperation, error) {
	return func(ctx context.Context, principal model.Principal, project, task, id string, mode sessioncore.ArchiveMode, reservation io.Closer) (archiveOperation, error) {
		return begin(ctx, principal, project, task, id, mode, reservation.(*sessioncore.ArchivePreflightReservation))
	}
}

func archiveContentCall(read func(context.Context, model.Principal, string, string, string, *sessioncore.ArchivePreflightReservation) (*sessioncore.RetainedArchive, error)) func(context.Context, model.Principal, string, string, string, io.Closer) (archiveContent, error) {
	return func(ctx context.Context, principal model.Principal, project, task, id string, reservation io.Closer) (archiveContent, error) {
		content, err := read(ctx, principal, project, task, id, reservation.(*sessioncore.ArchivePreflightReservation))
		if err != nil {
			return archiveContent{}, err
		}
		return archiveContent{Data: content.Data, Closer: content}, nil
	}
}
