package attachment

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTransferAuthorizationPrecedesBothConflictReads(t *testing.T) {
	for _, phase := range []string{"admission", "publication"} {
		t.Run(phase, func(t *testing.T) {
			a, m, files, task, principal := attachmentUnit(t)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			ns := transferNamespace(t)
			private, err := files.AcquireGate(ctx, filestorage.PrivateGate, ns.ID())
			if err != nil {
				t.Fatal(err)
			}
			defer private.Close()
			entered, release := make(chan struct{}), make(chan struct{})
			denied := errors.New("scope narrowed")
			calls := 0
			authorize := func(ctx context.Context, scope store.AttachmentMutationScope) error {
				calls++
				if scope != m {
					t.Error("authorization did not receive the active mutation scope")
				}
				if phase == "publication" && calls == 1 {
					return nil
				}
				close(entered)
				select {
				case <-release:
					return denied
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			if phase == "admission" {
				m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
				m.expect("authorize", principal, task.ProjectID).result = model.ProjectAccess{}
			} else {
				expectTransferAdmission(m, principal, task, "file")
			}
			result := make(chan error, 1)
			go func() {
				admission, err := a.AdmitTransferAuthorized(ctx, principal, task.ProjectID, task.ID, "file", "text/plain", ns, authorize)
				if err == nil {
					defer admission.Close()
					m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
					m.expect("live", task.ProjectID)
					_, _, err = admission.PutFrom(ctx, func(store.AttachmentMutationScope) (io.ReadCloser, error) {
						t.Error("denied publication opened its source")
						return io.NopCloser(strings.NewReader("x")), nil
					})
				}
				result <- err
			}()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("authorization did not reach barrier")
			}
			close(release)
			select {
			case err := <-result:
				if !errors.Is(err, denied) || FileEffectPossible(err) {
					t.Fatalf("denial=%v", err)
				}
			case <-ctx.Done():
				t.Fatal("operation did not drain")
			}
			requireTransferMissing(t, files, task, "file")
		})
	}
}

func TestExplicitAttachmentAdmissionRequiresCallback(t *testing.T) {
	a, _, _, task, principal := attachmentUnit(t)
	if _, err := a.AdmitTransferAuthorized(t.Context(), principal, task.ProjectID, task.ID, "file", "text/plain", transferNamespace(t), nil); err == nil {
		t.Fatal("transfer admission accepted a missing authorization callback")
	}
	if _, _, err := a.OpenAdmitted(t.Context(), principal, task.ProjectID, task.ID, "file", nil); err == nil {
		t.Fatal("open accepted a missing authorization callback")
	}
	var missing *Attachments
	if _, _, err := missing.OpenAdmitted(t.Context(), principal, task.ProjectID, task.ID, "file", func(context.Context) error { return nil }); err == nil {
		t.Fatal("nil attachment service accepted")
	}
}

func TestOpenAdmittedRefusesBeforeMetadataLookup(t *testing.T) {
	a, _, _, task, principal := attachmentUnit(t)
	denied := errors.New("current credential refused")
	calls := 0
	_, object, err := a.OpenAdmitted(t.Context(), principal, task.ProjectID, task.ID, "file", func(ctx context.Context) error {
		calls++
		if ctx.Err() != nil {
			t.Error("admission context cancelled")
		}
		return denied
	})
	if !errors.Is(err, denied) || calls != 1 || object.Body != nil {
		t.Fatalf("open denial=%v calls=%d", err, calls)
	}
}
