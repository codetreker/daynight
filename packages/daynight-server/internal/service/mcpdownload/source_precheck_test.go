package mcpdownload

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

func TestConcurrentOpenAppearingDuringFailedPrecheck(t *testing.T) {
	for _, same := range []bool{true, false} {
		t.Run(fmt.Sprintf("same_binding=%v", same), func(t *testing.T) {
			f := newAdmissionFixture(t)
			in := f.openInput()
			record := f.record(in, "preparing")
			record.Version = 1
			if !same {
				record.Path = "other"
			}
			steps := []admissionStep{
				missingAdmissionRecord(in.TransferID),
				{name: "source", source: in, cause: &model.Fault{Code: "resource_conflict", Message: "Source changed while opening."}},
				committedAdmissionScope(f.authorize(in)),
				committedAdmissionScope(admissionGet(record), f.authorize(in)),
			}
			if same {
				touch, saved := f.touch(in, record)
				f.expect(append(steps, committedAdmissionScope(admissionGet(record), f.authorize(in)), touch)...)
				result, err := f.service.Read(f.ctx, f.actor, in)
				if err != nil || result["state"] != "preparing" || result["transferId"] != in.TransferID || result["expiresAt"] != saved.ExpiresAt {
					t.Fatalf("existing result: %#v %v", result, err)
				}
			} else {
				f.expect(append(steps, failedAdmissionScope(mcptransfer.ErrConflict, admissionGet(record)))...)
				result, err := f.service.Read(f.ctx, f.actor, in)
				if result != nil || !errors.Is(err, mcptransfer.ErrConflict) {
					t.Fatalf("binding conflict: %#v %v", result, err)
				}
			}
		})
	}
}

func TestPathReadLimitCountsUTF8Bytes(t *testing.T) {
	f := newAdmissionFixture(t)
	in := f.openInput()
	in.Path = strings.Repeat("界", MaxPathBytes/3+1)
	result, err := f.service.Read(f.ctx, f.actor, in)
	var fault *model.Fault
	if result != nil || !errors.As(err, &fault) || fault.Code != "resource_conflict" || strings.Contains(err.Error(), in.Path) {
		t.Fatalf("oversized path: %#v %v", result, err)
	}

	in.Path = strings.Repeat("a/", 2047) + "ab"
	sourceMissing := &model.Fault{Code: "not_found", Message: "Attachment not found.", Cause: model.ErrNotFound}
	f.expect(
		missingAdmissionRecord(in.TransferID),
		admissionStep{name: "source", source: in, cause: sourceMissing},
		committedAdmissionScope(f.authorize(in)),
		missingAdmissionRecord(in.TransferID),
	)
	result, err = f.service.Read(f.ctx, f.actor, in)
	if result != nil || !errors.Is(err, sourceMissing) {
		t.Fatalf("boundary did not reach attachment precheck: %#v %v", result, err)
	}
}
