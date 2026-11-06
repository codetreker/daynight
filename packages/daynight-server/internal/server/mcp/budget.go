package mcp

import (
	"context"
	"errors"
	"sync"
)

// BudgetClass describes the maximum resource materialized by an operation,
// independently of the view returned to the caller.
type BudgetClass uint8

const (
	BudgetControl BudgetClass = iota + 1
	BudgetLarge
	BudgetContent
)

var (
	ErrResourceBusy       = errors.New("mcp resource budget exhausted")
	ErrInvalidBudgetClass = errors.New("invalid mcp resource budget class")
)

// Budget reserves separate slots for bounded operations and operations that
// can materialize a large resource. A large slot reserves the 512 MiB working
// budget for one 128 MiB encoded response at the planned fourfold allowance.
// Content slots isolate potentially long file operations from control requests.
type Budget struct {
	control chan struct{}
	large   chan struct{}
	content chan struct{}
}

func NewBudget() *Budget {
	return &Budget{control: make(chan struct{}, 16), large: make(chan struct{}, 1), content: make(chan struct{}, 4)}
}

// Acquire is nonblocking. The returned release function must be called after
// the response has finished delivery, including on cancellation and failure.
// It is safe to call release more than once. Callers must acquire before
// invoking a business operation, using its worst-case materialization class.
func (b *Budget) Acquire(ctx context.Context, class BudgetClass) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var slots chan struct{}
	switch class {
	case BudgetControl:
		slots = b.control
	case BudgetLarge:
		slots = b.large
	case BudgetContent:
		slots = b.content
	default:
		return nil, ErrInvalidBudgetClass
	}
	select {
	case slots <- struct{}{}:
	default:
		return nil, ErrResourceBusy
	}
	var once sync.Once
	release := func() { once.Do(func() { <-slots }) }
	if err := ctx.Err(); err != nil {
		release()
		return nil, err
	}
	return release, nil
}
