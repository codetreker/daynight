package session

import (
	"bytes"
	"context"
	"errors"
	"io"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

func TestCallsFromServiceKeepsDirectBindings(t *testing.T) {
	// The receiver exists only to inspect method bindings; no business operation
	// or Engine lifecycle is executed by this wiring test.
	service := &sessionservice.Service{Execution: &sessioncore.Execution{}}
	calls := callsFromService(service)
	actual := reflect.ValueOf(calls)
	for i := range actual.NumField() {
		if actual.Field(i).IsNil() {
			t.Fatalf("service binding %s is missing", actual.Type().Field(i).Name)
		}
	}
	expected := map[string]any{
		"ArchiveStatus":              service.ArchiveStatus,
		"AuthenticateController":     service.AuthenticateController,
		"BindTerminalConnection":     service.BindTerminalConnection,
		"BrowserPoll":                service.BrowserPoll,
		"Connect":                    service.ConnectWithContentRead,
		"Current":                    service.Current,
		"CurrentTerminal":            service.CurrentTerminal,
		"CurrentWithStartup":         service.CurrentWithStartup,
		"Disconnect":                 service.Disconnect,
		"DisconnectTerminal":         service.DisconnectTerminal,
		"DisconnectTerminalViewer":   service.DisconnectTerminalViewer,
		"FinalizeTerminal":           service.FinalizeTerminal,
		"Grant":                      service.Grant,
		"Handle":                     service.Handle,
		"HandleTerminalControl":      service.HandleTerminalControl,
		"ListTest":                   service.ListTest,
		"Operation":                  service.Operation,
		"Poll":                       service.Poll,
		"PollTerminal":               service.PollTerminal,
		"Register":                   service.Register,
		"RegisterTerminal":           service.RegisterTerminal,
		"RegisterTest":               service.RegisterTest,
		"Resource":                   service.Resource,
		"SourceSeq":                  service.SourceSeq,
		"StopTest":                   service.StopTest,
		"Submit":                     service.Submit,
		"SubmitTerminal":             service.SubmitTerminal,
		"TerminalArchiveState":       service.TerminalArchiveState,
		"TerminalArchiveStatus":      service.TerminalArchiveStatus,
		"TerminalAutomationRecovery": service.TerminalAutomationRecovery,
		"TerminalHistory":            service.TerminalHistory,
		"TerminalOperation":          service.TerminalOperation,
		"TerminalReceipt":            service.TerminalReceipt,
		"TerminalRecordingEvidence":  service.TerminalRecordingEvidence,
		"TerminalState":              service.TerminalState,
		"TestSnapshot":               service.TestSnapshot,
		"Timeline":                   service.Timeline,
		"UpdateArchive":              service.UpdateArchive,
		"UpdateTerminalArchive":      service.UpdateTerminalArchive,
		"UpdateTerminalLedger":       service.UpdateTerminalLedger,
		"UpdateTerminalRecording":    service.UpdateTerminalRecording,
		"UpdateTerminalRecovery":     service.UpdateTerminalRecovery,
	}
	for name, want := range expected {
		if got := actual.FieldByName(name).Pointer(); got != reflect.ValueOf(want).Pointer() {
			t.Errorf("%s is bound to another usecase", name)
		}
	}
}

func TestCallsFromNilServiceHasNoUsecases(t *testing.T) {
	if !reflect.ValueOf(callsFromService(nil)).IsZero() {
		t.Fatal("nil service supplied active usecases")
	}
}

func TestArchiveReservationCallKeepsResultAndError(t *testing.T) {
	reservation := &sessioncore.ArchivePreflightReservation{}
	cause := errors.New("preflight unavailable")
	for _, scenario := range []struct {
		name   string
		result *sessioncore.ArchivePreflightReservation
		err    error
	}{{"reserved", reservation, nil}, {"refused", nil, cause}} {
		t.Run(scenario.name, func(t *testing.T) {
			calls := 0
			reserve := archiveReservationCall(func() (*sessioncore.ArchivePreflightReservation, error) {
				calls++
				return scenario.result, scenario.err
			})
			result, err := reserve()
			if calls != 1 || result != io.Closer(scenario.result) || err != scenario.err {
				t.Fatal("reservation result or error changed", calls, result, err)
			}
		})
	}
}

func TestArchiveOperationCallPassesRequestAndReservation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	principal := model.Principal{Kind: model.PATCredential, UserID: "owner", CredentialID: "credential"}
	reservation := &sessioncore.ArchivePreflightReservation{}
	operation := &sessioncore.ArchiveOperation{}
	cause := errors.New("archive access refused")
	for _, scenario := range []struct {
		name   string
		result *sessioncore.ArchiveOperation
		err    error
	}{{"admitted", operation, nil}, {"refused", nil, cause}} {
		t.Run(scenario.name, func(t *testing.T) {
			calls := 0
			begin := archiveOperationCall(func(actual context.Context, p model.Principal, project, task, id string, mode sessioncore.ArchiveMode, token *sessioncore.ArchivePreflightReservation) (*sessioncore.ArchiveOperation, error) {
				calls++
				if actual != ctx || p != principal || project != "project" || task != "task" || id != "session" || mode != sessioncore.ArchiveV2Upload || token != reservation {
					t.Fatal("archive request or reservation changed")
				}
				return scenario.result, scenario.err
			})
			result, err := begin(ctx, principal, "project", "task", "session", sessioncore.ArchiveV2Upload, reservation)
			if calls != 1 || result != ArchiveOperation(scenario.result) || err != scenario.err {
				t.Fatal("archive operation result or error changed", calls, result, err)
			}
		})
	}
}

func TestArchiveContentCallPreservesExactBytesAndCloser(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	principal := model.Principal{Kind: model.SessionCredential, UserID: "reader", CredentialID: "browser"}
	reservation := &sessioncore.ArchivePreflightReservation{}
	bytesFromService := []byte(" \n{ \"text\": \"<unchanged>\" }\n")
	retained := &sessioncore.RetainedArchive{Data: bytesFromService}
	calls := 0
	read := archiveContentCall(func(actual context.Context, p model.Principal, project, task, id string, token *sessioncore.ArchivePreflightReservation) (*sessioncore.RetainedArchive, error) {
		calls++
		if actual != ctx || p != principal || project != "project" || task != "task" || id != "session" || token != reservation {
			t.Fatal("archive content request or reservation changed")
		}
		return retained, nil
	})
	content, err := read(ctx, principal, "project", "task", "session", reservation)
	if err != nil || calls != 1 || content.Closer != retained || !bytes.Equal(content.Data, bytesFromService) || &content.Data[0] != &bytesFromService[0] {
		t.Fatal("retained bytes or ownership changed", calls, content, err)
	}
}

func TestArchiveContentCallPreservesFailure(t *testing.T) {
	ctx := t.Context()
	principal := model.Principal{Kind: model.PATCredential, UserID: "owner", CredentialID: "credential"}
	reservation := &sessioncore.ArchivePreflightReservation{}
	cause := errors.New("archive read unavailable")
	calls := 0
	read := archiveContentCall(func(actual context.Context, p model.Principal, project, task, id string, token *sessioncore.ArchivePreflightReservation) (*sessioncore.RetainedArchive, error) {
		calls++
		if actual != ctx || p != principal || project != "project" || task != "task" || id != "session" || token != reservation {
			t.Fatal("failed archive request or reservation changed")
		}
		return nil, cause
	})
	content, err := read(ctx, principal, "project", "task", "session", reservation)
	if calls != 1 || err != cause || content.Data != nil || content.Closer != nil {
		t.Fatal("archive failure was replaced or exposed a lease", calls, content, err)
	}
}
