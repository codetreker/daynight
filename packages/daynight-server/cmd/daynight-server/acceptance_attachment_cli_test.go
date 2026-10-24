package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

type acceptanceAttachmentEvidence struct {
	Path      string `json:"path"`
	SizeBytes int    `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

func acceptanceAttachmentPath(task api.Task, name string) string {
	segments := strings.Split(name, "/")
	for index, segment := range segments {
		segments[index] = url.PathEscape(segment)
	}
	return acceptanceTaskPath(task) + "/attachments/files/" + strings.Join(segments, "/")
}

func (p *acceptanceProcess) attachmentRequest(method, target, contentType string, content []byte) acceptanceResponse {
	request, err := http.NewRequestWithContext(context.Background(), method, "http://"+p.address+target, bytes.NewReader(content))
	if err != nil {
		return acceptanceResponse{err: err}
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	transport := &http.Transport{DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	response, err := (&http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(request)
	if err != nil {
		return acceptanceResponse{err: err}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if len(body) > 4<<20 {
		err = errors.Join(err, errors.New("attachment response exceeded its acceptance capture bound"))
	}
	return acceptanceResponse{status: response.StatusCode, header: response.Header, body: body, err: err}
}

func acceptanceAttachmentRequests(process *acceptanceProcess, method, route string) []acceptanceCLIRequest {
	process.logs.mu.Lock()
	defer process.logs.mu.Unlock()
	var requests []acceptanceCLIRequest
	for _, event := range process.logs.events {
		if event["type"] == "http_request" && event["method"] == method && event["route"] == route {
			id, _ := event["request_id"].(string)
			status, _ := event["status"].(float64)
			requests = append(requests, acceptanceCLIRequest{RequestID: id, Status: int(status)})
		}
	}
	return requests
}

const acceptanceAttachmentFilesRoute = "/api/v1/projects/{projectId}/tasks/{taskId}/attachments/files/{path...}"
const acceptanceAttachmentListRoute = "/api/v1/projects/{projectId}/tasks/{taskId}/attachments"

func acceptanceAttachmentWaitRequests(t *testing.T, process *acceptanceProcess, method, route string, count int) []acceptanceCLIRequest {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := acceptanceEventually(ctx, func() (bool, error) {
		return len(acceptanceAttachmentRequests(process, method, route)) >= count, nil
	}); err != nil {
		t.Fatal("attachment CLI operation did not complete its server request logs")
	}
	return acceptanceAttachmentRequests(process, method, route)
}

func (c *acceptanceCLI) attachmentRefusal(t *testing.T, process *acceptanceProcess, method, code string, status int, arguments ...string) {
	t.Helper()
	route := method + " " + acceptanceAttachmentFilesRoute
	before := len(acceptanceAttachmentRequests(process, method, route))
	result := acceptanceCLIReceive(t, c.start(t, c.repo, arguments...))
	if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, code) {
		t.Fatalf("attachment CLI refusal lost its error code or exit behavior: status=%d, stdout bytes=%d, stderr=%s", result.status, len(result.stdout), result.stderr)
	}
	requests := acceptanceAttachmentWaitRequests(t, process, method, route, before+1)
	if len(requests) != before+1 || requests[before].Status != status || requests[before].RequestID == "" || !strings.Contains(result.stderr, "requestId="+requests[before].RequestID) {
		t.Fatal("attachment CLI refusal retried or lost the actual server response identity")
	}
	if err := binaryAcceptance.update(func() {
		c.scenario.CLIRefusalRequestIDs = append(c.scenario.CLIRefusalRequestIDs, requests[before].RequestID)
	}); err != nil {
		t.Fatal("cannot persist attachment CLI refusal identity")
	}
}

func acceptanceAttachmentList(t *testing.T, process *acceptanceProcess, task api.Task) []api.Attachment {
	t.Helper()
	page := acceptanceDecode[api.AttachmentPage](t, process.request(context.Background(), http.MethodGet, acceptanceTaskPath(task)+"/attachments?limit=100", nil, ""), http.StatusOK)
	if page.NextCursor != nil {
		t.Fatal("small attachment fixture unexpectedly required pagination")
	}
	return page.Items
}

func acceptanceAttachmentBytes(t *testing.T, cli *acceptanceCLI, task api.Task, name string, content []byte) {
	t.Helper()
	actual := cli.run(t, cli.repo, "task", "attachment", "read", task.ID, name)
	if !bytes.Equal([]byte(actual), content) {
		t.Fatalf("installed attachment read changed bytes for %q: got=%d, expected=%d", name, len(actual), len(content))
	}
}

func TestInstalledCLIAttachmentAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_task_attachment_workflow", []string{"FA1", "FA2", "FA3", "FA4", "FA5", "FA7", "FA8", "FA9", "FA10", "FA11", "FA12"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		cli := newAcceptanceCLI(t, receipt, scenario)
		process := fixture.launch(t, nil).started(t)
		cli.configure(t, process)
		project := acceptanceDecode[api.Project](t, process.request(context.Background(), http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Attachment CLI", RepoURL: "git@git.example:Org/Repo.git"}, ""), http.StatusCreated)
		task := process.task(t, project, "Attachment target")
		other := process.project(t, "Other attachment project")
		foreignTask := process.task(t, other, "Foreign attachment task")
		before := process.readTask(t, task)
		contents := map[string][]byte{
			"文档 space/设计 ?# %2F/design.md": []byte("# Architecture 中文\n\nExact trailing bytes\x00\n"),
			"empty.txt":                    {},
			"assets/data.bin":              append(bytes.Repeat([]byte{0, 255, 128, 13, 10, 27}, 175001), 0),
			"other/design.md":              []byte("Independent same-basename file\n"),
		}
		names := make([]string, 0, len(contents))
		for name := range contents {
			names = append(names, name)
		}
		slices.Sort(names)
		sources := make(map[string]string, len(contents))
		for index, name := range names {
			source := filepath.Join(cli.root, "source "+strconv.Itoa(index)+filepath.Ext(name))
			if name == "empty.txt" {
				source = filepath.Join(cli.root, name)
			}
			if err := os.WriteFile(source, contents[name], 0o600); err != nil {
				t.Fatal("cannot create owned attachment source")
			}
			sources[name] = source
			arguments := []string{"task", "attachment", "put", task.ID, source}
			if name != "empty.txt" {
				arguments = append(arguments, "--path", name)
			}
			if index == 0 {
				arguments = append(arguments, "--project", project.ID)
			}
			if output := cli.run(t, cli.repo, arguments...); !strings.HasPrefix(output, "Attachment uploaded.\n") || !strings.Contains(output, "Path: "+name+"\n") {
				t.Fatal("installed attachment upload omitted the expected resource")
			}
			acceptanceAttachmentBytes(t, cli, task, name, contents[name])
		}
		created := acceptanceAttachmentList(t, process, task)
		if len(created) != len(contents) {
			t.Fatal("attachment creation did not retain every independent path")
		}
		for _, item := range created {
			if item.SizeBytes != int64(len(contents[item.Path])) || item.ContentType == "" || item.CreatedAt.IsZero() || !item.CreatedAt.Equal(item.UpdatedAt) {
				t.Fatal("attachment creation returned inconsistent metadata")
			}
		}
		replacedPath := "文档 space/设计 ?# %2F/design.md"
		contents[replacedPath] = []byte("# Replaced design 中文\n")
		if err := os.WriteFile(sources[replacedPath], contents[replacedPath], 0o600); err != nil {
			t.Fatal("cannot replace owned attachment source")
		}
		cli.run(t, cli.repo, "task", "attachment", "put", task.ID, sources[replacedPath], "--path", replacedPath)
		acceptanceAttachmentBytes(t, cli, task, replacedPath, contents[replacedPath])
		replaced := acceptanceAttachmentList(t, process, task)
		for index, item := range replaced {
			if item.Path == replacedPath {
				if !item.CreatedAt.Equal(created[index].CreatedAt) || !item.UpdatedAt.After(created[index].UpdatedAt) || item.SizeBytes != int64(len(contents[item.Path])) {
					t.Fatal("same-path upload did not replace content and preserve creation time")
				}
			} else if !reflect.DeepEqual(item, created[index]) {
				t.Fatal("same-path upload changed an unrelated attachment")
			}
		}
		acceptanceAttachmentPagination(t, cli, process, task, scenario)
		acceptanceAttachmentFailures(t, cli, fixture, process, task, other, foreignTask, sources[replacedPath])
		if after := process.readTask(t, task); !reflect.DeepEqual(after, before) {
			t.Fatal("attachment operations changed the full task resource")
		}
		metadata := acceptanceCLIJSON[[]api.Attachment](t, cli.run(t, cli.repo, "task", "attachment", "list", task.ID, "--json"))
		for _, status := range []string{"in_progress", "todo", "done"} {
			cli.run(t, cli.repo, "task", "set-status", task.ID, status)
			after := cli.task(t, task.ID)
			acceptanceTaskTimingTransition(t, before, after, status)
			preserved := after
			preserved.StartedAt, preserved.CompletedAt = before.StartedAt, before.CompletedAt
			preserved.Status, preserved.Ready, preserved.Version, preserved.UpdatedAt = before.Status, before.Ready, before.Version, before.UpdatedAt
			if after.Status != status || after.Version != before.Version+1 || !after.UpdatedAt.After(before.UpdatedAt) || !reflect.DeepEqual(preserved, before) {
				t.Fatal("installed lifecycle action did not preserve the attachment task metadata")
			}
			if actual := acceptanceCLIJSON[[]api.Attachment](t, cli.run(t, cli.repo, "task", "attachment", "list", task.ID, "--json")); !reflect.DeepEqual(actual, metadata) {
				t.Fatal("installed lifecycle action changed attachment metadata")
			}
			before = after
		}

		process.signal(t)
		process.stopped(t, 0)
		restarted := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": process.address}).started(t)
		if restarted.address != process.address {
			t.Fatal("attachment restart did not reuse its released listener")
		}
		for _, name := range names {
			acceptanceAttachmentBytes(t, cli, task, name, contents[name])
		}
		if after := acceptanceCLIJSON[[]api.Attachment](t, cli.run(t, cli.repo, "task", "attachment", "list", task.ID, "--json")); !reflect.DeepEqual(after, metadata) {
			t.Fatal("attachment metadata changed across actual process restart")
		}
		if after := cli.task(t, task.ID); !reflect.DeepEqual(after, before) {
			t.Fatal("attachment task snapshot changed across actual process restart")
		}
		if err := binaryAcceptance.update(func() {
			for _, name := range names {
				scenario.AttachmentFiles = append(scenario.AttachmentFiles, acceptanceAttachmentEvidence{Path: name, SizeBytes: len(contents[name]), SHA256: fmt.Sprintf("%x", sha256.Sum256(contents[name]))})
			}
		}); err != nil {
			t.Fatal("cannot persist verified attachment content digests")
		}
		restarted.signal(t)
		restarted.stopped(t, 0)
	})
}

func acceptanceAttachmentPagination(t *testing.T, cli *acceptanceCLI, process *acceptanceProcess, task api.Task, scenario *acceptanceScenario) {
	t.Helper()
	expected := acceptanceAttachmentList(t, process, task)
	for index := range 101 {
		name := fmt.Sprintf("pagination/%03d.txt", index)
		item := acceptanceDecode[api.Attachment](t, process.attachmentRequest(http.MethodPut, acceptanceAttachmentPath(task, name), "text/plain", []byte(strconv.Itoa(index))), http.StatusCreated)
		expected = append(expected, item)
	}
	slices.SortFunc(expected, func(left, right api.Attachment) int { return strings.Compare(left.Path, right.Path) })
	route := "GET " + acceptanceAttachmentListRoute
	before := len(acceptanceAttachmentRequests(process, http.MethodGet, route))
	listed := acceptanceCLIJSON[[]api.Attachment](t, cli.run(t, cli.repo, "task", "attachment", "list", task.ID, "--json"))
	if !reflect.DeepEqual(listed, expected) || len(listed) <= 100 {
		t.Fatal("installed attachment list omitted, duplicated or changed paginated metadata")
	}
	requests := acceptanceAttachmentWaitRequests(t, process, http.MethodGet, route, before+2)
	if len(requests) != before+2 || requests[before].Status != http.StatusOK || requests[before+1].Status != http.StatusOK || requests[before].RequestID == "" || requests[before].RequestID == requests[before+1].RequestID {
		t.Fatal("installed attachment list did not traverse exactly two actual server pages")
	}
	tree := cli.run(t, cli.repo, "task", "attachment", "list", task.ID, "--tree")
	text := cli.run(t, cli.repo, "task", "attachment", "list", task.ID)
	for _, item := range expected {
		if !strings.Contains(tree, path.Base(item.Path)+"\n") || strings.Count(text, "Path: "+item.Path+"\n") != 1 {
			t.Fatal("installed attachment tree or text list omitted a paginated file")
		}
	}
	if !strings.Contains(tree, "文档 space/\n") || !strings.Contains(tree, "设计 ?# %2F/\n") || strings.Count(tree, "design.md\n") != 2 {
		t.Fatal("installed attachment tree lost hierarchy, special names or duplicate basenames")
	}
	if err := binaryAcceptance.update(func() {
		scenario.AttachmentsListed = len(listed)
		scenario.AttachmentPageRequests = len(requests) - before
	}); err != nil {
		t.Fatal("cannot persist attachment pagination evidence")
	}
}

func acceptanceAttachmentFailures(t *testing.T, cli *acceptanceCLI, fixture *acceptanceFixture, process *acceptanceProcess, task api.Task, other api.Project, foreignTask api.Task, source string) {
	t.Helper()
	cli.attachmentRefusal(t, process, http.MethodGet, "not_found", http.StatusNotFound,
		"task", "attachment", "read", task.ID, "assets/data.bin", "--project", other.ID)
	cli.attachmentRefusal(t, process, http.MethodGet, "not_found", http.StatusNotFound,
		"task", "attachment", "read", foreignTask.ID, "assets/data.bin", "--project", task.ProjectID)
	for _, name := range []string{"assets", "empty.txt/nested.txt"} {
		cli.attachmentRefusal(t, process, http.MethodPut, "path_conflict", http.StatusConflict,
			"task", "attachment", "put", task.ID, source, "--path", name)
	}
	putRoute := "PUT " + acceptanceAttachmentFilesRoute
	before := len(acceptanceAttachmentRequests(process, http.MethodPut, putRoute))
	invalid := acceptanceCLIReceive(t, cli.start(t, cli.repo, "task", "attachment", "put", task.ID, source, "--path", "../escape.txt"))
	if invalid.status != 2 || invalid.stdout != "" || invalid.stderr == "" || len(acceptanceAttachmentRequests(process, http.MethodPut, putRoute)) != before {
		t.Fatal("installed CLI invalid path did not fail before attachment transmission")
	}
	illegal := acceptanceTaskPath(task) + "/attachments/files/%2e%2e/escape.txt"
	acceptanceError(t, process.attachmentRequest(http.MethodPut, illegal, "text/plain", []byte("invalid")), http.StatusBadRequest, "invalid_input")
	if _, err := os.Stat(filepath.Join(fixture.storageRoot, "task-attachments", "escape.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid attachment path escaped its task directory")
	}
	removedPath := "remove/me.txt"
	acceptanceDecode[api.Attachment](t, process.attachmentRequest(http.MethodPut, acceptanceAttachmentPath(task, removedPath), "text/plain", []byte("remove this")), http.StatusCreated)
	if output := cli.run(t, cli.repo, "task", "attachment", "remove", task.ID, removedPath); output != "Attachment removed.\n" {
		t.Fatal("installed attachment deletion returned unexpected stdout")
	}
	for _, operation := range []string{"read", "remove"} {
		method := http.MethodGet
		if operation == "remove" {
			method = http.MethodDelete
		}
		cli.attachmentRefusal(t, process, method, "not_found", http.StatusNotFound,
			"task", "attachment", operation, task.ID, removedPath)
	}
	if _, err := os.Stat(filepath.Join(fixture.storageRoot, "task-attachments", task.ProjectID, task.ID[:2], task.ID, "remove", "me.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("successful attachment deletion left its content file")
	}
	stored := filepath.Join(fixture.storageRoot, "task-attachments", task.ProjectID, task.ID[:2], task.ID, "assets", "data.bin")
	backup := filepath.Join(cli.root, "storage-failure-backup.bin")
	if err := os.Rename(stored, backup); err != nil {
		t.Fatal("cannot create ordinary missing-content failure fixture")
	}
	t.Cleanup(func() {
		if _, err := os.Stat(backup); err == nil {
			if err := os.Rename(backup, stored); err != nil {
				t.Error("cannot restore owned missing-content fixture")
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Error("cannot inspect owned missing-content fixture")
		}
	})
	cli.attachmentRefusal(t, process, http.MethodGet, "internal_error", http.StatusInternalServerError,
		"task", "attachment", "read", task.ID, "assets/data.bin")
	if err := os.Rename(backup, stored); err != nil {
		t.Fatal("cannot restore owned content after ordinary storage failure")
	}
}
