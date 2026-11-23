package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type startupCredential struct {
	calls  int
	scopes []string
}

func (c *startupCredential) GetToken(_ context.Context, options policy.TokenRequestOptions) (azcore.AccessToken, error) {
	c.calls++
	c.scopes = options.Scopes
	return azcore.AccessToken{Token: "selected-token", ExpiresOn: time.Now().Add(time.Hour)}, nil
}

type startupTransport func(*http.Request) (*http.Response, error)

func (f startupTransport) Do(r *http.Request) (*http.Response, error) { return f(r) }

func TestAzureStartupUsesSelectedCredentialAndContainer(t *testing.T) {
	c := storageconfig.DefaultConfig()
	c.Backend = "azure-blob"
	c.Root = t.TempDir()
	c.Azure.Endpoint = "https://account.blob.core.windows.net"
	c.Azure.Container = "archives"
	credential := &startupCredential{}
	requests := 0
	transport := startupTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		if req.Method != http.MethodGet || req.URL.Path != "/archives" || req.URL.Query().Get("restype") != "container" || req.Header.Get("Authorization") != "Bearer selected-token" {
			t.Errorf("unexpected container check: %s %s auth=%q", req.Method, req.URL, req.Header.Get("Authorization"))
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"ETag": []string{"\"v1\""}}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
	})
	options := &container.ClientOptions{ClientOptions: azcore.ClientOptions{Transport: transport, Retry: policy.RetryOptions{MaxRetries: -1}}}
	files, err := openAzureFileStorage(t.Context(), c, credential, options)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	if requests != 1 || credential.calls != 1 || len(credential.scopes) != 1 || credential.scopes[0] != "https://storage.azure.com/.default" {
		t.Fatalf("credential calls=%d scopes=%v requests=%d", credential.calls, credential.scopes, requests)
	}
	if _, ok := files.(filestorage.TransferStorage); !ok {
		t.Fatal("Azure transfer capability unavailable")
	}
}

func TestAzureStartupConnectionStringAndScratch(t *testing.T) {
	const connection = "DefaultEndpointsProtocol=http;AccountName=fixture;AccountKey=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=;BlobEndpoint=http://127.0.0.1:10000/fixture;"
	c := storageconfig.DefaultConfig()
	c.Backend, c.Root = "azure-blob", t.TempDir()
	c.Azure.Container, c.Azure.ConnectionString = "archives", connection
	requests := 0
	options := &container.ClientOptions{ClientOptions: azcore.ClientOptions{Transport: startupTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		if req.Method != http.MethodGet || req.URL.Path != "/fixture/archives" || !strings.HasPrefix(req.Header.Get("Authorization"), "SharedKey fixture:") {
			t.Errorf("unexpected connection-string container request: %s %s", req.Method, req.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
	}), Retry: policy.RetryOptions{MaxRetries: -1}}}
	files, err := openAzureFileStorage(t.Context(), c, nil, options)
	if err != nil {
		t.Fatal(err)
	}
	if err := files.Close(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(c.Root)
	if err != nil || len(entries) != 0 || requests != 1 {
		t.Fatalf("scratch probe not cleaned or container not checked: entries=%v requests=%d error=%v", entries, requests, err)
	}

	occupied := filepath.Join(t.TempDir(), "occupied")
	if err := os.WriteFile(occupied, nil, 0600); err != nil {
		t.Fatal(err)
	}
	c.Root = occupied
	files, err = openAzureFileStorage(t.Context(), c, nil, options)
	if files != nil || err == nil || !strings.Contains(err.Error(), "scratch directory: failed") || requests != 2 {
		t.Fatalf("unusable scratch: files=%v error=%v requests=%d", files, err, requests)
	}
}

func TestAzureStartupRejectsInvalidClientConfiguration(t *testing.T) {
	c := storageconfig.DefaultConfig()
	c.Backend, c.Root, c.Azure.Container = "azure-blob", t.TempDir(), "archives"
	c.Azure.ConnectionString = "not-a-connection-string-secret"
	if files, err := openAzureFileStorage(t.Context(), c, nil, nil); files != nil || err == nil || !strings.Contains(err.Error(), "client construction: failed") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("invalid connection string: files=%v error=%v", files, err)
	}
	c.Azure.ConnectionString, c.Azure.Endpoint = "", "%invalid-private-endpoint"
	if files, err := openAzureFileStorage(t.Context(), c, &startupCredential{}, nil); files != nil || err == nil || !strings.Contains(err.Error(), "container check: failed") || strings.Contains(err.Error(), "private") {
		t.Fatalf("invalid endpoint: files=%v error=%v", files, err)
	}
	for _, key := range []string{"IDENTITY_ENDPOINT", "IDENTITY_HEADER", "IDENTITY_SERVER_THUMBPRINT", "IMDS_ENDPOINT", "MSI_ENDPOINT", "MSI_SECRET", "DEFAULT_IDENTITY_CLIENT_ID"} {
		t.Setenv(key, "")
	}
	t.Setenv("MSI_ENDPOINT", "http://127.0.0.1:1")
	c.Azure.Endpoint, c.Azure.ManagedIdentityClientID = "https://account.blob.core.windows.net", "selected-client"
	if files, err := openAzureFileStorage(t.Context(), c, nil, nil); files != nil || err == nil || !strings.Contains(err.Error(), "identity construction: failed") {
		t.Fatalf("unavailable managed identity selection: files=%v error=%v", files, err)
	}
}

func TestAzureStartupRedactsFailure(t *testing.T) {
	for _, tc := range []struct {
		status   int
		category string
	}{{403, "access denied"}, {404, "container not found"}} {
		t.Run(tc.category, func(t *testing.T) {
			c := storageconfig.DefaultConfig()
			c.Backend, c.Root = "azure-blob", t.TempDir()
			c.Azure.Endpoint, c.Azure.Container = "https://account.blob.core.windows.net", "archives"
			options := &container.ClientOptions{ClientOptions: azcore.ClientOptions{Transport: startupTransport(func(req *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tc.status, Header: http.Header{"X-Ms-Error-Code": []string{"SecretError"}}, Body: io.NopCloser(strings.NewReader("secret-response")), Request: req}, nil
			}), Retry: policy.RetryOptions{MaxRetries: -1}}}
			files, err := openAzureFileStorage(t.Context(), c, &startupCredential{}, options)
			if files != nil || err == nil || !strings.Contains(err.Error(), tc.category) || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "account") {
				t.Fatalf("unredacted or wrong result: files=%v error=%v", files, err)
			}
			var logs bytes.Buffer
			httpx.LogFailure(slog.New(slog.NewJSONHandler(&logs, nil)), t.Context(), "server", "startup", err)
			if !strings.Contains(logs.String(), "azure-blob container check: "+tc.category) || strings.Contains(logs.String(), "secret") || strings.Contains(logs.String(), "account") {
				t.Fatalf("startup log classification or redaction: %s", logs.String())
			}
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := azureStartupError("container check", ctx.Err()); !strings.Contains(err.Error(), "canceled") {
		t.Fatal(err)
	}
	err := azureStartupError("container check", context.DeadlineExceeded)
	var logs bytes.Buffer
	httpx.LogFailure(slog.New(slog.NewJSONHandler(&logs, nil)), t.Context(), "server", "startup", err)
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(logs.String(), "azure-blob container check: timed out") || !strings.Contains(logs.String(), `"cause":"deadline"`) {
		t.Fatalf("startup deadline classification: %v %s", err, logs.String())
	}
}

func TestAzureStartupDeadline(t *testing.T) {
	c := storageconfig.DefaultConfig()
	c.Backend, c.Root = "azure-blob", t.TempDir()
	c.Azure.Endpoint, c.Azure.Container = "https://account.blob.core.windows.net", "archives"
	started := make(chan struct{})
	options := &container.ClientOptions{ClientOptions: azcore.ClientOptions{Transport: startupTransport(func(req *http.Request) (*http.Response, error) {
		close(started)
		<-req.Context().Done()
		return nil, req.Context().Err()
	}), Retry: policy.RetryOptions{MaxRetries: -1}}}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { _, err := openAzureFileStorage(ctx, c, &startupCredential{}, options); done <- err }()
	<-started
	cancel()
	if err := <-done; err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("deadline result: %v", err)
	}
}

func TestAzureStartupWithAzurite(t *testing.T) {
	connection := os.Getenv("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING")
	if connection == "" {
		t.Skip("requires an isolated Azurite instance")
	}
	name := "startup-" + strings.ToLower(rand.Text())
	client, err := container.NewClientFromConnectionString(connection, name, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Create(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := client.Delete(context.Background(), nil); err != nil {
			t.Errorf("delete container: %v", err)
		}
	})
	c := storageconfig.DefaultConfig()
	c.Backend, c.Root = "azure-blob", t.TempDir()
	c.Azure.Container, c.Azure.ConnectionString = name, connection
	files, err := openAzureFileStorage(t.Context(), c, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = files.Put(t.Context(), "session-archives", "test/object", strings.NewReader("startup-object")); err != nil {
		t.Fatal(err)
	}
	o, err := files.Open(t.Context(), "session-archives", "test/object")
	if err != nil {
		t.Fatal(err)
	}
	contents, err := io.ReadAll(o.Body)
	if closeErr := o.Body.Close(); err != nil || closeErr != nil || string(contents) != "startup-object" {
		t.Fatalf("read: %q, %v, %v", contents, err, closeErr)
	}
	if err := files.Close(); err != nil {
		t.Fatal(err)
	}
	c.Azure.Container = name + "-missing"
	if files, err := openAzureFileStorage(t.Context(), c, nil, nil); files != nil || err == nil || !strings.Contains(err.Error(), "container not found") {
		t.Fatalf("missing: files=%v error=%v", files, err)
	}
	c.Azure.Container = name
	parts := strings.Split(connection, ";")
	for i, part := range parts {
		if strings.HasPrefix(strings.ToLower(part), "accountkey=") {
			parts[i] = "AccountKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
		}
	}
	c.Azure.ConnectionString = strings.Join(parts, ";")
	if files, err := openAzureFileStorage(t.Context(), c, nil, nil); files != nil || err == nil || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("unauthorized: files=%v error=%v", files, err)
	}
}

func TestConfiguredFileStorageSharesRedisGate(t *testing.T) {
	redisURL := os.Getenv("DAYNIGHT_TEST_REDIS_URL")
	if redisURL == "" {
		t.Skip("requires an isolated Redis test instance")
	}
	root := t.TempDir()
	first, err := openFileStorage(root, redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := first.Close(); err != nil {
			t.Error(err)
		}
	})
	second, err := openFileStorage(t.TempDir(), redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := second.Close(); err != nil {
			t.Error(err)
		}
	})
	if _, ok := first.(filestorage.TransferAttachmentPublisher); !ok {
		t.Fatal("Redis storage lost transfer publication capability")
	}
	key := rand.Text()
	permit, err := first.TryAcquireResidency(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := permit.Close(); err != nil {
			t.Error(err)
		}
	})
	if contested, err := second.TryAcquireResidency(t.Context(), key); !errors.Is(err, filestorage.ErrGateBusy) {
		if contested != nil {
			_ = contested.Close()
		}
		t.Fatalf("second storage residency error = %v, want gate busy", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".daynight-gates")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("check legacy gate directory: %v", err)
	}
}

func TestConfiguredFileStorageRejectsInvalidDependencies(t *testing.T) {
	root := t.TempDir()
	if files, err := openFileStorage(root, "invalid Redis URL"); files != nil || err == nil {
		t.Fatalf("invalid Redis URL returned files=%v, error=%v", files, err)
	}
	occupied := filepath.Join(root, "occupied")
	if err := os.WriteFile(occupied, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if files, err := openFileStorage(occupied, "redis://127.0.0.1:1"); files != nil || err == nil {
		t.Fatalf("invalid root returned files=%v, error=%v", files, err)
	}
}
