package attachment

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func attachmentAuthorization(t *testing.T, p model.Principal, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	values, err := scopepolicy.Normalize(scopepolicy.PAT, ids)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, values, 1)
	if err != nil {
		t.Fatal(err)
	}
	p.Kind = model.PATCredential
	return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestScopedAttachmentRefusalsPrecedeMetadataAndFileEffects(t *testing.T) {
	for _, action := range []string{"list", "put", "retained", "delete", "open"} {
		t.Run(action, func(t *testing.T) {
			_, m, files, task, p := attachmentUnit(t)
			observed := &observedAttachmentStorage{Storage: files}
			auth := attachmentAuthorization(t, p, "task:read")
			subject := NewScopedAttachments(m.service(m, observed), func(_ context.Context, got model.CredentialAuthorization) (model.CredentialAuthorization, error) {
				if !reflect.DeepEqual(got, auth) {
					t.Fatal("current read lost original authority")
				}
				return auth, nil
			})
			if action == "delete" {
				m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
				m.expect("authorize", auth.Principal, task.ProjectID).result = model.ProjectAccess{ProjectID: task.ProjectID}
			} else {
				m.read(auth.Principal, task)
			}
			var err error
			switch action {
			case "list":
				_, err = subject.List(t.Context(), auth, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
			case "put":
				_, _, err = subject.Put(t.Context(), auth, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("content"))
			case "retained":
				var lease io.Closer
				_, _, lease, err = subject.PutRetained(t.Context(), auth, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("content"))
				if lease != nil {
					t.Fatal("refused upload acquired a lease")
				}
			case "delete":
				err = subject.Delete(t.Context(), auth, task.ProjectID, task.ID, "file")
			case "open":
				_, _, err = subject.Open(t.Context(), auth, task.ProjectID, task.ID, "file")
			}
			requireFault(t, err, "insufficient_scope")
			if observed.calls.Load() != 0 {
				t.Fatal("scope refusal reached file IO")
			}
		})
	}
}

func TestScopedAttachmentVisibilityPrecedesScopeRefusal(t *testing.T) {
	base, m, _, task, p := attachmentUnit(t)
	auth := attachmentAuthorization(t, p, "task:read")
	subject := NewScopedAttachments(base, func(context.Context, model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		t.Fatal("invisible resource reached credential refresh")
		return model.CredentialAuthorization{}, nil
	})
	for _, open := range []bool{false, true} {
		m.expect("snapshot").callback = true
		m.expect("projectRead", auth.Principal, task.ProjectID).err = projectReadNotFound()
		var err error
		if open {
			_, _, err = subject.Open(t.Context(), auth, task.ProjectID, task.ID, "secret")
		} else {
			_, err = subject.List(t.Context(), auth, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
		}
		requireFault(t, err, "not_found")
	}
}

func TestScopedAttachmentOpenReadsCurrentAuthority(t *testing.T) {
	for _, name := range []string{"removed scope", "revoked", "identity", "profile", "missing policy", "missing reader", "cancelled"} {
		t.Run(name, func(t *testing.T) {
			base, m, files, task, p := attachmentUnit(t)
			auth := attachmentAuthorization(t, p, "attachment:read")
			observed := &observedAttachmentStorage{Storage: files}
			base.files = observed
			m.read(auth.Principal, task)
			failure := errors.New("credential revoked")
			calls := 0
			reader := AuthorizationReader(func(ctx context.Context, got model.CredentialAuthorization) (model.CredentialAuthorization, error) {
				calls++
				if ctx == nil || !reflect.DeepEqual(got, auth) {
					t.Fatal("credential refresh lost context or identity")
				}
				current := auth
				switch name {
				case "removed scope":
					current = attachmentAuthorization(t, p, "attachment:upload")
				case "revoked":
					return current, failure
				case "identity":
					current.Principal.CredentialID = task.ID
				case "profile":
					current.Profile = model.OAuthAPIProfile
				case "missing policy":
					current.Policy = nil
				case "cancelled":
					return current, context.Canceled
				}
				return current, nil
			})
			if name == "missing reader" {
				reader = nil
			}
			_, object, err := NewScopedAttachments(base, reader).Open(t.Context(), auth, task.ProjectID, task.ID, "file")
			if err == nil || object.Body != nil || observed.calls.Load() != 0 {
				t.Fatalf("current authority failure disclosed content: %+v %v", object, err)
			}
			if name == "removed scope" {
				requireFault(t, err, "insufficient_scope")
			}
			if name == "revoked" && !errors.Is(err, failure) || name == "cancelled" && !errors.Is(err, context.Canceled) {
				t.Fatalf("lost refresh error: %v", err)
			}
			if name != "missing reader" && calls != 1 {
				t.Fatalf("refresh calls = %d", calls)
			}
		})
	}
}

func TestScopedAttachmentCapabilitiesStayIndependent(t *testing.T) {
	base, m, _, task, p := attachmentUnit(t)
	subject := NewScopedAttachments(base, nil)
	upload := attachmentAuthorization(t, p, "attachment:upload", "attachment:read")
	item := attachmentItem(task, "file", "text/plain", 7)
	planAttachmentPut(m, upload.Principal, task, item, true)
	got, created, err := subject.Put(t.Context(), upload, task.ProjectID, task.ID, item.Path, item.ContentType, strings.NewReader("content"))
	if err != nil || !created || !reflect.DeepEqual(got, item) {
		t.Fatalf("upload with metadata read: %+v %t %v", got, created, err)
	}
	planAttachmentPut(m, upload.Principal, task, item, false)
	got, created, lease, err := subject.PutRetained(t.Context(), upload, task.ProjectID, task.ID, item.Path, item.ContentType, strings.NewReader("content"))
	if err != nil || created || lease == nil || !reflect.DeepEqual(got, item) {
		t.Fatalf("retained upload with metadata read: %+v %t %v %v", got, created, lease, err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	read := attachmentAuthorization(t, p, "attachment:read")
	m.read(read.Principal, task)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 1}).result = store.AttachmentPage{Items: []model.Attachment{item}}
	page, err := subject.List(t.Context(), read, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("read-only: %+v %v", page, err)
	}
	remove := attachmentAuthorization(t, p, "attachment:delete")
	planAttachmentDelete(m, remove.Principal, task, item)
	if err := subject.Delete(t.Context(), remove, task.ProjectID, task.ID, item.Path); err != nil {
		t.Fatal(err)
	}
}

func TestScopedAttachmentFullUploadResponseRequiresReadAndUpload(t *testing.T) {
	for _, retained := range []bool{false, true} {
		for _, scope := range []scopepolicy.ScopeID{"attachment:read", "attachment:upload"} {
			t.Run(string(scope)+"/retained="+strconv.FormatBool(retained), func(t *testing.T) {
				_, m, files, task, p := attachmentUnit(t)
				observed := &observedAttachmentStorage{Storage: files}
				auth := attachmentAuthorization(t, p, scope)
				subject := NewScopedAttachments(m.service(m, observed), nil)
				m.read(auth.Principal, task)
				var item model.Attachment
				var created bool
				var err error
				if retained {
					var lease io.Closer
					item, created, lease, err = subject.PutRetained(t.Context(), auth, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("content"))
					if lease != nil {
						t.Fatal("scope-refused upload acquired a lease")
					}
				} else {
					item, created, err = subject.Put(t.Context(), auth, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("content"))
				}
				requireFault(t, err, "insufficient_scope")
				if item != (model.Attachment{}) || created || observed.calls.Load() != 0 {
					t.Fatalf("refusal disclosed metadata or performed file IO: %+v %t calls=%d", item, created, observed.calls.Load())
				}
			})
		}
	}
}

type scopedAttachmentGate struct {
	filestorage.Storage
	waiting chan struct{}
}

func (s scopedAttachmentGate) AcquireGate(ctx context.Context, kind filestorage.GateDomain, path string) (io.Closer, error) {
	close(s.waiting)
	return s.Storage.AcquireGate(ctx, kind, path)
}

type attachmentScopeContextKey struct{}

func TestScopedAttachmentOpenRefreshesAfterTargetGate(t *testing.T) {
	base, m, files, task, p := attachmentUnit(t)
	auth := attachmentAuthorization(t, p, "attachment:read")
	path := attachmentTestStoragePath(task, "file")
	permit, err := files.AcquireGate(t.Context(), filestorage.TargetGate, path)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	waiting := make(chan struct{})
	base.files = scopedAttachmentGate{Storage: files, waiting: waiting}
	var released atomic.Bool
	subject := NewScopedAttachments(base, func(ctx context.Context, got model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		if !released.Load() {
			t.Error("credential refresh preceded target gate admission")
		}
		if ctx.Value(attachmentScopeContextKey{}) != "original" || !reflect.DeepEqual(got, auth) {
			t.Error("credential refresh lost caller context or original authority")
		}
		return attachmentAuthorization(t, p, "attachment:delete"), nil
	})
	m.read(auth.Principal, task)
	ctx := context.WithValue(t.Context(), attachmentScopeContextKey{}, "original")
	result := make(chan error, 1)
	go func() {
		_, _, err := subject.Open(ctx, auth, task.ProjectID, task.ID, "file")
		result <- err
	}()
	select {
	case <-waiting:
	case <-time.After(5 * time.Second):
		t.Fatal("Open never entered target gate")
	}
	released.Store(true)
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		requireFault(t, err, "insufficient_scope")
	case <-time.After(5 * time.Second):
		t.Fatal("Open did not leave target gate")
	}
}

func TestScopedAttachmentOpenedStreamRetainsAdmission(t *testing.T) {
	base, m, files, task, p := attachmentUnit(t)
	auth := attachmentAuthorization(t, p, "attachment:upload")
	current := attachmentAuthorization(t, p, "attachment:read")
	calls := 0
	subject := NewScopedAttachments(base, func(ctx context.Context, _ model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		calls++
		if ctx.Err() != nil {
			t.Fatal(ctx.Err())
		}
		return current, nil
	})
	item := attachmentItem(task, "file", "text/plain", 7)
	if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, item.Path), strings.NewReader("content")); err != nil {
		t.Fatal(err)
	}
	planAttachmentOpen(m, auth.Principal, task, item)
	metadata, object, err := subject.Open(t.Context(), auth, task.ProjectID, task.ID, item.Path)
	if err != nil {
		t.Fatal(err)
	}
	current = attachmentAuthorization(t, p, "attachment:upload")
	content, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if !reflect.DeepEqual(metadata, item) || string(content) != "content" || readErr != nil || closeErr != nil || calls != 1 {
		t.Fatalf("admitted stream: %+v %q %v %v refresh=%d", metadata, content, readErr, closeErr, calls)
	}
}

func TestScopedAttachmentFixedProfilesAndInvalidAuthorization(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.OAuthCredential} {
		base, m, files, task, p := attachmentUnit(t)
		p.Kind = kind
		profile := model.SessionProfile
		if kind == model.OAuthCredential {
			profile = model.OAuthAPIProfile
		}
		auth := model.CredentialAuthorization{Principal: p, Profile: profile}
		item := attachmentItem(task, "file", "text/plain", 7)
		if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, item.Path), strings.NewReader("content")); err != nil {
			t.Fatal(err)
		}
		planAttachmentOpen(m, p, task, item)
		_, object, err := NewScopedAttachments(base, nil).Open(t.Context(), auth, task.ProjectID, task.ID, item.Path)
		if err != nil {
			t.Fatal(err)
		}
		if err := object.Body.Close(); err != nil {
			t.Fatal(err)
		}
	}
	subject := NewScopedAttachments(nil, nil)
	if _, err := subject.List(t.Context(), model.CredentialAuthorization{}, "", "", model.PageRequest{}); err == nil {
		t.Fatal("invalid authorization accepted")
	}
}
