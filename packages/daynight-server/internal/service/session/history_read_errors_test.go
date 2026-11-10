package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

const historyTestSession = "11111111-1111-4111-8111-111111111111"
const historyTestEpoch = "22222222-2222-4222-8222-222222222222"
const historyTestEntry = "33333333-3333-4333-8333-333333333333"

func historyTestPosition(source string, chunk bool) core.HistoryPosition {
	return core.HistoryPosition{Source: source, SessionID: historyTestSession, Epoch: historyTestEpoch, Version: historyTestEpoch, Sequence: "2", EntryID: historyTestEntry, Revision: "1", SHA256: strings.Repeat("a", 64), ByteLength: "10", Offset: "0", Chunk: chunk}
}
func requireHistoryFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("error %v want %s", err, code)
	}
}
func rejectingHistoryBackend(t *testing.T) historyReadBackend {
	t.Helper()
	return historyReadBackend{live: func(context.Context, model.Principal, string, string, string, core.LiveHistoryRequest) (sp.MessagePage, error) {
		t.Fatal("unexpected live page")
		return sp.MessagePage{}, nil
	}, entry: func(context.Context, model.Principal, string, string, string, string, string) (sp.EntryChunk, error) {
		t.Fatal("unexpected live chunk")
		return sp.EntryChunk{}, nil
	}, status: func(context.Context, model.Principal, string, string, string) (sp.ArchiveStatus, error) {
		t.Fatal("unexpected archive status")
		return sp.ArchiveStatus{}, nil
	}, archive: func(context.Context, model.Principal, string, string, string) (core.HistoryArchive, error) {
		t.Fatal("unexpected archive read")
		return nil, nil
	}}
}
func TestHistoryInputAndObservationRefusalsNeverReadContent(t *testing.T) {
	cause := errors.New("inspection refused")
	herdr := "herdr"
	for _, operation := range []string{"page", "entry"} {
		for _, scenario := range []string{"negative_budget", "oversize_budget", "bad_cursor", "foreign_session", "inspection_failure", "unavailable_observation", "herdr", "source_changed"} {
			t.Run(operation+"/"+scenario, func(t *testing.T) {
				position := historyTestPosition("live", operation == "entry")
				budget := 0
				inspectCalls := 0
				observation := sp.TaskSessionInspection{Source: "live"}
				var inspectionErr error
				switch scenario {
				case "negative_budget":
					budget = -1
				case "oversize_budget":
					budget = sp.MaxHistoryResponseBytes
				case "foreign_session":
					position.SessionID = historyTestEpoch
				case "inspection_failure":
					inspectionErr = cause
				case "unavailable_observation":
					observation.Session.Error = &sp.OperationError{Code: "execution_changed", Message: "changed"}
				case "herdr":
					observation.Session.AgentControlMode = &herdr
				case "source_changed":
					observation.Source = "archive"
				}
				cursor := position.Cursor()
				if scenario == "bad_cursor" {
					cursor = "invalid"
				}
				s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
					inspectCalls++
					return observation, inspectionErr
				}), rejectingHistoryBackend(t))
				var err error
				if operation == "entry" {
					_, err = s.Entry(t.Context(), model.Principal{}, "p", "t", historyTestSession, EntryRequest{Cursor: cursor, ResponseOverhead: budget})
				} else {
					_, err = s.Read(t.Context(), model.Principal{}, "p", "t", historyTestSession, ReadRequest{Before: cursor, ResponseOverhead: budget})
				}
				if err == nil {
					t.Fatal("rejected read succeeded")
				}
				if scenario == "inspection_failure" && !errors.Is(err, cause) {
					t.Fatal("inspection cause lost", err)
				}
				if strings.Contains(scenario, "budget") || scenario == "bad_cursor" || scenario == "foreign_session" {
					if inspectCalls != 0 {
						t.Fatal("invalid request reached observation")
					}
				}
			})
		}
	}
}
func TestHistoryUnavailableStatesPreserveFailures(t *testing.T) {
	for _, state := range []string{"pending", "ready", "failed", "unavailable", "dependency_failure"} {
		t.Run(state, func(t *testing.T) {
			cause := errors.New("status failed")
			backend := rejectingHistoryBackend(t)
			backend.status = func(context.Context, model.Principal, string, string, string) (sp.ArchiveStatus, error) {
				if state == "dependency_failure" {
					return sp.ArchiveStatus{}, cause
				}
				return sp.ArchiveStatus{State: state}, nil
			}
			s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
				return sp.TaskSessionInspection{Source: "unavailable"}, nil
			}), backend)
			_, err := s.Read(t.Context(), model.Principal{}, "p", "t", historyTestSession, ReadRequest{})
			if state == "dependency_failure" {
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
				return
			}
			code := "history_unavailable"
			if state == "pending" {
				code = "history_pending"
			}
			if state == "ready" {
				code = "reset_required"
			}
			requireHistoryFault(t, err, code)
		})
	}
}
func TestHistoryLivePageFiltersOnlySelectedPageAndKeepsCursor(t *testing.T) {
	position := historyTestPosition("live", false)
	cursor := position.Cursor()
	cause := errors.New("content wait failed")
	backend := rejectingHistoryBackend(t)
	backend.live = func(ctx context.Context, p model.Principal, project, task, id string, in core.LiveHistoryRequest) (sp.MessagePage, error) {
		if in.Before != cursor || in.Epoch != historyTestEpoch || in.Limit != 7 {
			t.Fatalf("page cursor changed %#v", in)
		}
		return sp.MessagePage{Items: []sp.MessageItem{{Kind: "reasoning"}, {Kind: "assistant_message"}}, BeforeCursor: &cursor, HasMoreBefore: true}, nil
	}
	s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
		return sp.TaskSessionInspection{Source: "live", ContentReadVersion: 1}, nil
	}), backend)
	out, err := s.Read(t.Context(), model.Principal{}, "p", "t", historyTestSession, ReadRequest{Before: cursor, Limit: 7, Conversation: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Data.Items) != 1 || out.Data.Items[0].Kind != "assistant_message" || out.Data.BeforeCursor == nil || *out.Data.BeforeCursor != cursor {
		t.Fatal("filter changed page boundary", out.Data)
	}
	_ = out.Close()
	backend.live = func(context.Context, model.Principal, string, string, string, core.LiveHistoryRequest) (sp.MessagePage, error) {
		return sp.MessagePage{}, cause
	}
	s.backend = backend
	if _, err = s.Read(t.Context(), model.Principal{}, "p", "t", historyTestSession, ReadRequest{}); !errors.Is(err, cause) {
		t.Fatal("live cause lost", err)
	}
}
func TestHistoryLiveEntryPropagatesIdentityCancellationAndBudget(t *testing.T) {
	for _, scenario := range []string{"success", "dependency", "cancel", "budget", "encoding"} {
		t.Run(scenario, func(t *testing.T) {
			position := historyTestPosition("live", true)
			cursor := position.Cursor()
			actor := model.Principal{Kind: model.OAuthCredential, UserID: "owner", CredentialID: "oauth"}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			cause := errors.New("controller failure")
			backend := rejectingHistoryBackend(t)
			calls := 0
			backend.entry = func(actual context.Context, p model.Principal, project, task, id, epoch, token string) (sp.EntryChunk, error) {
				calls++
				if actual != ctx || p != actor || project != "p" || task != "t" || id != historyTestSession || epoch != historyTestEpoch || token != cursor {
					t.Fatal("entry lost frozen identity or context")
				}
				value := sp.EntryChunk{SessionID: id, Source: "live", HistoryEpoch: epoch, EntryID: historyTestEntry, Revision: "1", SHA256: position.SHA256, ByteLength: "3", Offset: "0", Fragment: "abc", EOF: true, ObservedAt: time.Now()}
				switch scenario {
				case "dependency":
					return value, cause
				case "cancel":
					cancel()
				case "budget":
					value.Fragment = strings.Repeat("\x00", sp.MaxEntryChunkBytes)
				case "encoding":
					value.ObservedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
				}
				return value, nil
			}
			s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
				return sp.TaskSessionInspection{Source: "live"}, nil
			}), backend)
			overhead := 0
			if scenario == "budget" {
				overhead = 65536
			}
			out, err := s.Entry(ctx, actor, "p", "t", historyTestSession, EntryRequest{Cursor: cursor, ResponseOverhead: overhead})
			if calls != 1 {
				t.Fatal("entry retried")
			}
			switch scenario {
			case "success":
				if err != nil || out.Data.Fragment != "abc" {
					t.Fatal(out, err)
				}
				if err = out.Close(); err != nil {
					t.Fatal(err)
				}
			case "dependency":
				if !errors.Is(err, cause) {
					t.Fatal(err)
				}
			case "cancel":
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			case "budget":
				requireHistoryFault(t, err, "resource_limit_exceeded")
			case "encoding":
				if err == nil {
					t.Fatal("encoding failure suppressed")
				}
			}
		})
	}
}
func historyArchiveFixtureBytes(t *testing.T, id string) ([]byte, core.HistoryPosition) {
	t.Helper()
	entry, err := sp.DecodeTimeline([]byte(fmt.Sprintf(`{"entryId":%q,"entrySeq":"1","revision":"1","kind":"reasoning","text":"archive text"}`, historyTestEntry)))
	if err != nil {
		t.Fatal(err)
	}
	doc := sp.ArchiveDocument{Fence: sp.Fence{SessionID: id, ClaimID: historyTestEpoch, ExecutionGeneration: "1"}, SchemaVersion: 1, ControllerID: historyTestEpoch, ControllerInstanceID: historyTestEpoch, Provider: "codex", Entries: []sp.TimelineEntry{entry}, Resources: []sp.ArchiveResource{}}
	raw, err := sp.MarshalWire(doc)
	if err != nil {
		t.Fatal(err)
	}
	body, err := v2.CanonicalJSON(entry)
	if err != nil {
		t.Fatal(err)
	}
	hash := v2.HashBytes(raw)
	return raw, core.HistoryPosition{Source: "archive", SessionID: id, Epoch: hash, Version: hash, EntryID: entry.EntryID, Revision: entry.Revision, SHA256: v2.HashBytes(body), ByteLength: strconv.Itoa(len(body)), Offset: "0", Chunk: true}
}
func TestHistoryArchiveEntryRetainsLeaseAndCleansFailures(t *testing.T) {
	for _, scenario := range []string{"success", "dependency", "corrupt", "wrong_identity", "changed_content", "cancel", "close_failure"} {
		t.Run(scenario, func(t *testing.T) {
			raw, position := historyArchiveFixtureBytes(t, historyTestSession)
			stamp := time.Date(2026, 1, 1, 0, 0, 0, 123, time.UTC)
			closeError := errors.New("permit close failed")
			cause := errors.New("archive fetch failed")
			lease := &retainedHistoryFixture{data: raw}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			backend := rejectingHistoryBackend(t)
			switch scenario {
			case "corrupt", "close_failure":
				lease.data = []byte("{}")
			case "wrong_identity":
				lease.data, _ = historyArchiveFixtureBytes(t, historyTestEpoch)
			case "changed_content":
				position.Revision = "2"
			}
			if scenario == "close_failure" {
				lease.closeError = closeError
			}
			backend.archive = func(actual context.Context, p model.Principal, project, task, id string) (core.HistoryArchive, error) {
				if actual != ctx || project != "p" || task != "t" || id != historyTestSession {
					t.Fatal("archive scope changed")
				}
				if scenario == "dependency" {
					return nil, cause
				}
				if scenario == "cancel" {
					cancel()
				}
				return lease, nil
			}
			s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
				return sp.TaskSessionInspection{Source: "archive", Session: sp.TaskSessionObservation{ObservedAt: &stamp}}, nil
			}), backend)
			result, err := s.Entry(ctx, model.Principal{}, "p", "t", historyTestSession, EntryRequest{Cursor: position.Cursor()})
			if scenario == "success" {
				if err != nil || lease.closes != 0 || !result.Data.ObservedAt.Equal(stamp) || !json.Valid([]byte(result.Data.Fragment)) {
					t.Fatalf("entry %#v %v closes=%d", result, err, lease.closes)
				}
				_ = result.Close()
				_ = result.Close()
				if lease.closes != 1 {
					t.Fatal("lease released twice")
				}
				return
			}
			if scenario == "dependency" {
				if !errors.Is(err, cause) || lease.closes != 0 {
					t.Fatal(err, lease.closes)
				}
				return
			}
			if err == nil || lease.closes != 1 {
				t.Fatal("failure did not release", err, lease.closes)
			}
			if scenario == "close_failure" && !errors.Is(err, closeError) {
				t.Fatal("close cause lost", err)
			}
			if scenario == "cancel" && !errors.Is(err, context.Canceled) {
				t.Fatal("cancel cause lost", err)
			}
		})
	}
}
func TestHistoryArchivePageFailuresReleaseLease(t *testing.T) {
	for _, scenario := range []string{"dependency", "wrong_identity", "changed_source", "budget"} {
		t.Run(scenario, func(t *testing.T) {
			raw, position := historyArchiveFixtureBytes(t, historyTestSession)
			lease := &retainedHistoryFixture{data: raw}
			cause := errors.New("archive failed")
			backend := rejectingHistoryBackend(t)
			backend.archive = func(context.Context, model.Principal, string, string, string) (core.HistoryArchive, error) {
				if scenario == "dependency" {
					return nil, cause
				}
				return lease, nil
			}
			s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
				return sp.TaskSessionInspection{Source: "archive"}, nil
			}), backend)
			request := ReadRequest{}
			switch scenario {
			case "wrong_identity":
				lease.data, _ = historyArchiveFixtureBytes(t, historyTestEpoch)
			case "changed_source":
				position.Chunk = false
				position.Sequence = "2"
				position.Version = "old"
				request.Before = position.Cursor()
			case "budget":
				request.ResponseOverhead = sp.MaxHistoryResponseBytes - 1
			}
			_, err := s.Read(t.Context(), model.Principal{}, "p", "t", historyTestSession, request)
			if err == nil {
				t.Fatal("failure suppressed")
			}
			if scenario == "dependency" {
				if !errors.Is(err, cause) || lease.closes != 0 {
					t.Fatal(err, lease.closes)
				}
			} else if lease.closes != 1 {
				t.Fatal("failure retained archive lease")
			}
		})
	}
}
func TestReadResultCloseRetainsErrorAndIsIdempotent(t *testing.T) {
	var nilResult *ReadResult[int]
	if err := nilResult.Close(); err != nil {
		t.Fatal(err)
	}
	cause := errors.New("release failed")
	lease := &retainedHistoryFixture{closeError: cause}
	result := NewReadResult(1, lease)
	for range 2 {
		if !errors.Is(result.Close(), cause) {
			t.Fatal("release error lost")
		}
	}
	if lease.closes != 1 {
		t.Fatal("release repeated")
	}
}
