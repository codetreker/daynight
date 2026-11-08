package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRuntimeAttachmentPathAndCursorBoundary(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := decodeResponse[api.Project](t, projectRequest(handler, "POST", "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Boundary", RepoURL: "https://example.com/boundary", ExpectedUserID: handler.principal.UserID})), http.StatusCreated)
	task := decodeResponse[api.Task](t, projectRequest(handler, "POST", "/api/v1/projects/"+project.ID+"/tasks", `{"title":"Boundary"}`), http.StatusCreated)
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
