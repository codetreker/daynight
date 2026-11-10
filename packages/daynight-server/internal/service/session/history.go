package session

import (
	"context"
	"io"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

type HistoryInspector interface {
	Inspect(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error)
}
type HistoryBackend interface {
	TaskCurrentIdentity(context.Context, model.Principal, string, string) (core.TaskCurrentIdentity, error)
	TaskDirectory(context.Context, model.Principal, string, string, string, int) (sp.TaskSessionList, error)
	ReadLivePage(context.Context, model.Principal, string, string, string, core.LiveHistoryRequest) (sp.MessagePage, error)
	ReadLiveEntry(context.Context, model.Principal, string, string, string, string, string) (sp.EntryChunk, error)
	TaskArchiveContent(context.Context, model.Principal, string, string, string) (core.HistoryArchive, error)
	TaskArchiveStatus(context.Context, model.Principal, string, string, string) (sp.ArchiveStatus, error)
}
type History struct {
	inspection HistoryInspector
	backend    HistoryBackend
}

func NewHistory(inspection HistoryInspector, backend HistoryBackend) *History {
	return &History{inspection: inspection, backend: backend}
}

type ReadRequest struct {
	Limit            int
	Before           string
	Conversation     bool
	ResponseOverhead int
}
type EntryRequest struct {
	Cursor           string
	ResponseOverhead int
}

// ReadResult retains expensive input and its permit until transport completion.
type ReadResult[T any] struct {
	Data     T
	closer   io.Closer
	once     sync.Once
	closeErr error
}

func NewReadResult[T any](data T, closer io.Closer) *ReadResult[T] {
	return &ReadResult[T]{Data: data, closer: closer}
}
func (r *ReadResult[T]) Close() error {
	if r == nil {
		return nil
	}
	r.once.Do(func() {
		if r.closer != nil {
			r.closeErr = r.closer.Close()
		}
	})
	return r.closeErr
}
