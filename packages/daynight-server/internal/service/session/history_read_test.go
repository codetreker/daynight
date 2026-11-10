package session

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

type historyReadInspector func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error)

func (f historyReadInspector) Inspect(c context.Context, p model.Principal, pr, ta, id string) (sp.TaskSessionInspection, error) {
	return f(c, p, pr, ta, id)
}

type historyReadBackend struct {
	HistoryBackend
	entry   func(context.Context, model.Principal, string, string, string, string, string) (sp.EntryChunk, error)
	live    func(context.Context, model.Principal, string, string, string, core.LiveHistoryRequest) (sp.MessagePage, error)
	status  func(context.Context, model.Principal, string, string, string) (sp.ArchiveStatus, error)
	archive func(context.Context, model.Principal, string, string, string) (core.HistoryArchive, error)
}

func (b historyReadBackend) ReadLiveEntry(c context.Context, p model.Principal, pr, ta, id, epoch, cursor string) (sp.EntryChunk, error) {
	return b.entry(c, p, pr, ta, id, epoch, cursor)
}
func (b historyReadBackend) ReadLivePage(c context.Context, p model.Principal, pr, ta, id string, in core.LiveHistoryRequest) (sp.MessagePage, error) {
	return b.live(c, p, pr, ta, id, in)
}
func (b historyReadBackend) TaskArchiveStatus(c context.Context, p model.Principal, pr, ta, id string) (sp.ArchiveStatus, error) {
	return b.status(c, p, pr, ta, id)
}
func (b historyReadBackend) TaskArchiveContent(c context.Context, p model.Principal, pr, ta, id string) (core.HistoryArchive, error) {
	return b.archive(c, p, pr, ta, id)
}
func TestHistoryReadRechecksIdentityAndPassesLiveBudget(t *testing.T) {
	p := model.Principal{Kind: model.OAuthCredential, UserID: "owner", CredentialID: "oauth"}
	calls := 0
	refused := errors.New("revoked")
	inspector := historyReadInspector(func(c context.Context, a model.Principal, pr, ta, id string) (sp.TaskSessionInspection, error) {
		calls++
		if a != p || pr != "project" || ta != "task" || id != "session" {
			t.Fatal("identity changed")
		}
		if calls == 2 {
			return sp.TaskSessionInspection{}, refused
		}
		return sp.TaskSessionInspection{SessionID: id, Source: "live", ContentReadVersion: 1}, nil
	})
	backend := historyReadBackend{live: func(c context.Context, a model.Principal, pr, ta, id string, in core.LiveHistoryRequest) (sp.MessagePage, error) {
		if a != p || in.Limit != 20 || in.ResponseOverhead != 100 || in.ContentReadVersion != 1 {
			t.Fatalf("request %#v", in)
		}
		return sp.MessagePage{SessionID: id, Items: []sp.MessageItem{}}, nil
	}}
	s := NewHistory(inspector, backend)
	out, err := s.Read(t.Context(), p, "project", "task", "session", ReadRequest{ResponseOverhead: 100})
	if err != nil {
		t.Fatal(err)
	}
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Read(t.Context(), p, "project", "task", "session", ReadRequest{}); !errors.Is(err, refused) {
		t.Fatal("revoked page was accepted", err)
	}
}
func TestHistoryReadPendingAndHerdrRemainDistinct(t *testing.T) {
	for _, mode := range []string{"web", "herdr"} {
		t.Run(mode, func(t *testing.T) {
			b := historyReadBackend{status: func(context.Context, model.Principal, string, string, string) (sp.ArchiveStatus, error) {
				return sp.ArchiveStatus{State: "pending"}, nil
			}}
			s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
				return sp.TaskSessionInspection{Source: "unavailable", Session: sp.TaskSessionObservation{AgentControlMode: &mode}}, nil
			}), b)
			_, err := s.Read(t.Context(), model.Principal{}, "p", "t", "s", ReadRequest{})
			var f *model.Fault
			if !errors.As(err, &f) {
				t.Fatal(err)
			}
			want := "history_pending"
			if mode == "herdr" {
				want = "unsupported_mode"
			}
			if f.Code != want {
				t.Fatalf("%s want %s", f.Code, want)
			}
		})
	}
}

type retainedHistoryFixture struct {
	data       []byte
	timeline   []byte
	closes     int
	closeError error
}

func (r *retainedHistoryFixture) Bytes() []byte         { return r.data }
func (r *retainedHistoryFixture) TimelineBytes() []byte { return r.timeline }
func (r *retainedHistoryFixture) Close() error          { r.closes++; return r.closeError }
func TestHistoryArchiveProjectionRetainsLeaseAndPreservesPartial(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	claim := "22222222-2222-4222-8222-222222222222"
	entryID := "33333333-3333-4333-8333-333333333333"
	resourceID := "44444444-4444-4444-8444-444444444444"
	entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + entryID + `","entrySeq":"1","revision":"1","kind":"user_message","content":[{"type":"resource","resourceId":"` + resourceID + `","label":"image"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	reason := "missing"
	doc := sp.ArchiveDocument{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}, SchemaVersion: 1, ControllerID: claim, ControllerInstanceID: claim, Provider: "codex", Entries: []sp.TimelineEntry{entry}, Resources: []sp.ArchiveResource{{Resource: sp.Resource{ResourceID: resourceID, Status: "unavailable", Name: "image", Error: &reason}}}}
	raw, err := sp.MarshalWire(doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sp.DecodeArchive(raw); err != nil {
		t.Fatal("fixture", err)
	}
	lease := &retainedHistoryFixture{data: raw}
	backend := historyReadBackend{archive: func(context.Context, model.Principal, string, string, string) (core.HistoryArchive, error) {
		return lease, nil
	}}
	s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
		return sp.TaskSessionInspection{SessionID: id, Source: "archive"}, nil
	}), backend)
	result, err := s.Read(t.Context(), model.Principal{}, "p", "t", id, ReadRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if lease.closes != 0 || result.Data.Source != "archive" || result.Data.Coverage.State != "partial" || len(result.Data.Items) != 1 || len(result.Data.Items[0].Resources) != 1 {
		t.Fatalf("projection %#v closes=%d", result.Data, lease.closes)
	}
	if err = result.Close(); err != nil {
		t.Fatal(err)
	}
	_ = result.Close()
	if lease.closes != 1 {
		t.Fatal("lease released more than once")
	}
	ctx, cancel := context.WithCancel(t.Context())
	backend.archive = func(context.Context, model.Principal, string, string, string) (core.HistoryArchive, error) {
		cancel()
		return lease, nil
	}
	s.backend = backend
	if _, err = s.Read(ctx, model.Principal{}, "p", "t", id, ReadRequest{}); !errors.Is(err, context.Canceled) || lease.closes != 2 {
		t.Fatalf("cancel cleanup %v closes=%d", err, lease.closes)
	}
	lease.data = []byte(`{}`)
	backend.archive = func(context.Context, model.Principal, string, string, string) (core.HistoryArchive, error) {
		return lease, nil
	}
	s.backend = backend
	if _, err = s.Read(t.Context(), model.Principal{}, "p", "t", id, ReadRequest{}); err == nil || lease.closes != 3 {
		t.Fatalf("corruption cleanup %v closes=%d", err, lease.closes)
	}
}

func historySchema3Fixture(t *testing.T) ([]byte, []byte, core.HistoryPosition) {
	t.Helper()
	raw, _ := historyArchiveFixtureBytes(t, historyTestSession)
	legacy, err := sp.DecodeArchive(raw)
	if err != nil {
		t.Fatal(err)
	}
	timeline, err := sp.MarshalWire(sp.ArchiveTimeline{Entries: legacy.Entries})
	if err != nil {
		t.Fatal(err)
	}
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: legacy.SessionID, Fence: legacy.Fence, ControllerID: legacy.ControllerID, ControllerInstanceID: legacy.ControllerInstanceID, Provider: legacy.Provider, Timeline: sp.ArchiveFileReference{FileID: historyTestEntry, SHA256: v2.HashBytes(timeline), ByteLength: strconv.Itoa(len(timeline))}, Resources: []sp.ArchiveResourceReference{}, Completeness: "complete"}
	data, err := sp.MarshalWire(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sp.DecodeArchiveManifest(data); err != nil {
		t.Fatal("fixture", err)
	}
	body, err := v2.CanonicalJSON(legacy.Entries[0])
	if err != nil {
		t.Fatal(err)
	}
	hash := v2.HashBytes(data)
	position := core.HistoryPosition{Source: "archive", SessionID: historyTestSession, Epoch: hash, Version: hash, EntryID: historyTestEntry, Revision: "1", SHA256: v2.HashBytes(body), ByteLength: strconv.Itoa(len(body)), Offset: "0", Chunk: true}
	return data, timeline, position
}

func TestHistorySchema3ReadsIndependentTimelineAndRetainsLease(t *testing.T) {
	data, timeline, position := historySchema3Fixture(t)
	for _, operation := range []string{"page", "entry"} {
		t.Run(operation, func(t *testing.T) {
			lease := &retainedHistoryFixture{data: data, timeline: timeline}
			backend := historyReadBackend{archive: func(context.Context, model.Principal, string, string, string) (core.HistoryArchive, error) {
				return lease, nil
			}}
			s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
				return sp.TaskSessionInspection{Source: "archive"}, nil
			}), backend)
			var close func() error
			if operation == "page" {
				result, e := s.Read(t.Context(), model.Principal{}, "p", "t", historyTestSession, ReadRequest{})
				if e != nil {
					t.Fatal(e)
				}
				if len(result.Data.Items) != 1 || result.Data.Items[0].EntryID != historyTestEntry || result.Data.HistoryEpoch != position.Epoch {
					t.Fatalf("page %#v", result.Data)
				}
				close = result.Close
			} else {
				result, e := s.Entry(t.Context(), model.Principal{}, "p", "t", historyTestSession, EntryRequest{Cursor: position.Cursor()})
				if e != nil {
					t.Fatal(e)
				}
				if v2.HashBytes([]byte(result.Data.Fragment)) != position.SHA256 || result.Data.HistoryEpoch != position.Epoch {
					t.Fatalf("entry %#v", result.Data)
				}
				close = result.Close
			}
			if lease.closes != 0 {
				t.Fatal("archive closed before transport completion")
			}
			if err := close(); err != nil {
				t.Fatal(err)
			}
			_ = close()
			if lease.closes != 1 {
				t.Fatal("lease not released exactly once", lease.closes)
			}
		})
	}
}

func TestHistorySchema3RejectsInvalidIndependentTimeline(t *testing.T) {
	for _, operation := range []string{"page", "entry"} {
		for _, scenario := range []string{"envelope", "manifest", "missing", "invalid", "digest", "length"} {
			t.Run(operation+"/"+scenario, func(t *testing.T) {
				data, timeline, position := historySchema3Fixture(t)
				switch scenario {
				case "envelope":
					data = []byte(`!`)
				case "manifest":
					data = []byte(`{"schemaVersion":3}`)
				case "missing":
					timeline = nil
				case "invalid":
					timeline = []byte(`{}`)
				case "digest":
					timeline = append(timeline, ' ')
				case "length":
					manifest, err := sp.DecodeArchiveManifest(data)
					if err != nil {
						t.Fatal(err)
					}
					manifest.Timeline.ByteLength = strconv.Itoa(len(timeline) + 1)
					data, err = sp.MarshalWire(manifest)
					if err != nil {
						t.Fatal(err)
					}
				}
				lease := &retainedHistoryFixture{data: data, timeline: timeline}
				backend := historyReadBackend{archive: func(context.Context, model.Principal, string, string, string) (core.HistoryArchive, error) {
					return lease, nil
				}}
				s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
					return sp.TaskSessionInspection{Source: "archive"}, nil
				}), backend)
				var err error
				if operation == "page" {
					_, err = s.Read(t.Context(), model.Principal{}, "p", "t", historyTestSession, ReadRequest{})
				} else {
					_, err = s.Entry(t.Context(), model.Principal{}, "p", "t", historyTestSession, EntryRequest{Cursor: position.Cursor()})
				}
				requireHistoryFault(t, err, "source_corrupt")
				if lease.closes != 1 {
					t.Fatal("invalid schema3 retained its permit", lease.closes)
				}
			})
		}
	}
}
