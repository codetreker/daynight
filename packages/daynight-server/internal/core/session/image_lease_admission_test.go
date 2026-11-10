package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type imageLeaseAdmissionDAO struct {
	store.SessionResourceDAO
	wantContext context.Context
	received    store.SessionResourceLease
	calls       int
	err         error
}

func (d *imageLeaseAdmissionDAO) AcquireSessionResourceLease(ctx context.Context, lease store.SessionResourceLease) error {
	if ctx != d.wantContext {
		panic("lease admission lost the authorized context")
	}
	d.calls++
	d.received = lease
	return d.err
}

func TestImageLeaseAdmissionSuppliesCoreOccupancyBoundsWithoutReplaying(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	failure := errors.New("transaction completion unknown")
	dao := &imageLeaseAdmissionDAO{wantContext: ctx, err: failure}
	lease := store.SessionResourceLease{SessionID: "session", ID: "lease", Kind: "write", OwnerID: "owner", ResourceID: "resource", DeleteEpoch: 7}
	if err := acquireImageResourceLease(ctx, dao, lease); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	lease.Admission = store.SessionResourceLeaseAdmission{Global: 64, Owner: 8, Session: 2}
	if dao.calls != 1 || !reflect.DeepEqual(dao.received, lease) {
		t.Fatalf("admission changed identity or omitted occupancy bounds: %+v", dao.received)
	}
}
