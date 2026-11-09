package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRuntimeAttachmentPathAndCursorBoundary(t *testing.T) {
	project := api.Project{ID: "c3333333-3333-4333-8333-333333333333"}
	task := api.Task{ProjectID: project.ID, ID: "d4444444-4444-4444-8444-444444444444"}
	segments := make([]string, 13)
	for i := range segments {
		segments[i] = strings.Repeat("中", 78)
	}
	segments[12] = strings.Repeat("中", 76)
	path := strings.Join(segments, "/")
	if utf8.RuneCountInString(path) != attachmentcore.MaxPathCharacters {
		t.Fatal("attachment path fixture has the wrong code-point length")
	}
	if err := attachmentcore.ValidateWritePath(path); err != nil {
		t.Fatal(err)
	}
	page, err := attachmentcore.MakePage(store.AttachmentPage{Items: []model.Attachment{{Path: path}}, HasMore: true}, project.ID, task.ID)
	if err != nil || page.NextCursor == nil {
		t.Fatalf("generate attachment cursor: %v", err)
	}
	database := newHTTPTestStore(t)
	configureTransportAttachments(t, database, project.ID, task.ID, path)
	handler := projectTestHandler(t, database, io.Discard)
	addr := startBoundaryRuntime(t, handler)
	client := &http.Client{Timeout: 5 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	do := func(method, target, body string) *http.Response {
		t.Helper()
		request, err := http.NewRequest(method, "http://"+addr+target, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+handler.token)
		if method == http.MethodPut {
			request.Header.Set("Content-Type", "text/plain")
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	filePath := attachmentFilePath(task, path)
	if !strings.Contains(filePath, "%E4%B8%AD") {
		t.Fatal("attachment URL was not percent encoded")
	}
	put := do(http.MethodPut, filePath, "boundary-content")
	putBody, err := io.ReadAll(put.Body)
	_ = put.Body.Close()
	if err != nil || put.StatusCode != http.StatusCreated {
		t.Fatalf("put status=%d body=%s error=%v", put.StatusCode, putBody, err)
	}
	read := do(http.MethodGet, filePath, "")
	data, err := io.ReadAll(read.Body)
	_ = read.Body.Close()
	if err != nil || read.StatusCode != http.StatusOK || string(data) != "boundary-content" {
		t.Fatalf("read status=%d body=%q error=%v", read.StatusCode, data, err)
	}
	other := do(http.MethodPut, attachmentFilePath(task, "😀"), "next")
	otherBody, err := io.ReadAll(other.Body)
	_ = other.Body.Close()
	if err != nil || other.StatusCode != http.StatusCreated {
		t.Fatalf("second put status=%d body=%s error=%v", other.StatusCode, otherBody, err)
	}
	list := do(http.MethodGet, taskPath(task)+"/attachments?limit=1&cursor="+url.QueryEscape(*page.NextCursor), "")
	var result api.AttachmentPage
	err = json.NewDecoder(list.Body).Decode(&result)
	_ = list.Body.Close()
	if err != nil || list.StatusCode != http.StatusOK || len(result.Items) != 1 || result.Items[0].Path != "😀" {
		t.Fatalf("cursor list status=%d page=%+v error=%v", list.StatusCode, result, err)
	}
}

// Static DAO results keep the transport path and cursor test independent of
// persistence; actual upload and download bytes still use the local storage.
func configureTransportAttachments(t *testing.T, database *httpTestStore, projectID, taskID, path string) {
	t.Helper()
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	first := model.Attachment{ProjectID: projectID, TaskID: taskID, Path: path, ContentType: "text/plain", SizeBytes: 16, CreatedAt: at, UpdatedAt: at}
	second := model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "😀", ContentType: "text/plain", SizeBytes: 4, CreatedAt: at, UpdatedAt: at}
	var ancestors []string
	segments := strings.Split(path, "/")
	for end := 1; end < len(segments); end++ {
		ancestors = append(ancestors, strings.Join(segments[:end], "/"))
	}
	conflicts := []store.AttachmentConflictQuery{{Ancestors: ancestors, DescendantPrefix: path + "/"}, {Ancestors: []string{}, DescendantPrefix: "😀/"}}
	items := []model.Attachment{first, second}
	plan := newHTTPCallPlan(t, map[string]int{"snapshot": 4, "access": 4, "presence": 4, "mutation": 2, "lock": 2, "live": 2, "conflict": 2, "put": 2, "read": 1, "list": 1})
	count := plan.Called
	var conflictIndex, putIndex atomic.Int32
	check := func(got, want any) {
		if !reflect.DeepEqual(got, want) {
			t.Errorf("transport attachment DAO arguments: got %#v, want %#v", got, want)
			panic("transport attachment DAO arguments")
		}
	}
	ids := func(project, task string) { check(project, projectID); check(task, taskID) }
	access := transportAttachmentProjectReader{access: func(_ context.Context, principal model.Principal, project string) (model.ProjectAccess, error) {
		count("access")
		check(principal, defaultHTTPPrincipal())
		check(project, projectID)
		return model.ProjectAccess{ProjectID: projectID, UserID: principal.UserID, Role: model.ProjectMemberRole}, nil
	}}
	tasks := transportAttachmentTaskReader{presence: func(_ context.Context, project, task string) (store.TaskPresence, error) {
		count("presence")
		ids(project, task)
		return store.TaskPresence{Found: true}, nil
	}}
	dao := transportAttachmentDAO{
		read: func(_ context.Context, project, task, name string) (model.Attachment, error) {
			count("read")
			ids(project, task)
			check(name, path)
			return first, nil
		},
		list: func(_ context.Context, project, task string, query store.AttachmentQuery) (store.AttachmentPage, error) {
			count("list")
			ids(project, task)
			check(query, store.AttachmentQuery{After: &path, Limit: 1})
			return store.AttachmentPage{Items: []model.Attachment{second}}, nil
		},
		conflict: func(_ context.Context, project, task string, query store.AttachmentConflictQuery) (bool, error) {
			count("conflict")
			index := int(conflictIndex.Add(1)) - 1
			ids(project, task)
			check(query, conflicts[index])
			return false, nil
		},
		put: func(_ context.Context, item model.Attachment) (model.Attachment, bool, error) {
			count("put")
			index := int(putIndex.Add(1)) - 1
			result := items[index]
			check(item, model.Attachment{ProjectID: projectID, TaskID: taskID, Path: result.Path, ContentType: result.ContentType, SizeBytes: result.SizeBytes})
			return result, true, nil
		},
	}
	database.ReadSnapshotCall = func(ctx context.Context, operation func(store.SnapshotScope) error) error {
		count("snapshot")
		snapshot := newHTTPTestSnapshot(t)
		snapshot.Projects, snapshot.Tasks, snapshot.Attachments = access, tasks, dao
		return operation(snapshot)
	}
	database.WriteAttachmentMutationCall = func(ctx context.Context, operation func(store.AttachmentMutationScope) error) (store.Completion, error) {
		count("mutation")
		err := operation(transportAttachmentMutation{
			lock: func(_ context.Context, project, task string) (store.TaskPresence, error) {
				count("lock")
				ids(project, task)
				return store.TaskPresence{Found: true}, nil
			},
			live:       func(_ context.Context, project string) error { count("live"); check(project, projectID); return nil },
			attachment: dao,
		})
		if err != nil {
			t.Errorf("transport attachment mutation callback: %v", err)
		}
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}

}

type transportAttachmentProjectReader struct {
	store.ProjectReader
	access func(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

func (d transportAttachmentProjectReader) ProjectAccess(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
	return d.access(ctx, principal, id)
}

type transportAttachmentTaskReader struct {
	store.TaskReader
	presence func(context.Context, string, string) (store.TaskPresence, error)
}

func (d transportAttachmentTaskReader) TaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	return d.presence(ctx, project, task)
}

type transportAttachmentMutation struct {
	store.AttachmentMutationScope
	lock       func(context.Context, string, string) (store.TaskPresence, error)
	live       func(context.Context, string) error
	attachment store.AttachmentMutationDAO
}

func (s transportAttachmentMutation) LockTaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	return s.lock(ctx, project, task)
}
func (s transportAttachmentMutation) ProjectLive(ctx context.Context, project string) error {
	return s.live(ctx, project)
}
func (s transportAttachmentMutation) AttachmentDAO() store.AttachmentMutationDAO { return s.attachment }

type transportAttachmentDAO struct {
	store.AttachmentMutationDAO
	read     func(context.Context, string, string, string) (model.Attachment, error)
	list     func(context.Context, string, string, store.AttachmentQuery) (store.AttachmentPage, error)
	conflict func(context.Context, string, string, store.AttachmentConflictQuery) (bool, error)
	put      func(context.Context, model.Attachment) (model.Attachment, bool, error)
}

func (d transportAttachmentDAO) Attachment(ctx context.Context, project, task, path string) (model.Attachment, error) {
	return d.read(ctx, project, task, path)
}
func (d transportAttachmentDAO) Attachments(ctx context.Context, project, task string, query store.AttachmentQuery) (store.AttachmentPage, error) {
	return d.list(ctx, project, task, query)
}
func (d transportAttachmentDAO) AttachmentPathConflict(ctx context.Context, project, task string, query store.AttachmentConflictQuery) (bool, error) {
	return d.conflict(ctx, project, task, query)
}
func (d transportAttachmentDAO) PutAttachment(ctx context.Context, item model.Attachment) (model.Attachment, bool, error) {
	return d.put(ctx, item)
}
