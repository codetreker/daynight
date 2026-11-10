package session

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
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
	closes     int
	closeError error
}

func (r *retainedHistoryFixture) Bytes() []byte { return r.data }
func (r *retainedHistoryFixture) Close() error  { r.closes++; return r.closeError }
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
