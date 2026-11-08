package mcp

import (
	"context"
	"errors"
	"sync"
	"testing"
)

func TestBudgetLimitsAndRelease(t *testing.T) {
	b := NewBudget()
	ctx := context.Background()
	largeRelease, err := b.Acquire(ctx, BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Acquire(ctx, BudgetLarge); !errors.Is(err, ErrResourceBusy) {
		t.Fatalf("second large acquisition: %v", err)
	}

	releases := make([]func(), 0, 16)
	for i := 0; i < 16; i++ {
		release, err := b.Acquire(ctx, BudgetControl)
		if err != nil {
			t.Fatalf("control acquisition %d: %v", i, err)
		}
		releases = append(releases, release)
	}
	if _, err := b.Acquire(ctx, BudgetControl); !errors.Is(err, ErrResourceBusy) {
		t.Fatalf("17th control acquisition: %v", err)
	}
	largeRelease()
	largeRelease()
	again, err := b.Acquire(ctx, BudgetLarge)
	if err != nil {
		t.Fatalf("large slot not released: %v", err)
	}
	again()
	for _, release := range releases {
		release()
	}
	control, err := b.Acquire(ctx, BudgetControl)
	if err != nil {
		t.Fatalf("control slot not released: %v", err)
	}
	control()
}

func TestBudgetRejectsCanceledAndUnknownClass(t *testing.T) {
	b := NewBudget()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := b.Acquire(ctx, BudgetLarge); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled acquisition: %v", err)
	}
	if _, err := b.Acquire(context.Background(), 0); !errors.Is(err, ErrInvalidBudgetClass) {
		t.Fatalf("unknown class: %v", err)
	}
	release, err := b.Acquire(context.Background(), BudgetLarge)
	if err != nil {
		t.Fatalf("rejected acquisitions retained a slot: %v", err)
	}
	release()
}

func TestBudgetConcurrentLargeAdmission(t *testing.T) {
	b := NewBudget()
	const callers = 64
	start := make(chan struct{})
	done := make(chan struct{})
	results := make(chan error, callers)
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			release, err := b.Acquire(context.Background(), BudgetLarge)
			results <- err
			if err == nil {
				<-done
				release()
			}
		}()
	}
	close(start)
	accepted := 0
	for i := 0; i < callers; i++ {
		if err := <-results; err == nil {
			accepted++
		} else if !errors.Is(err, ErrResourceBusy) {
			t.Errorf("unexpected acquisition error: %v", err)
		}
	}
	close(done)
	wg.Wait()
	if accepted != 1 {
		t.Fatalf("accepted %d concurrent large operations, want 1", accepted)
	}
}
