package remote

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const validPullRequest = `{"number":4,"id":51,"html_url":"https://github.com/o/r/pull/4","title":"标题","user":{"id":7,"login":"person"},"state":"open","draft":false,"base":{"ref":"main","repo":{"id":3}},"head":{"ref":"feature","sha":"abc","repo":{"id":8,"full_name":"fork/r"}},"created_at":"2026-01-02T03:04:05Z","updated_at":"2026-01-02T03:04:05Z","closed_at":null,"merged_at":null,"body":"正文 😀"}`

func TestDecodeIdentities(t *testing.T) {
	repo, err := decodeRepository([]byte(`{"id":1,"full_name":"owner/repo","private":false,"extra":"ignored"}`))
	if err != nil || repo.ID != 1 || repo.FullName != "owner/repo" || repo.Private {
		t.Fatalf("repository: %+v %v", repo, err)
	}
	installation, err := decodeInstallation([]byte(`{"id":20,"account":{"login":"owner"}}`))
	if err != nil || installation.ID != 20 || installation.AccountLogin != "owner" {
		t.Fatalf("installation: %+v %v", installation, err)
	}
	for _, data := range []string{`null`, `{}`, `{"id":0,"full_name":"owner/repo","private":false}`, `{"id":1,"full_name":"owner/repo"}`, `{"id":1,"full_name":"","private":true}`, `{"id":1,"full_name":"\ud800","private":true}`} {
		if _, err := decodeRepository([]byte(data)); err == nil {
			t.Errorf("accepted repository %s", data)
		}
	}
	for _, data := range []string{`null`, `{}`, `{"id":-1,"account":{"login":"owner"}}`, `{"id":1,"account":null}`, `{"id":1,"account":{"login":""}}`} {
		if _, err := decodeInstallation([]byte(data)); err == nil {
			t.Errorf("accepted installation %s", data)
		}
	}
}

func TestDecodePullRequestPreservesFacts(t *testing.T) {
	got, err := decodePullRequest([]byte(validPullRequest))
	if err != nil {
		t.Fatal(err)
	}
	if got.Number != 4 || got.GitHubID != 51 || got.Title != "标题" || got.BaseRepositoryID != 3 || got.BaseRef != "main" || got.HeadSHA != "abc" || got.Draft || got.State != "open" || got.AuthorID == nil || *got.AuthorID != 7 || got.AuthorLogin == nil || *got.AuthorLogin != "person" || got.HeadRepositoryID == nil || *got.HeadRepositoryID != 8 || got.HeadRepositoryFullName == nil || *got.HeadRepositoryFullName != "fork/r" || got.HeadRef == nil || *got.HeadRef != "feature" || got.Description == nil || *got.Description != "正文 😀" || got.ClosedAt != nil || got.MergedAt != nil || got.CreatedAt.Location() != time.UTC {
		t.Fatalf("unexpected observation: %+v", got)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(validPullRequest), &payload); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("文本😀\n", 50000)
	payload["body"] = long
	payload["user"] = nil
	payload["head"] = map[string]any{"ref": nil, "sha": "changed", "repo": nil}
	payload["closed_at"] = "2026-01-02T11:04:05+08:00"
	payload["merged_at"] = "2026-01-02T11:04:05+08:00"
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	got, err = decodePullRequest(data)
	if err != nil || got.Description == nil || *got.Description != long || got.HeadSHA != "changed" || got.AuthorID != nil || got.AuthorLogin != nil || got.HeadRef != nil || got.HeadRepositoryID != nil || got.HeadRepositoryFullName != nil || got.ClosedAt == nil || got.MergedAt == nil || got.ClosedAt.Location() != time.UTC || !got.ClosedAt.Equal(got.CreatedAt) {
		t.Fatalf("nullable/long fields: %+v %v", got, err)
	}
	for _, body := range []any{nil, ""} {
		payload["body"] = body
		data, _ = json.Marshal(payload)
		got, err = decodePullRequest(data)
		if err != nil || (body == nil && got.Description != nil) || (body != nil && (got.Description == nil || *got.Description != "")) {
			t.Fatalf("body %v: %+v %v", body, got, err)
		}
	}
}

func TestDecodePullRequestRejectsMissingAndInvalidFacts(t *testing.T) {
	for _, field := range []string{"number", "id", "html_url", "title", "state", "draft", "base", "head", "created_at", "updated_at", "body"} {
		t.Run(field, func(t *testing.T) {
			var payload map[string]any
			if err := json.Unmarshal([]byte(validPullRequest), &payload); err != nil {
				t.Fatal(err)
			}
			delete(payload, field)
			data, _ := json.Marshal(payload)
			if _, err := decodePullRequest(data); err == nil {
				t.Fatal("missing field accepted")
			}
		})
	}
	for _, replace := range [][2]string{
		{`"number":4`, `"number":0`}, {`"id":51`, `"id":0`}, {`"html_url":"https://github.com/o/r/pull/4"`, `"html_url":""`},
		{`"state":"open"`, `"state":""`}, {`"draft":false`, `"draft":null`}, {`"ref":"main"`, `"ref":""`},
		{`"repo":{"id":3}`, `"repo":{"id":0}`}, {`"sha":"abc"`, `"sha":""`},
		{`"created_at":"2026-01-02T03:04:05Z"`, `"created_at":"invalid"`}, {`"body":"正文 😀"`, `"body":42`},
		{`"user":{"id":7,"login":"person"}`, `"user":{"id":0,"login":"person"}`},
		{`"repo":{"id":8,"full_name":"fork/r"}`, `"repo":{"id":8}`},
	} {
		data := strings.Replace(validPullRequest, replace[0], replace[1], 1)
		if data == validPullRequest {
			t.Fatalf("replacement not found: %s", replace[0])
		}
		if _, err := decodePullRequest([]byte(data)); err == nil {
			t.Errorf("accepted %s", replace[1])
		}
	}
	for _, data := range []string{`null`, `{"secret":"private`, strings.Replace(validPullRequest, `正文 😀`, `\ud800`, 1)} {
		if _, err := decodePullRequest([]byte(data)); err == nil || strings.Contains(err.Error(), "private") {
			t.Errorf("malformed response: %v", err)
		}
	}
}
