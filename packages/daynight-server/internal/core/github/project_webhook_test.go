package github

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type webhookStub struct {
	access model.ProjectAccess
	locked store.GitHubProjectWebhookLocked
	writes []store.GitHubProjectWebhookWrite
	err    error
}

func (d *webhookStub) Authorization(context.Context, model.Principal) (model.ProjectAccess, error) {
	return d.access, d.err
}
func (d *webhookStub) LockWebhook(context.Context) (store.GitHubProjectWebhookLocked, error) {
	return d.locked, d.err
}
func (d *webhookStub) SaveWebhook(_ context.Context, w store.GitHubProjectWebhookWrite) (bool, error) {
	d.writes = append(d.writes, w)
	return true, d.err
}
func webhookPtr[T any](v T) *T { return &v }
func webhookFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}
func TestProjectWebhookManagement(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: "0a899030-f53c-4c48-b94d-86eb8bb4e10f", CredentialID: "a49daf2b-e422-4d81-a961-e090b689bca0"}
	repo := int64(42)
	version := int64(3)
	received := time.Now()
	base := store.GitHubProjectWebhookLocked{GitHubProjectWebhook: store.GitHubProjectWebhook{Version: &version, RepositoryID: &repo, CurrentRepositoryID: &repo, Enabled: true, LastReceivedAt: &received}, Secret: []byte("old"), Exists: true, BindingValid: true}
	tests := []struct {
		name            string
		setup           func(*webhookStub, *ProjectWebhookInput)
		code            string
		writes          int
		expectedVersion int64
	}{
		{"same value", func(d *webhookStub, i *ProjectWebhookInput) {}, "", 0, 3},
		{"rotate", func(d *webhookStub, i *ProjectWebhookInput) { i.Secret = webhookPtr("new") }, "", 1, 4},
		{"disable disconnected", func(d *webhookStub, i *ProjectWebhookInput) {
			d.locked.BindingValid = false
			d.locked.CurrentRepositoryID = nil
			i.Enabled = false
		}, "", 1, 4},
		{"revoked same value", func(d *webhookStub, i *ProjectWebhookInput) { d.locked.BindingValid = false }, "", 0, 3},
		{"enable denied", func(d *webhookStub, i *ProjectWebhookInput) { d.locked.Enabled = false; d.locked.BindingValid = false }, "github_not_connected", 0, 0},
		{"repo mismatch", func(d *webhookStub, i *ProjectWebhookInput) {
			i.RepositoryID = webhookPtr(int64(99))
			i.Secret = webhookPtr("new")
		}, "github_repository_mismatch", 0, 0},
		{"rebind needs secret", func(d *webhookStub, i *ProjectWebhookInput) { i.RepositoryID = webhookPtr(int64(99)) }, "invalid_input", 0, 0},
		{"stale", func(d *webhookStub, i *ProjectWebhookInput) { i.Version = webhookPtr(int64(2)) }, "version_conflict", 0, 0},
		{"exhausted", func(d *webhookStub, i *ProjectWebhookInput) {
			d.locked.Version = webhookPtr(int64(math.MaxInt64))
			i.Version = d.locked.Version
			i.Enabled = false
		}, "version_exhausted", 0, 0},
		{"member", func(d *webhookStub, i *ProjectWebhookInput) { d.access.Role = model.ProjectMemberRole }, "forbidden", 0, 0},
		{"no row", func(d *webhookStub, i *ProjectWebhookInput) { d.locked.Exists = false }, "github_not_connected", 0, 0},
		{"create", func(d *webhookStub, i *ProjectWebhookInput) {
			d.locked.Version = nil
			d.locked.RepositoryID = nil
			d.locked.Secret = nil
			i.Version = nil
			i.RepositoryID = &repo
			i.Secret = webhookPtr("new")
		}, "", 1, 1},
		{"missing secret", func(d *webhookStub, i *ProjectWebhookInput) {
			d.locked.Version = nil
			d.locked.RepositoryID = nil
			d.locked.Secret = nil
			i.Version = nil
			i.RepositoryID = &repo
		}, "invalid_input", 0, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := &webhookStub{access: model.ProjectAccess{Role: model.ProjectAdmin}, locked: base}
			in := ProjectWebhookInput{ExpectedUserID: p.UserID, Version: &version, Enabled: true}
			tc.setup(d, &in)
			out, err := ManageProjectWebhook(t.Context(), d, p, in)
			if tc.code != "" {
				webhookFault(t, err, tc.code)
			} else if err != nil || out.Version == nil || *out.Version != tc.expectedVersion {
				t.Fatalf("result %+v %v", out, err)
			}
			if len(d.writes) != tc.writes {
				t.Fatalf("writes %+v", d.writes)
			}
			if len(d.writes) > 0 && (d.writes[0].Version != tc.expectedVersion || out.LastReceivedAt != nil) {
				t.Fatalf("write %+v, output %+v", d.writes, out)
			}
			if tc.name == "same value" && out.LastReceivedAt == nil {
				t.Fatal("no-op lost receipt")
			}
		})
	}
}

func TestValidateProjectWebhookInput(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: "0a899030-f53c-4c48-b94d-86eb8bb4e10f", CredentialID: "a49daf2b-e422-4d81-a961-e090b689bca0"}
	for _, tc := range []struct {
		name  string
		input ProjectWebhookInput
		code  string
	}{
		{"nul", ProjectWebhookInput{ExpectedUserID: p.UserID, Secret: webhookPtr("a\x00b")}, ""},
		{"empty", ProjectWebhookInput{ExpectedUserID: p.UserID, Secret: webhookPtr("")}, "invalid_input"},
		{"invalid utf8", ProjectWebhookInput{ExpectedUserID: p.UserID, Secret: webhookPtr(string([]byte{0xff}))}, "invalid_input"},
		{"large", ProjectWebhookInput{ExpectedUserID: p.UserID, Secret: webhookPtr(strings.Repeat("a", 4097))}, "invalid_input"},
		{"boundary", ProjectWebhookInput{ExpectedUserID: p.UserID, Secret: webhookPtr(strings.Repeat("a", 4096))}, ""},
		{"version", ProjectWebhookInput{ExpectedUserID: p.UserID, Version: webhookPtr(int64(0))}, "invalid_input"},
		{"repository", ProjectWebhookInput{ExpectedUserID: p.UserID, RepositoryID: webhookPtr(int64(0))}, "invalid_input"},
		{"identity", ProjectWebhookInput{ExpectedUserID: "69bf21da-1686-4d1f-969a-cce6ee2185f6"}, "identity_mismatch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateProjectWebhookInput(p, tc.input)
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				webhookFault(t, err, tc.code)
			}
		})
	}
}
