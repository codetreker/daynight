package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/azure"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	redisgates "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/redis"
	redisstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/redis"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/azureidentity"
	"github.com/redis/go-redis/v9"
)

type azureFileStorage struct{ *azure.Storage }

func (*azureFileStorage) Close() error { return nil }

// azureStartupError reports categories without exposing SDK request URLs,
// connection strings, authorization material, or response bodies.
func azureStartupError(stage string, err error) error {
	category := "failed"
	var response *azcore.ResponseError
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		category = "timed out or canceled"
	case errors.As(err, &response) && response.StatusCode == 404:
		category = "container not found"
	case errors.As(err, &response) && (response.StatusCode == 401 || response.StatusCode == 403):
		category = "access denied"
	}
	return fmt.Errorf("azure-blob %s: %s", stage, category)
}

// openAzureFileStorage checks the selected container with the actual client
// before making the backend available to application modules.
func openAzureFileStorage(ctx context.Context, c storageconfig.Config, credential azcore.TokenCredential, options *container.ClientOptions) (appStorage, error) {
	var client *container.Client
	var err error
	if c.Azure.ConnectionString != "" {
		client, err = container.NewClientFromConnectionString(c.Azure.ConnectionString, c.Azure.Container, options)
	} else {
		if credential == nil {
			credential, err = azureidentity.NewManagedIdentityCredential(c.Azure.ManagedIdentityClientID)
			if err != nil {
				return nil, azureStartupError("identity construction", err)
			}
		}
		client, err = container.NewClient(strings.TrimRight(c.Azure.Endpoint, "/")+"/"+c.Azure.Container, credential, options)
	}
	if err != nil {
		return nil, azureStartupError("client construction", err)
	}
	if _, err = client.GetProperties(ctx, nil); err != nil {
		return nil, azureStartupError("container check", err)
	}
	if err = os.MkdirAll(c.Root, 0o700); err != nil {
		return nil, azureStartupError("scratch directory", err)
	}
	probe, err := os.CreateTemp(c.Root, "daynight-scratch-check-*")
	if err != nil {
		return nil, azureStartupError("scratch directory", err)
	}
	name := probe.Name()
	if err = errors.Join(probe.Close(), os.Remove(name)); err != nil {
		return nil, azureStartupError("scratch directory", err)
	}
	gates, err := local.NewStandaloneGates("azure-blob")
	if err != nil {
		return nil, azureStartupError("gate setup", err)
	}
	storage, err := azure.New(client, gates, c.Root)
	if err != nil {
		return nil, azureStartupError("storage setup", err)
	}
	return &azureFileStorage{Storage: storage}, nil
}

type redisFileStorage struct {
	*local.Storage
	client *redis.Client
}

func (s *redisFileStorage) Close() error {
	return errors.Join(s.Storage.Close(), s.client.Close())
}

func openFileStorage(root, redisURL string) (appStorage, error) {
	if redisURL == "" {
		return local.New(root)
	}
	client, err := redisstore.NewClient(redisURL)
	if err != nil {
		return nil, err
	}
	files, err := local.NewWithGates(root, redisgates.New(client))
	if err != nil {
		return nil, errors.Join(err, client.Close())
	}
	return &redisFileStorage{Storage: files, client: client}, nil
}
