package admission

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type rateCall struct {
	ctx    context.Context
	now    time.Time
	bucket *model.DeviceRateBucket
}

type rateStore struct {
	pruneErr     error
	attempts     []int
	incrementErr error
	failAt       int
	calls        []rateCall
	increments   int
}

func (s *rateStore) PruneDeviceRates(ctx context.Context, now time.Time) error {
	s.calls = append(s.calls, rateCall{ctx: ctx, now: now})
	return s.pruneErr
}

func (s *rateStore) IncrementDeviceRate(ctx context.Context, bucket model.DeviceRateBucket, now time.Time) (int, error) {
	s.calls = append(s.calls, rateCall{ctx: ctx, now: now, bucket: &bucket})
	index := s.increments
	s.increments++
	if s.incrementErr != nil && index == s.failAt {
		return 0, s.incrementErr
	}
	return s.attempts[index], nil
}

func TestTakeVisitsBucketsInOrderAndAcceptsExactLimits(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	now := time.Date(2026, 8, 1, 12, 0, 0, 123, time.UTC)
	buckets := []model.DeviceRateBucket{
		{Hash: []byte("client"), Limit: 5},
		{Hash: []byte("address"), Limit: 10},
	}
	dao := &rateStore{attempts: []int{5, 9}}
	allowed, err := Take(ctx, dao, buckets, now)
	if err != nil || !allowed {
		t.Fatalf("Take() = %v, %v; want allowed", allowed, err)
	}
	want := []rateCall{
		{ctx: ctx, now: now},
		{ctx: ctx, now: now, bucket: &buckets[0]},
		{ctx: ctx, now: now, bucket: &buckets[1]},
	}
	if !reflect.DeepEqual(dao.calls, want) {
		t.Fatalf("DAO calls = %#v; want %#v", dao.calls, want)
	}
}

func TestTakePrunesWhenNoBucketsAreRequired(t *testing.T) {
	now := time.Now()
	dao := &rateStore{}
	allowed, err := Take(t.Context(), dao, nil, now)
	if err != nil || !allowed {
		t.Fatalf("Take() = %v, %v; want allowed", allowed, err)
	}
	if len(dao.calls) != 1 || dao.calls[0].bucket != nil || !dao.calls[0].now.Equal(now) {
		t.Fatalf("expected pruning only, got %#v", dao.calls)
	}
}

func TestTakeStopsAfterFirstExhaustedBucket(t *testing.T) {
	buckets := []model.DeviceRateBucket{
		{Hash: []byte("client"), Limit: 5},
		{Hash: []byte("address"), Limit: 10},
		{Hash: []byte("global"), Limit: 100},
	}
	for _, exhausted := range []int{0, 1} {
		t.Run(string(buckets[exhausted].Hash), func(t *testing.T) {
			attempts := []int{1, 1, 1}
			attempts[exhausted] = buckets[exhausted].Limit + 1
			dao := &rateStore{attempts: attempts}
			allowed, err := Take(t.Context(), dao, buckets, time.Now())
			if err != nil || allowed {
				t.Fatalf("Take() = %v, %v; want denied without error", allowed, err)
			}
			if dao.increments != exhausted+1 || len(dao.calls) != exhausted+2 {
				t.Fatalf("increments = %d, calls = %d; later buckets must remain untouched", dao.increments, len(dao.calls))
			}
			for index := 0; index <= exhausted; index++ {
				if !reflect.DeepEqual(*dao.calls[index+1].bucket, buckets[index]) {
					t.Fatalf("increment %d = %#v; want %#v", index, dao.calls[index+1].bucket, buckets[index])
				}
			}
		})
	}
}

func TestTakePropagatesPruneFailureWithoutIncrementing(t *testing.T) {
	failure := errors.New("prune failed")
	dao := &rateStore{pruneErr: failure}
	allowed, err := Take(t.Context(), dao, []model.DeviceRateBucket{{Limit: 5}}, time.Now())
	if allowed || err != failure {
		t.Fatalf("Take() = %v, %v; want false and original pruning error", allowed, err)
	}
	if len(dao.calls) != 1 || dao.increments != 0 {
		t.Fatalf("expected pruning only, got %#v", dao.calls)
	}
}

func TestTakePropagatesIncrementFailureAndStops(t *testing.T) {
	failure := errors.New("increment failed")
	buckets := []model.DeviceRateBucket{
		{Hash: []byte("client"), Limit: 5},
		{Hash: []byte("address"), Limit: 10},
		{Hash: []byte("global"), Limit: 100},
	}
	for _, failAt := range []int{0, 1} {
		t.Run(string(buckets[failAt].Hash), func(t *testing.T) {
			dao := &rateStore{attempts: []int{1, 1, 1}, incrementErr: failure, failAt: failAt}
			allowed, err := Take(t.Context(), dao, buckets, time.Now())
			if allowed || err != failure {
				t.Fatalf("Take() = %v, %v; want false and original increment error", allowed, err)
			}
			if dao.increments != failAt+1 || len(dao.calls) != failAt+2 {
				t.Fatalf("increments = %d, calls = %d; later buckets must remain untouched", dao.increments, len(dao.calls))
			}
		})
	}
}
