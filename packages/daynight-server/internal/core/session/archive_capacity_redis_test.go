package session

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	redisgates "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/redis"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

func redisArchiveExecution(t *testing.T, limits ArchiveLimits) *Execution {
	t.Helper()
	url := os.Getenv("DAYNIGHT_TEST_REDIS_URL")
	if url == "" {
		t.Skip("DAYNIGHT_TEST_REDIS_URL is required for shared archive admission")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	client := redis.NewClient(opts)
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Error(err)
		}
	})
	files, err := local.NewWithGates(t.TempDir(), redisgates.New(client))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	s := &Execution{Engine: NewEngine(files, limits)}
	s.SetArchivePreflight(func(_ context.Context, p model.Principal, _, _, _ string, _ ArchiveMode) (string, error) {
		return p.UserID, nil
	})
	return s
}

func TestArchiveCapacitySharedRedisAndRollingUpgrade(t *testing.T) {
	old := redisArchiveExecution(t, ArchiveLimits{MaxConcurrent: 1, MaxConcurrentPerOwner: 1})
	a := redisArchiveExecution(t, ArchiveLimits{MaxConcurrent: 20, MaxConcurrentPerOwner: 5})
	b := redisArchiveExecution(t, ArchiveLimits{MaxConcurrent: 20, MaxConcurrentPerOwner: 5})
	owner := model.Principal{UserID: uuid.NewString()}
	begin := func(s *Execution) (*ArchiveOperation, error) {
		return s.BeginArchive(t.Context(), owner, "", "", uuid.NewString(), ArchiveV1Read)
	}
	assertStage := func(err error, stage string) {
		t.Helper()
		var capacity *ArchiveCapacityError
		var fault *model.Fault
		if !errors.As(err, &capacity) || capacity.Stage != stage || !errors.As(err, &fault) || fault.Code != "resource_busy" {
			t.Fatalf("expected %s resource_busy, got %v", stage, err)
		}
	}
	closeOp := func(op *ArchiveOperation) {
		t.Helper()
		if err := op.Close(); err != nil {
			t.Fatal(err)
		}
	}
	first, err := begin(old)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })
	_, err = begin(old)
	assertStage(err, "instance_full")
	var upgraded []*ArchiveOperation
	for i := 0; i < 4; i++ {
		op, err := begin(a)
		if err != nil {
			t.Fatal(err)
		}
		upgraded = append(upgraded, op)
		t.Cleanup(func() { _ = op.Close() })
	}
	_, err = begin(b)
	assertStage(err, "owner_busy")
	closeOp(first)
	_, err = begin(old)
	assertStage(err, "owner_busy")
	last, err := begin(b)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = last.Close() })
	_, err = begin(a)
	assertStage(err, "owner_busy")
	for _, op := range upgraded {
		closeOp(op)
	}
	closeOp(last)

	// Each contender holds its permit until every response is observed.
	type result struct {
		op  *ArchiveOperation
		err error
	}
	start := make(chan struct{})
	results := make(chan result, 6)
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			s := a
			if i%2 == 1 {
				s = b
			}
			op, err := begin(s)
			results <- result{op, err}
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	var held []*ArchiveOperation
	rejected := 0
	for r := range results {
		if r.err != nil {
			assertStage(r.err, "owner_busy")
			rejected++
		} else {
			held = append(held, r.op)
			t.Cleanup(func() { _ = r.op.Close() })
		}
	}
	if len(held) != 5 || rejected != 1 {
		t.Fatalf("got %d grants and %d refusals", len(held), rejected)
	}
	for _, op := range held {
		closeOp(op)
	}
	for _, s := range []*Execution{a, b} {
		op, err := begin(s)
		if err != nil {
			t.Fatal(err)
		}
		closeOp(op)
	}
}
