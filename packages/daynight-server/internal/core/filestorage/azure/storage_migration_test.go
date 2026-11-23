package azure

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func TestMigrationPublicationDoesNotOverwrite(t *testing.T) {
	var saved string
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPut || r.Header.Get("If-None-Match") != "*" {
			t.Error("migration did not make a conditional create")
		}
		if saved != "" {
			w.Header().Set("x-ms-error-code", "ConditionNotMet")
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		saved = string(data)
		w.Header().Set("ETag", `"1"`)
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(server.Close)
	client, err := container.NewClientWithNoCredential(server.URL+"/container", &container.ClientOptions{ClientOptions: azcore.ClientOptions{Retry: policy.RetryOptions{MaxRetries: -1}}})
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(client, testGates{}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.PutIfAbsent(t.Context(), "session-resources", "object", strings.NewReader("original")); err != nil {
		t.Fatal(err)
	}
	_, err = s.PutIfAbsent(t.Context(), "session-resources", "object", strings.NewReader("replacement"))
	if !errors.Is(err, ErrTargetExists) || filestorage.PublicationOutcome(err) != filestorage.NotPublished || saved != "original" || requests != 2 {
		t.Fatalf("saved=%q requests=%d err=%v", saved, requests, err)
	}
}
