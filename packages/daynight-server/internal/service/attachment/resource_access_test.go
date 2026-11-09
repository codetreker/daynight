package attachment

import (
	"io"
	"reflect"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAttachmentResourcePrincipalAdmission(t *testing.T) {
	_, _, _, task, p := attachmentUnit(t)
	for _, actor := range []model.Principal{{}, {Kind: "unknown", UserID: p.UserID, CredentialID: p.CredentialID}} {
		subject := NewAttachments(nil, nil, nil)
		for _, call := range []func() error{
			func() error {
				_, err := subject.List(t.Context(), actor, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
				return err
			},
			func() error {
				_, _, err := subject.Put(t.Context(), actor, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("content"))
				return err
			},
			func() error {
				_, _, err := subject.Open(t.Context(), actor, task.ProjectID, task.ID, "file")
				return err
			},
			func() error { return subject.Delete(t.Context(), actor, task.ProjectID, task.ID, "file") },
		} {
			requireFault(t, call(), "unauthenticated")
		}
	}
}

func resourceAttachmentRead(m *attachmentMock, p model.Principal, task model.Task, access model.ProjectAccess) {
	m.expect("snapshot").callback = true
	m.expect("access", p, task.ProjectID).result = access
	m.expect("presence", task.ProjectID, task.ID).result = store.TaskPresence{Found: true}
}

func TestAttachmentResourceCurrentMembership(t *testing.T) {
	for _, name := range []string{"outsider", "removed member"} {
		t.Run(name, func(t *testing.T) {
			_, m, files, task, p := attachmentUnit(t)
			if name == "outsider" {
				p.UserID = "ef000000-0000-4000-8000-000000000004"
			}
			observed := &observedAttachmentStorage{Storage: files}
			subject := NewAttachments(m, m, observed)
			secret := attachmentItem(task, "secret.html", "text/plain; charset=utf-8", int64(len("<h1>same-origin</h1>")))
			if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, secret.Path), strings.NewReader("<h1>same-origin</h1>")); err != nil {
				t.Fatal(err)
			}
			if name == "removed member" {
				access := model.ProjectAccess{ProjectID: task.ProjectID, UserID: p.UserID, Role: model.ProjectMemberRole}
				resourceAttachmentRead(m, p, task, access)
				m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 1}).result = store.AttachmentPage{Items: []model.Attachment{secret}}
				page, err := subject.List(t.Context(), p, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
				if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], secret) {
					t.Fatalf("member attachment list: %+v %v", page, err)
				}
				resourceAttachmentRead(m, p, task, access)
				m.metadata(task, secret)
				_, object, err := subject.Open(t.Context(), p, task.ProjectID, task.ID, secret.Path)
				if err != nil {
					t.Fatal(err)
				}
				if err := object.Body.Close(); err != nil {
					t.Fatal(err)
				}
				member := attachmentItem(task, "member.txt", "text/plain", int64(len("Member write")))
				resourceAttachmentRead(m, p, task, access)
				m.mutation(task, store.Completion{Outcome: store.TransactionCommitted})
				m.put(task, member.Path, member.ContentType, member.SizeBytes, member, true)
				if _, _, err := subject.Put(t.Context(), p, task.ProjectID, task.ID, member.Path, member.ContentType, strings.NewReader("Member write")); err != nil {
					t.Fatal(err)
				}
				m.mutation(task, store.Completion{Outcome: store.TransactionCommitted})
				m.expect("authorize", p, task.ProjectID).result = access
				m.metadata(task, member)
				m.expect("delete", task.ProjectID, task.ID, member.Path)
				if err := subject.Delete(t.Context(), p, task.ProjectID, task.ID, member.Path); err != nil {
					t.Fatal(err)
				}
			}
			before := observed.calls.Load()
			refusedRead := func() {
				m.expect("snapshot").callback = true
				m.expect("access", p, task.ProjectID).err = model.ErrNotFound
			}
			refusedMutation := func() {
				m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
				m.expect("authorize", p, task.ProjectID).err = model.ErrNotFound
			}
			refusedRead()
			_, err := subject.List(t.Context(), p, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
			requireFault(t, err, "not_found")
			refusedRead()
			_, _, err = subject.Open(t.Context(), p, task.ProjectID, task.ID, "secret.html")
			requireFault(t, err, "not_found")
			refusedRead()
			refusedMutation()
			_, _, err = subject.Put(t.Context(), p, task.ProjectID, task.ID, "member.txt", "text/plain", strings.NewReader("Member write"))
			requireFault(t, err, "not_found")
			refusedMutation()
			requireFault(t, subject.Delete(t.Context(), p, task.ProjectID, task.ID, "member.txt"), "not_found")
			if observed.calls.Load() != before {
				t.Fatal("unadmitted attachment operation reached file IO")
			}
		})
	}
}

func TestInheritedProjectOwnerUsesAttachmentOperations(t *testing.T) {
	subject, m, _, task, p := attachmentUnit(t)
	role := model.ProjectAdmin
	access := model.ProjectAccess{ProjectID: task.ProjectID, UserID: p.UserID, Role: role, TeamRole: &role, OwnerTeam: model.TeamRef{ID: "ef000000-0000-4000-8000-000000000003", Kind: "personal"}, Ownership: model.ProjectOwnership{TeamID: "ef000000-0000-4000-8000-000000000003", Version: 1}, CanTransfer: true}
	const path, content = "inherited.txt", "Inherited attachment"
	item := attachmentItem(task, path, "text/plain; charset=utf-8", int64(len(content)))
	resourceAttachmentRead(m, p, task, access)
	m.mutation(task, store.Completion{Outcome: store.TransactionCommitted})
	m.put(task, path, item.ContentType, item.SizeBytes, item, true)
	got, created, err := subject.Put(t.Context(), p, task.ProjectID, task.ID, path, item.ContentType, strings.NewReader(content))
	if err != nil || !created || !reflect.DeepEqual(got, item) {
		t.Fatalf("inherited attachment write: %+v %t %v", got, created, err)
	}
	resourceAttachmentRead(m, p, task, access)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 10}).result = store.AttachmentPage{Items: []model.Attachment{item}}
	page, err := subject.List(t.Context(), p, task.ProjectID, task.ID, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], item) {
		t.Fatalf("inherited attachment list: %+v %v", page, err)
	}
	resourceAttachmentRead(m, p, task, access)
	m.metadata(task, item)
	metadata, object, err := subject.Open(t.Context(), p, task.ProjectID, task.ID, path)
	if err != nil {
		t.Fatal(err)
	}
	bytes, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(bytes) != content || !reflect.DeepEqual(metadata, item) {
		t.Fatalf("inherited attachment read: %q %+v %v %v", bytes, metadata, readErr, closeErr)
	}
	m.mutation(task, store.Completion{Outcome: store.TransactionCommitted})
	m.expect("authorize", p, task.ProjectID).result = access
	m.metadata(task, item)
	m.expect("delete", task.ProjectID, task.ID, path)
	if err := subject.Delete(t.Context(), p, task.ProjectID, task.ID, path); err != nil {
		t.Fatal(err)
	}
}
