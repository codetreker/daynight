package mcptransfer

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
)

func TestUploadPublicationRechecksPolicyBeforeFileEffect(t *testing.T) {
	for _, missing := range []scopepolicy.ScopeID{"attachment:upload", "attachment:read"} {
		t.Run(string(missing), func(t *testing.T) {
			h := newUploadHarness(t)
			r := h.record("scope-publication", 1)
			content := []byte("a")
			chunks := h.seed(r, content)
			plan, admission := h.commit(h.actor, r, chunks, content, uploadAttachment(r, 1), true, scopepolicy.ErrInsufficientScope, nil, nil)
			h.uploads.scopedAttachments = &attachmentservice.ScopedAttachments{}
			entered, release := make(chan struct{}), make(chan struct{})
			effects := 0
			admission.effect = func(context.Context, []byte) { effects++ }
			admission.scope.credential = func(ctx context.Context, p model.Principal, kind, id, project, task string) (model.CredentialAuthorization, error) {
				if p != h.actor.Principal || kind != h.actor.AuthorityKind || id != h.actor.AuthorityID || project != r.ProjectID || task != r.TaskID {
					t.Errorf("publication lost transfer authority or target")
				}
				close(entered)
				select {
				case <-release:
				case <-ctx.Done():
					return model.CredentialAuthorization{}, ctx.Err()
				}
				remaining := scopepolicy.ScopeID("attachment:read")
				if missing == remaining {
					remaining = "attachment:upload"
				}
				policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{remaining}, 2)
				if err != nil {
					return model.CredentialAuthorization{}, err
				}
				return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}, nil
			}
			h.uploads.admitScopedTransfer = func(_ context.Context, p model.Principal, project, task, path, contentType string, ns filestorage.TransferNamespace, authorize func(context.Context, store.AttachmentMutationScope) error) (transferAdmission, error) {
				admission.authorize = authorize
				return h.uploads.admitTransfer(t.Context(), p, project, task, path, contentType, ns)
			}
			result := make(chan uploadCallResult, 1)
			go func() {
				data, err := h.uploads.execute(t.Context(), nil, h.actor, r.ProjectID, r.TaskID, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "1"})
				result <- uploadCallResult{data, err}
			}()
			waitUpload(t, entered)
			close(release)
			got := awaitUpload(t, result)
			if !errors.Is(got.err, scopepolicy.ErrInsufficientScope) || got.data["writeOutcome"] != "not_committed" || effects != 0 || admission.scope.calls != 0 || plan.pending().State != "cleanup_pending" {
				t.Fatalf("result=%v err=%v effects=%d receipt reads=%d", got.data, got.err, effects, admission.scope.calls)
			}
		})
	}
}
