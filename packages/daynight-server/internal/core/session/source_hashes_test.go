package session

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type sourceRetentionDAO struct {
	t        *testing.T
	ctx      context.Context
	expected store.SessionSourceHash
	count    int
	previous []byte
	point    string
	cause    error
	calls    []string
}

func (d *sourceRetentionDAO) SessionSourceHash(ctx context.Context, h store.SessionSourceHash) ([]byte, error) {
	d.t.Helper()
	if ctx != d.ctx || !reflect.DeepEqual(h, d.expected) {
		d.t.Fatal("source lookup identity changed", h)
	}
	d.calls = append(d.calls, "read")
	if d.point == "read" {
		return nil, d.cause
	}
	if d.previous != nil {
		return d.previous, nil
	}
	return nil, model.ErrNotFound
}
func (d *sourceRetentionDAO) PruneSessionSourceHashes(ctx context.Context, id, epoch string, cutoff int64) error {
	d.t.Helper()
	if ctx != d.ctx || id != d.expected.SessionID || epoch != d.expected.SourceEpoch || cutoff != d.expected.Through-2048 {
		d.t.Fatal("source prune policy changed", id, epoch, cutoff)
	}
	d.calls = append(d.calls, "prune")
	if d.point == "prune" {
		return d.cause
	}
	return nil
}
func (d *sourceRetentionDAO) SessionSourceHashCount(ctx context.Context, id string) (int, error) {
	d.t.Helper()
	if ctx != d.ctx || id != d.expected.SessionID {
		d.t.Fatal("source count identity changed", id)
	}
	d.calls = append(d.calls, "count")
	if d.point == "count" {
		return 0, d.cause
	}
	return d.count, nil
}
func (d *sourceRetentionDAO) SaveSessionSourceHash(ctx context.Context, h store.SessionSourceHash) error {
	d.t.Helper()
	if ctx != d.ctx || !reflect.DeepEqual(h, d.expected) {
		d.t.Fatal("source insert identity changed", h)
	}
	d.calls = append(d.calls, "insert")
	if d.point == "insert" {
		return d.cause
	}
	return nil
}
func TestSourceAcknowledgementRetentionDecidesWindowAndCapacityBeforeInsert(t *testing.T) {
	for _, through := range []int64{0, 1, 2048, 2049, 3000} {
		for _, count := range []int{8191, 8192, -1} {
			h := store.SessionSourceHash{SessionID: "session", SourceEpoch: "epoch", Kind: "event", Identity: "1", Through: through, Digest: bytes.Repeat([]byte{7}, 32)}
			d := &sourceRetentionDAO{t: t, ctx: t.Context(), expected: h, count: count}
			e := saveSourceHash(t.Context(), d, h)
			want := []string{"read", "prune", "count"}
			if count == 8191 {
				want = append(want, "insert")
				if e != nil {
					t.Fatal(e)
				}
			} else {
				code := "quota_exceeded"
				if count < 0 {
					code = "source_corrupt"
				}
				var f *model.Fault
				if !errors.As(e, &f) || f.Code != code {
					t.Fatal("invalid or full ledger lost its refusal", count, e)
				}
			}
			if !reflect.DeepEqual(d.calls, want) {
				t.Fatal(d.calls, want)
			}
		}
	}
}
func TestSourceAcknowledgementReplaysBeforePruningAndStopsOnUnknownWrite(t *testing.T) {
	for _, point := range []string{"same identity", "conflicting identity", "read", "prune", "count", "insert"} {
		t.Run(point, func(t *testing.T) {
			h := store.SessionSourceHash{SessionID: "session", SourceEpoch: "epoch", Kind: "event", Identity: "1", Through: 3000, Digest: bytes.Repeat([]byte{7}, 32)}
			cause := &store.TransactionError{Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("write completion unknown")}
			d := &sourceRetentionDAO{t: t, ctx: t.Context(), expected: h, count: 8192, point: point, cause: cause}
			if point == "same identity" {
				d.previous = append([]byte(nil), h.Digest...)
			}
			if point == "conflicting identity" {
				d.previous = bytes.Repeat([]byte{8}, 32)
			}
			if point == "insert" {
				d.count = 8191
			}
			e := saveSourceHash(t.Context(), d, h)
			want := []string{"read"}
			if point == "same identity" {
				if e != nil {
					t.Fatal("full ledger refused original replay", e)
				}
			} else if e == nil {
				t.Fatal("unsafe source acknowledgement succeeded")
			}
			if point == "prune" || point == "count" || point == "insert" {
				want = append(want, "prune")
			}
			if point == "count" || point == "insert" {
				want = append(want, "count")
			}
			if point == "insert" {
				want = append(want, "insert")
			}
			if point != "same identity" && point != "conflicting identity" && !errors.Is(e, cause) {
				t.Fatal("source failure cause lost", e)
			}
			if !reflect.DeepEqual(d.calls, want) {
				t.Fatal("replayed uncertain write or changed original ACK window", d.calls, want)
			}
		})
	}
}
func TestSourceAcknowledgementRejectsInvalidHashBeforeStorage(t *testing.T) {
	for _, kind := range []string{"kind", "empty identity", "long identity", "negative sequence", "digest"} {
		h := store.SessionSourceHash{SessionID: "session", SourceEpoch: "epoch", Kind: "event", Identity: "1", Through: 1, Digest: bytes.Repeat([]byte{7}, 32)}
		switch kind {
		case "kind":
			h.Kind = "unsupported"
		case "empty identity":
			h.Identity = ""
		case "long identity":
			h.Identity = string(bytes.Repeat([]byte{'a'}, 37))
		case "negative sequence":
			h.Through = -1
		case "digest":
			h.Digest = h.Digest[:31]
		}
		d := &sourceRetentionDAO{t: t, ctx: t.Context(), expected: h}
		if e := saveSourceHash(t.Context(), d, h); e == nil || len(d.calls) != 0 {
			t.Fatal("invalid source facts reached storage", kind, d.calls, e)
		}
	}
}
