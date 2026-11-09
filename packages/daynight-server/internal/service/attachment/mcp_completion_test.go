package attachment

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/google/uuid"
)

type mcpDeleteCompletion struct {
	store.AttachmentMutationScope
	store.AttachmentMutationDAO
	t         *testing.T
	principal model.Principal
	address   attachmentcore.Address
	calls     []string
	cause     error
}

func (m *mcpDeleteCompletion) called(ctx context.Context, name string) {
	m.t.Helper()
	if ctx.Err() != nil {
		m.t.Fatalf("%s received canceled context: %v", name, ctx.Err())
	}
	m.calls = append(m.calls, name)
}

func (m *mcpDeleteCompletion) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
	m.called(ctx, "transaction")
	if err := fn(m); err != nil {
		m.t.Fatalf("delete operation: %v", err)
	}
	return store.Completion{Outcome: store.TransactionCommitted}, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true, Cause: m.cause}
}

func (m *mcpDeleteCompletion) LockTaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	m.called(ctx, "lock")
	if project != m.address.ProjectID || task != m.address.TaskID {
		m.t.Fatalf("lock address: %s %s", project, task)
	}
	return store.TaskPresence{Found: true}, nil
}

func (m *mcpDeleteCompletion) ProjectAuthorization(ctx context.Context, principal model.Principal, project string) (model.ProjectAccess, error) {
	m.called(ctx, "authorize")
	if principal != m.principal || project != m.address.ProjectID {
		m.t.Fatalf("authorization: %+v %s", principal, project)
	}
	return model.ProjectAccess{}, nil
}

func (m *mcpDeleteCompletion) AttachmentDAO() store.AttachmentMutationDAO { return m }

func (m *mcpDeleteCompletion) Attachment(ctx context.Context, project, task, path string) (model.Attachment, error) {
	m.called(ctx, "metadata")
	if project != m.address.ProjectID || task != m.address.TaskID || path != m.address.RelativePath {
		m.t.Fatalf("metadata address: %s %s %s", project, task, path)
	}
	return model.Attachment{ProjectID: project, TaskID: task, Path: path, ContentType: "text/plain", SizeBytes: 1}, nil
}

func (m *mcpDeleteCompletion) DeleteAttachment(ctx context.Context, project, task, path string) error {
	m.called(ctx, "delete")
	if project != m.address.ProjectID || task != m.address.TaskID || path != m.address.RelativePath {
		m.t.Fatalf("delete address: %s %s %s", project, task, path)
	}
	return nil
}

func TestMCPDeletePreservesCommittedCleanupFact(t *testing.T) {
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	address, err := attachmentcore.NewAddress(uuid.NewString(), uuid.NewString(), "file")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := files.Put(t.Context(), attachmentcore.Bucket, address.StoragePath, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	mock := &mcpDeleteCompletion{t: t, principal: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}, address: address, cause: errors.New("cleanup failed")}
	subject := NewAttachments(nil, mock, files)
	err = subject.Delete(t.Context(), mock.principal, address.ProjectID, address.TaskID, address.RelativePath)
	facts := operation.CompletionFacts(err)
	if !errors.Is(err, mock.cause) || !FileEffectPossible(err) || facts.Outcome != store.TransactionCommitted || !facts.CleanupFailed || strings.Join(mock.calls, ",") != "transaction,lock,authorize,metadata,delete" {
		t.Fatalf("delete completion: calls=%v facts=%+v error=%v", mock.calls, facts, err)
	}
	if object, err := files.Open(t.Context(), attachmentcore.Bucket, address.StoragePath); err == nil {
		_ = object.Body.Close()
		t.Fatal("physical file survived completed delete")
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("observe removed file: %v", err)
	}
}
