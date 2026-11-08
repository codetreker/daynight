package task

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type threadSourceStore struct {
	store.SnapshotReader
	t    *testing.T
	work func(context.Context, func(store.ThreadScope) error) (store.Completion, error)
}

func (s threadSourceStore) WriteThread(ctx context.Context, callback func(store.ThreadScope) error) (store.Completion, error) {
	s.t.Helper()
	if s.work == nil {
		s.t.Fatal("invalid thread input entered its source transaction")
	}
	return s.work(ctx, callback)
}

type replySourceTaskDAO struct {
	store.ThreadTaskDAO
	t     *testing.T
	calls *[]string
}

func (d replySourceTaskDAO) LockTaskPresence(_ context.Context, projectID, taskID string) (store.TaskPresence, error) {
	d.t.Helper()
	if projectID != sourceProjectID || taskID != sourceTaskID {
		d.t.Fatal("unexpected reply source identity")
	}
	*d.calls = append(*d.calls, "presence")
	return store.TaskPresence{Found: true}, nil
}

type replySourceCredentialDAO struct {
	store.ThreadCredentialDAO
	t     *testing.T
	calls *[]string
}

func (d replySourceCredentialDAO) Credential(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
	d.t.Helper()
	if p != sourcePrincipal() {
		d.t.Fatal("unexpected reply source credential")
	}
	*d.calls = append(*d.calls, "credential")
	return store.ThreadCredential{}, nil
}

func (d replySourceCredentialDAO) AuthorName(_ context.Context, userID string) (*string, error) {
	d.t.Helper()
	if userID != sourceUserID {
		d.t.Fatal("unexpected reply source author")
	}
	*d.calls = append(*d.calls, "name")
	return nil, nil
}

type replySourceProjectDAO struct {
	store.ThreadProjectDAO
	t     *testing.T
	calls *[]string
}

func (d replySourceProjectDAO) LockProjectAuthorization(_ context.Context, p model.Principal, projectID string) (model.ProjectAccess, error) {
	d.t.Helper()
	if p != sourcePrincipal() || projectID != sourceProjectID {
		d.t.Fatal("unexpected reply source authorization")
	}
	*d.calls = append(*d.calls, "authorization")
	return model.ProjectAccess{ProjectID: sourceProjectID, UserID: sourceUserID, Role: model.ProjectAdmin}, nil
}

type replySourceMessageDAO struct {
	store.ThreadDAO
	t     *testing.T
	calls *[]string
	reply string
}

func (d replySourceMessageDAO) LockHead(_ context.Context, taskID string) (*model.ThreadPosition, error) {
	d.t.Helper()
	if taskID != sourceTaskID {
		d.t.Fatal("unexpected reply source head")
	}
	*d.calls = append(*d.calls, "head")
	return nil, nil
}

func (d replySourceMessageDAO) ThreadMessage(_ context.Context, taskID, messageID string) (model.ThreadMessage, error) {
	d.t.Helper()
	if taskID != sourceTaskID || messageID != d.reply {
		d.t.Fatal("unexpected reply source lookup")
	}
	*d.calls = append(*d.calls, "reply")
	return model.ThreadMessage{}, model.ErrNotFound
}

type replySourceScope struct {
	tasks       replySourceTaskDAO
	credentials replySourceCredentialDAO
	projects    replySourceProjectDAO
	messages    replySourceMessageDAO
	capture     store.WebhookCaptureDAO
}

func (s replySourceScope) TaskDAO() store.ThreadTaskDAO             { return s.tasks }
func (s replySourceScope) CredentialDAO() store.ThreadCredentialDAO { return s.credentials }
func (s replySourceScope) ProjectDAO() store.ThreadProjectDAO       { return s.projects }
func (s replySourceScope) ThreadDAO() store.ThreadDAO               { return s.messages }
func (s replySourceScope) CaptureDAO() store.WebhookCaptureDAO      { return s.capture }

func TestThreadSourceRefusalsDoNotInvokeCapture(t *testing.T) {
	for _, mode := range []string{"empty body", "missing reply"} {
		t.Run(mode, func(t *testing.T) {
			calls := []string{}
			marker := &sourceCaptureDAO{}
			record := &sourceCapture{t: t, dao: marker, trace: &calls}
			ctx := context.WithValue(t.Context(), sourceContextKey{}, record)
			database := threadSourceStore{t: t}
			input := CreateThreadMessage{}
			if mode == "missing reply" {
				input.Body = "Reply"
				input.ReplyTo = sourcePointer("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
				scope := replySourceScope{tasks: replySourceTaskDAO{t: t, calls: &calls}, credentials: replySourceCredentialDAO{t: t, calls: &calls}, projects: replySourceProjectDAO{t: t, calls: &calls}, messages: replySourceMessageDAO{t: t, calls: &calls, reply: *input.ReplyTo}, capture: marker}
				database.work = func(ctx context.Context, fn func(store.ThreadScope) error) (store.Completion, error) {
					err := fn(scope)
					if err == nil {
						t.Fatal("missing reply source transaction succeeded")
					}
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
			}
			_, err := NewTaskThreads(database, record).Post(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, input)
			want := "invalid_input"
			if mode == "missing reply" {
				want = "message_not_found"
				if !reflect.DeepEqual(calls, []string{"presence", "credential", "authorization", "name", "head", "reply"}) {
					t.Fatalf("reply refusal source order: %v", calls)
				}
			}
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != want || len(record.calls) != 0 {
				t.Fatalf("thread refusal invoked capture: %v %v", record.calls, err)
			}
		})
	}
}
