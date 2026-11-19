package filestorage

import (
	"context"
	"io"
)

type gateLease interface {
	GateContext(context.Context) (context.Context, context.CancelFunc)
}

type gateChainKey struct{}

type gateChain struct {
	lease gateLease
	outer *gateChain
}

// GateContext binds protected work to lease loss. Local permits do not expire.
func GateContext(ctx context.Context, permit io.Closer) (context.Context, context.CancelFunc) {
	lease, ok := permit.(gateLease)
	if !ok {
		return ctx, func() {}
	}
	outer, _ := ctx.Value(gateChainKey{}).(*gateChain)
	ctx, cancel := lease.GateContext(ctx)
	if bound, _ := ctx.Value(gateChainKey{}).(*gateChain); bound != outer {
		return ctx, cancel
	}
	return context.WithValue(ctx, gateChainKey{}, &gateChain{lease: lease, outer: outer}), cancel
}

// GateError observes the local deadline of every active lease through derived
// contexts whose asynchronous cancellation may still be propagating.
func GateError(ctx context.Context) error {
	leases, _ := ctx.Value(gateChainKey{}).(*gateChain)
	for chain := leases; chain != nil; chain = chain.outer {
		if lease, ok := chain.lease.(interface{ CheckGate() error }); ok {
			if err := lease.CheckGate(); err != nil {
				return err
			}
		}
	}
	return context.Cause(ctx)
}

// VerifyGates checks authoritative ownership immediately before changing an
// existing file or publishing a replacement. A backend can lose a key before
// the old owner's local deadline, for example after a Redis failover.
func VerifyGates(ctx context.Context) error {
	leases, _ := ctx.Value(gateChainKey{}).(*gateChain)
	if leases == nil {
		return nil
	}
	if err := GateError(ctx); err != nil {
		return err
	}
	for chain := leases; chain != nil; chain = chain.outer {
		if lease, ok := chain.lease.(interface{ VerifyGate(context.Context) error }); ok {
			if err := lease.VerifyGate(ctx); err != nil {
				return err
			}
		}
	}
	return GateError(ctx)
}

// GateCleanupContext detaches cleanup from request cancellation while continuing
// to observe every lease that protects the original operation.
func GateCleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	leases, _ := ctx.Value(gateChainKey{}).(*gateChain)
	ctx = context.WithoutCancel(ctx)
	var cancels []context.CancelFunc
	for chain := leases; chain != nil; chain = chain.outer {
		var cancel context.CancelFunc
		ctx, cancel = chain.lease.GateContext(ctx)
		cancels = append(cancels, cancel)
	}
	return ctx, func() {
		for i := len(cancels) - 1; i >= 0; i-- {
			cancels[i]()
		}
	}
}
