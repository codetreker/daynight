package filestorage

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
)

type controlledGate struct {
	io.Closer
	bind   func(context.Context) (context.Context, context.CancelFunc)
	check  func() error
	verify func(context.Context) error
}

func (g controlledGate) GateContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return g.bind(ctx)
}

func (g controlledGate) CheckGate() error { return g.check() }

func (g controlledGate) VerifyGate(ctx context.Context) error { return g.verify(ctx) }

func TestGateCleanupRetainsEveryPermitAfterRequestCancellation(t *testing.T) {
	request, stopRequest := context.WithCancel(t.Context())
	defer stopRequest()
	var checked []string
	var lost error
	outer := controlledGate{
		bind:  context.WithCancel,
		check: func() error { return lost },
		verify: func(context.Context) error {
			checked = append(checked, "outer")
			return nil
		},
	}
	inner := controlledGate{
		bind:  context.WithCancel,
		check: func() error { return nil },
		verify: func(context.Context) error {
			checked = append(checked, "inner")
			return nil
		},
	}
	ctx, cancelOuter := GateContext(request, outer)
	defer cancelOuter()
	wrapped := controlledGate{bind: func(ctx context.Context) (context.Context, context.CancelFunc) {
		return GateContext(ctx, inner)
	}}
	ctx, cancelInner := GateContext(ctx, wrapped)
	defer cancelInner()
	stopRequest()
	if err := VerifyGates(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("verification on canceled request: %v", err)
	}
	cleanup, finish := GateCleanupContext(ctx)
	defer finish()
	if err := VerifyGates(cleanup); err != nil {
		t.Fatal(err)
	}
	if want := []string{"inner", "outer"}; !reflect.DeepEqual(checked, want) {
		t.Fatalf("checked %v, want %v", checked, want)
	}
	lost = ErrGateLost
	if err := VerifyGates(cleanup); !errors.Is(err, ErrGateLost) {
		t.Fatalf("cleanup ignored expired outer lease: %v", err)
	}
	if len(checked) != 2 {
		t.Fatalf("online verification started after local expiry: %v", checked)
	}
}
