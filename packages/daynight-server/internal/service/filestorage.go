package service

import (
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	redisgates "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/redis"
	redisstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/redis"
	"github.com/redis/go-redis/v9"
)

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
