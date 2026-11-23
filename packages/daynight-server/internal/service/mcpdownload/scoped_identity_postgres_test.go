package mcpdownload

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
)

func TestScopedTransferReadUsesCurrentBoundAuthority(t *testing.T) {
	f := newAcceptanceFixture(t)
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE personal_access_tokens SET business_scopes=ARRAY['attachment:read','attachment:upload'],scope_version=1 WHERE id=$1`, f.actor.Principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	lifecycle, err := mcptransfer.NewScoped(f.db, f.files, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := lifecycle.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	service := New(f.attachments, lifecycle, f.files)
	var absent *Service
	if absent.Scoped() || f.service.Scoped() || !service.Scoped() {
		t.Fatal("download service did not reflect lifecycle policy mode")
	}
	id := uuid.NewString()
	binding := mcptransfer.Binding{ID: id, Direction: "upload", ProjectID: f.input.ProjectID, TaskID: f.input.TaskID, Path: "file", ContentType: "text/plain"}
	if _, created, err := lifecycle.OpenRecord(t.Context(), f.actor, binding); err != nil || !created {
		t.Fatalf("open transfer: created=%v error=%v", created, err)
	}
	record, err := lifecycle.LookupBoundForRead(t.Context(), f.actor, id)
	if err != nil || record.ID != id || record.Path != binding.Path {
		t.Fatalf("authorized read: %+v %v", record, err)
	}
	other := f.actor
	other.Principal.CredentialID = uuid.NewString()
	other.AuthorityID = other.Principal.CredentialID
	if _, err := lifecycle.LookupBoundForRead(t.Context(), other, id); err == nil {
		t.Fatal("another credential read the bound transfer")
	}
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE personal_access_tokens SET business_scopes=ARRAY['attachment:upload'],scope_version=2 WHERE id=$1`, f.actor.Principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	record, err = lifecycle.LookupBoundForRead(t.Context(), f.actor, id)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || record.ID != "" {
		t.Fatalf("read after narrowing: %+v %v", record, err)
	}
	if _, err := lifecycle.LookupBound(t.Context(), f.actor, id); err != nil {
		t.Fatalf("upload authority should remain usable: %v", err)
	}
}
